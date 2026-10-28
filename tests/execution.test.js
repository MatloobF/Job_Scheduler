import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { StaleLeaseError } from '../src/api/errors.js';
import { config } from '../src/config.js';
import { closePool, pool, withTransaction } from '../src/db/pool.js';
import { claimNextJob, completeJob, failJob } from '../src/jobs/repository.js';
import { seed } from '../src/db/seed.js';
import { backoffDelayMs } from '../src/jobs/retryPolicy.js';
import { generateReport } from '../src/worker/handlers/generateReport.js';
import { sendNotification } from '../src/worker/handlers/sendNotification.js';
import { processNextJob } from '../src/worker/worker.js';
import {
  createTestJob,
  expireLease,
  makeDue,
  truncateAll,
  waitForBlockedQuery,
} from './helpers.js';

async function jobRow(id) {
  const { rows } = await pool.query('SELECT * FROM jobs WHERE id = $1', [id]);
  return rows[0];
}

async function attemptRows(jobId) {
  const { rows } = await pool.query(
    'SELECT * FROM job_attempts WHERE job_id = $1 ORDER BY attempt_no',
    [jobId],
  );
  return rows;
}

// Gap between the new scheduled_at and the DB time of the failure, in ms.
// Both come from now() in the same transaction, so the gap is exact.
async function scheduledDelayMs(id) {
  const { rows } = await pool.query(
    `SELECT (EXTRACT(EPOCH FROM scheduled_at - updated_at) * 1000)::int AS delay
     FROM jobs WHERE id = $1`,
    [id],
  );
  return rows[0].delay;
}

// Claims the job and fails the attempt, then makes it due again for the next claim.
async function claimAndFail(jobId, message) {
  const claimed = await claimNextJob('worker-a');
  expect(claimed.id).toBe(jobId);
  const after = await failJob(jobId, claimed.lease_id, message);
  return after;
}

beforeEach(truncateAll);
afterAll(closePool);

const notificationPayload = { recipient: 'a@example.com', message: 'hello' };

// Runs a handler for an already-claimed job in its own transaction, as a repeat would.
function runHandler(handler, job) {
  return withTransaction((client) => handler(client, job));
}

async function count(table) {
  const { rows } = await pool.query(`SELECT count(*)::int AS n FROM ${table}`);
  return rows[0].n;
}

describe('execution', () => {
  it('records a notification for SEND_NOTIFICATION', async () => {
    const job = await createTestJob({ type: 'SEND_NOTIFICATION', payload: notificationPayload });

    expect(await processNextJob('worker-a')).toEqual({ jobId: job.id, outcome: 'succeeded' });

    const { rows } = await pool.query('SELECT * FROM notifications');
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ job_id: job.id, recipient: 'a@example.com', message: 'hello' });
    expect(await jobRow(job.id)).toMatchObject({
      status: 'SUCCEEDED',
      result: { recipient: 'a@example.com', delivered: true, duplicate: false },
    });
  });

  it('persists a sales summary for GENERATE_REPORT', async () => {
    await seed();
    const job = await createTestJob({ type: 'GENERATE_REPORT', payload: {} });

    expect((await processNextJob('worker-a')).outcome).toBe('succeeded');

    const { rows } = await pool.query('SELECT * FROM reports WHERE job_id = $1', [job.id]);
    expect(rows[0]).toMatchObject({
      row_count: 4,
      total_amount: '35',
      totals_by_category: { widgets: 25, gadgets: 10 },
    });
    expect((await jobRow(job.id)).result).toEqual({
      rowCount: 4,
      totalAmount: '35',
      totalsByCategory: { widgets: 25, gadgets: 10 },
    });
  });

  it('reports zeros, not nulls, when there are no sales', async () => {
    const job = await createTestJob({ type: 'GENERATE_REPORT', payload: {} });

    await processNextJob('worker-a');

    expect((await jobRow(job.id)).result).toEqual({
      rowCount: 0,
      totalAmount: '0',
      totalsByCategory: {},
    });
  });

  it('marks the job SUCCEEDED and stores the result', async () => {
    const job = await createTestJob();
    const claimed = await claimNextJob('worker-a');

    await completeJob(job.id, claimed.lease_id, { rows: 4 });

    expect(await jobRow(job.id)).toMatchObject({
      status: 'SUCCEEDED',
      result: { rows: 4 },
      lease_id: null,
      worker_id: null,
      lease_expires_at: null,
    });
    const [attempt] = await attemptRows(job.id);
    expect(attempt.outcome).toBe('SUCCEEDED');
    expect(attempt.finished_at).not.toBeNull();
  });

  it('stores a JSON array result as JSON, not a Postgres array', async () => {
    const job = await createTestJob();
    const claimed = await claimNextJob('worker-a');

    await completeJob(job.id, claimed.lease_id, [1, 2, 3]);

    expect((await jobRow(job.id)).result).toEqual([1, 2, 3]);
  });

  it('stores a missing result as JSON null', async () => {
    const job = await createTestJob();
    const claimed = await claimNextJob('worker-a');

    await completeJob(job.id, claimed.lease_id, undefined);

    expect(await jobRow(job.id)).toMatchObject({ status: 'SUCCEEDED', result: null });
  });

  it('completes an expired lease that nobody has reaped or reclaimed', async () => {
    const job = await createTestJob();
    const claimed = await claimNextJob('worker-a');
    await expireLease(job.id);

    await completeJob(job.id, claimed.lease_id, { late: true });

    expect((await jobRow(job.id)).status).toBe('SUCCEEDED');
  });
});

