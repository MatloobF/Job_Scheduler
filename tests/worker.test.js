import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { config } from '../src/config.js';
import { closePool, pool } from '../src/db/pool.js';
import { seed } from '../src/db/seed.js';
import { claimNextJob, reapExpiredLeases } from '../src/jobs/repository.js';
import { SimulatedCrashError } from '../src/worker/simulation.js';
import { processNextJob, runWorker, stop } from '../src/worker/worker.js';
import { createTestJob, expireLease, makeDue, truncateAll } from './helpers.js';

const notificationPayload = { recipient: 'a@example.com', message: 'hello' };

async function jobRow(id) {
  const { rows } = await pool.query('SELECT * FROM jobs WHERE id = $1', [id]);
  return rows[0];
}

async function count(table) {
  const { rows } = await pool.query(`SELECT count(*)::int AS n FROM ${table}`);
  return rows[0].n;
}

async function attemptOutcomes(jobId) {
  const { rows } = await pool.query(
    'SELECT outcome FROM job_attempts WHERE job_id = $1 ORDER BY attempt_no',
    [jobId],
  );
  return rows.map((row) => row.outcome);
}

// Holds an exclusive lock on sales so a GENERATE_REPORT handler blocks mid-run,
// letting a test change the world while the worker is "busy". No sleeps involved.
async function holdSalesLock() {
  const holder = await pool.connect();
  await holder.query('BEGIN');
  await holder.query('LOCK TABLE sales IN ACCESS EXCLUSIVE MODE');
  return async () => {
    await holder.query('ROLLBACK');
    holder.release();
  };
}

// Waits until the handler is actually blocked on the sales lock (observed in Postgres).
async function waitUntilHandlerBlocked() {
  await vi.waitFor(
    async () => {
      const { rows } = await pool.query(
        `SELECT count(*)::int AS n FROM pg_stat_activity
         WHERE datname = current_database() AND wait_event_type = 'Lock'
           AND query LIKE '%FROM sales%'`,
      );
      expect(rows[0].n).toBe(1);
    },
    { timeout: 5000, interval: 20 },
  );
}

// Drains the queue the way a worker loop would, until nothing is eligible.
async function drain(workerId) {
  const outcomes = [];
  for (;;) {
    const { outcome } = await processNextJob(workerId);
    if (outcome === 'idle') return outcomes;
    outcomes.push(outcome);
  }
}

beforeEach(async () => {
  await truncateAll();
  await seed();
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});
afterAll(closePool);

