import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { StaleLeaseError } from '../src/api/errors.js';
import { config } from '../src/config.js';
import { closePool, pool, withTransaction } from '../src/db/pool.js';
import { claimNextJob, completeJob, failJob } from '../src/jobs/repository.js';
import { backoffDelayMs } from '../src/jobs/retryPolicy.js';
import { createTestJob, expireLease, makeDue, truncateAll } from './helpers.js';

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

describe('execution', () => {
  it.todo('records a notification for SEND_NOTIFICATION');
  it.todo('persists a sales summary for GENERATE_REPORT');

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
  it.todo('does not insert a second notification when the same job runs again');
  it.todo('does not insert a second report when the same job runs again');

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