describe('retries', () => {
  it('requeues a failed job while attempts < 1 + maxRetries', async () => {
    const job = await createTestJob({ maxRetries: 2 });

    const first = await claimAndFail(job.id, 'fail 1');
    expect(first).toMatchObject({ status: 'QUEUED', attempts: 1, lease_id: null, worker_id: null });

    await makeDue(job.id);
    const second = await claimAndFail(job.id, 'fail 2');
    expect(second).toMatchObject({ status: 'QUEUED', attempts: 2 });

    await makeDue(job.id);
    const third = await claimAndFail(job.id, 'fail 3');
    expect(third).toMatchObject({ status: 'FAILED', attempts: 3, lease_id: null });

    // A permanently failed job is never claimed again.
    await makeDue(job.id);
    expect(await claimNextJob('worker-a')).toBeNull();
  });

  it('sets scheduled_at from the backoff delay', async () => {
    const job = await createTestJob({ maxRetries: 3 });
    const { backoffBaseMs: base, backoffCapMs: cap } = config;

    await claimAndFail(job.id, 'fail 1');
    expect(await scheduledDelayMs(job.id)).toBe(backoffDelayMs(1, base, cap));

    // The requeued job is not claimable until its backoff has elapsed.
    expect(await claimNextJob('worker-a')).toBeNull();

    await makeDue(job.id);
    await claimAndFail(job.id, 'fail 2');
    expect(await scheduledDelayMs(job.id)).toBe(backoffDelayMs(2, base, cap));
  });

  it('caps the backoff delay once doubling passes the cap', async () => {
    const { backoffBaseMs: base, backoffCapMs: cap } = config;
    // Enough failures for base * 2^(n-1) to pass the cap, plus one more at the cap.
    let failures = 1;
    while (base * 2 ** (failures - 1) < cap) failures += 1;
    failures += 1;
    const job = await createTestJob({ maxRetries: failures });

    const delays = [];
    for (let attempt = 1; attempt <= failures; attempt += 1) {
      await claimAndFail(job.id, `fail ${attempt}`);
      delays.push(await scheduledDelayMs(job.id));
      await makeDue(job.id);
    }

    expect(delays).toEqual(delays.map((_, i) => backoffDelayMs(i + 1, base, cap)));
    expect(delays.slice(-2)).toEqual([cap, cap]);
    expect(delays[0]).toBe(base);
  });

  it('permanently fails when maxRetries is 0 and the first attempt fails', async () => {
    const job = await createTestJob({ maxRetries: 0 });
    const before = await jobRow(job.id);

    const after = await claimAndFail(job.id, 'only attempt failed');

    expect(after).toMatchObject({ status: 'FAILED', attempts: 1, last_error: 'only attempt failed' });
    // No backoff is applied to a permanent failure.
    expect(after.scheduled_at).toEqual(before.scheduled_at);
  });

  it('stores the latest error and an attempt history row', async () => {
    const job = await createTestJob({ maxRetries: 1 });

    await claimAndFail(job.id, 'first error');
    await makeDue(job.id);
    await claimAndFail(job.id, 'second error');

    expect((await jobRow(job.id)).last_error).toBe('second error');
    const attempts = await attemptRows(job.id);
    expect(attempts.map(({ attempt_no, outcome, error }) => ({ attempt_no, outcome, error }))).toEqual([
      { attempt_no: 1, outcome: 'FAILED', error: 'first error' },
      { attempt_no: 2, outcome: 'FAILED', error: 'second error' },
    ]);
    expect(new Set(attempts.map((a) => a.lease_id)).size).toBe(2);
    expect(attempts.every((a) => a.finished_at !== null)).toBe(true);
  });
});