describe('worker failure handling', () => {
  it('records a handler failure and requeues the job with no side effect', async () => {
    const job = await createTestJob({
      type: 'SEND_NOTIFICATION',
      payload: { ...notificationPayload, simulateFailure: true },
      maxRetries: 1,
    });

    expect((await processNextJob('worker-a')).outcome).toBe('failed');

    expect(await jobRow(job.id)).toMatchObject({
      status: 'QUEUED',
      attempts: 1,
      last_error: 'simulated failure',
    });
    expect(await count('notifications')).toBe(0);
  });

  it('leaves a crashed attempt RUNNING with its side effect rolled back, for the reaper', async () => {
    const job = await createTestJob({
      type: 'SEND_NOTIFICATION',
      payload: { ...notificationPayload, simulateCrashAfterWork: true },
      maxRetries: 1,
    });

    await expect(processNextJob('worker-a')).rejects.toBeInstanceOf(SimulatedCrashError);

    // Crash after the insert but before commit: nothing was persisted.
    expect(await count('notifications')).toBe(0);
    expect(await jobRow(job.id)).toMatchObject({ status: 'RUNNING', attempts: 1 });
    expect(await attemptOutcomes(job.id)).toEqual(['RUNNING']);

    // The reaper recovers it; the flag makes every attempt crash, so it ends FAILED.
    await expireLease(job.id);
    await reapExpiredLeases();
    expect((await jobRow(job.id)).status).toBe('QUEUED');

    await makeDue(job.id);
    await expect(processNextJob('worker-b')).rejects.toBeInstanceOf(SimulatedCrashError);
    await expireLease(job.id);
    await reapExpiredLeases();

    expect(await jobRow(job.id)).toMatchObject({ status: 'FAILED', attempts: 2 });
    expect(await attemptOutcomes(job.id)).toEqual(['LEASE_EXPIRED', 'LEASE_EXPIRED']);
  });

  it('discards the result of a run whose job was reaped and reclaimed mid-execution', async () => {
    const job = await createTestJob({ type: 'GENERATE_REPORT', payload: {} });
    const release = await holdSalesLock();

    let staleRun;
    let current;
    try {
      staleRun = processNextJob('worker-slow');
      await waitUntilHandlerBlocked();

      // While the slow worker is blocked: its lease expires, is reaped, and reclaimed.
      await expireLease(job.id);
      await reapExpiredLeases();
      await makeDue(job.id);
      current = await claimNextJob('worker-new');
    } finally {
      await release();
    }

    expect((await staleRun).outcome).toBe('stale');
    expect(await count('reports')).toBe(0);
    expect(await jobRow(job.id)).toMatchObject({
      status: 'RUNNING',
      lease_id: current.lease_id,
      worker_id: 'worker-new',
      result: null,
    });
    expect(await attemptOutcomes(job.id)).toEqual(['LEASE_EXPIRED', 'RUNNING']);
  });

  it('records nothing when lease renewal fails during execution', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const job = await createTestJob({ type: 'GENERATE_REPORT', payload: {} });
    const release = await holdSalesLock();

    let run;
    try {
      run = processNextJob('worker-a');
      await waitUntilHandlerBlocked();

      // The lease lapses (e.g. a long GC pause) but nobody has reaped it yet.
      await expireLease(job.id);
      await vi.advanceTimersByTimeAsync(Math.floor(config.leaseDurationMs / 3));
      await vi.waitFor(() => expect(warn).toHaveBeenCalled(), { timeout: 5000 });
    } finally {
      await release();
    }

    // completeJob alone would accept this unreaped lease; the worker must not.
    expect((await run).outcome).toBe('stale');
    expect(await count('reports')).toBe(0);
    expect(await jobRow(job.id)).toMatchObject({ status: 'RUNNING', result: null });
  });
});

describe('worker loop', () => {
  it('runs every job exactly once across two concurrent workers', async () => {
    const ids = [];
    for (let i = 0; i < 5; i += 1) {
      const job = await createTestJob({
        type: 'SEND_NOTIFICATION',
        payload: { recipient: `user${i}@example.com`, message: 'hi' },
      });
      ids.push(job.id);
    }

    const [a, b] = await Promise.all([drain('worker-a'), drain('worker-b')]);

    expect(a.length + b.length).toBe(5);
    expect(await count('notifications')).toBe(5);
    const { rows } = await pool.query(
      `SELECT count(*)::int AS n FROM job_attempts WHERE outcome = 'SUCCEEDED'`,
    );
    expect(rows[0].n).toBe(5);
    for (const id of ids) expect((await jobRow(id)).status).toBe('SUCCEEDED');
  });

  it('finishes the current job and claims no more after stop()', async () => {
    const first = await createTestJob({ priority: 10 });
    const second = await createTestJob({ priority: 1 });

    const loop = runWorker('worker-a');
    stop();
    await loop;

    expect((await jobRow(first.id)).status).toBe('SUCCEEDED');
    expect((await jobRow(second.id)).status).toBe('QUEUED');
  });

  it('wakes from an idle poll when stopped', async () => {
    // Longer than the test timeout, so only an early wake-up can pass this test.
    const pollIntervalMs = config.pollIntervalMs;
    config.pollIntervalMs = 60_000;
    const setTimeoutSpy = vi.spyOn(globalThis, 'setTimeout');
    try {
      const loop = runWorker('worker-a');
      // The empty claim has finished and the loop is parked in its poll wait.
      await vi.waitFor(
        () => expect(setTimeoutSpy).toHaveBeenCalledWith(expect.any(Function), 60_000),
        { timeout: 5000 },
      );
      stop();

      await expect(loop).resolves.toBeUndefined();
    } finally {
      config.pollIntervalMs = pollIntervalMs;
    }
  });
});