describe('idempotency', () => {
  it('does not insert a second notification when the same job runs again', async () => {
    const created = await createTestJob({
      type: 'SEND_NOTIFICATION',
      payload: notificationPayload,
    });
    const job = await claimNextJob('worker-a');
    expect(job.id).toBe(created.id);

    const first = await runHandler(sendNotification, job);
    const second = await runHandler(sendNotification, job);

    expect(first.duplicate).toBe(false);
    expect(second.duplicate).toBe(true);
    expect(await count('notifications')).toBe(1);
  });

  it('does not insert a second report when the same job runs again', async () => {
    await seed();
    await createTestJob({ type: 'GENERATE_REPORT', payload: {} });
    const job = await claimNextJob('worker-a');

    await runHandler(generateReport, job);
    await pool.query(`INSERT INTO sales (category, amount) VALUES ('gizmos', 5)`);
    const rerun = await runHandler(generateReport, job);

    expect(await count('reports')).toBe(1);
    // The repeat refreshed the existing row rather than adding one.
    expect(rerun).toMatchObject({ rowCount: 5, totalAmount: '40' });
    const { rows } = await pool.query('SELECT total_amount FROM reports WHERE job_id = $1', [job.id]);
    expect(rows[0].total_amount).toBe('40');
  });

  it('keeps one notification when two attempts insert it at the same time', async () => {
    await createTestJob({ type: 'SEND_NOTIFICATION', payload: notificationPayload });
    const job = await claimNextJob('worker-a');

    const first = await pool.connect();
    try {
      await first.query('BEGIN');
      await sendNotification(first, job);

      // The second insert targets the same job_id and must wait for the first to finish.
      const second = runHandler(sendNotification, job);
      await waitForBlockedQuery('%INSERT INTO notifications%');
      await first.query('COMMIT');

      expect((await second).duplicate).toBe(true);
    } finally {
      first.release();
    }
    expect(await count('notifications')).toBe(1);
  });

  it('lets the waiting attempt write the notification if the first one rolls back', async () => {
    await createTestJob({ type: 'SEND_NOTIFICATION', payload: notificationPayload });
    const job = await claimNextJob('worker-a');

    const first = await pool.connect();
    try {
      await first.query('BEGIN');
      await sendNotification(first, job);

      const second = runHandler(sendNotification, job);
      await waitForBlockedQuery('%INSERT INTO notifications%');
      // e.g. the first attempt's fenced complete failed as stale.
      await first.query('ROLLBACK');

      expect((await second).duplicate).toBe(false);
    } finally {
      first.release();
    }
    expect(await count('notifications')).toBe(1);
  });

  it('a stale worker cannot mark a newer attempt successful', async () => {
    const job = await createTestJob();
    const stale = await claimNextJob('worker-old');
    await failJob(job.id, stale.lease_id, 'presumed dead');
    await makeDue(job.id);
    const current = await claimNextJob('worker-new');

    await expect(completeJob(job.id, stale.lease_id, { from: 'stale' })).rejects.toBeInstanceOf(
      StaleLeaseError,
    );

    expect(await jobRow(job.id)).toMatchObject({
      status: 'RUNNING',
      lease_id: current.lease_id,
      result: null,
    });
    const attempts = await attemptRows(job.id);
    expect(attempts.map((a) => a.outcome)).toEqual(['FAILED', 'RUNNING']);
  });

  it("rolls back a stale worker's side effect written in the same transaction", async () => {
    const job = await createTestJob({
      type: 'SEND_NOTIFICATION',
      payload: { recipient: 'a@example.com', message: 'hi' },
    });
    const stale = await claimNextJob('worker-old');
    await failJob(job.id, stale.lease_id, 'presumed dead');
    await makeDue(job.id);
    await claimNextJob('worker-new');

    const staleRun = withTransaction(async (client) => {
      await client.query(
        `INSERT INTO notifications (job_id, recipient, message) VALUES ($1, $2, $3)`,
        [job.id, 'a@example.com', 'hi'],
      );
      await completeJob(job.id, stale.lease_id, { sent: true }, client);
    });

    await expect(staleRun).rejects.toBeInstanceOf(StaleLeaseError);
    const { rows } = await pool.query('SELECT count(*)::int AS n FROM notifications');
    expect(rows[0].n).toBe(0);
  });
});
