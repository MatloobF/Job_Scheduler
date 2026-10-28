import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { closePool, pool } from '../src/db/pool.js';
import { claimNextJob, insertJob } from '../src/jobs/repository.js';
import { truncateAll } from './helpers.js';

function createJob(overrides = {}) {
  return insertJob({
    type: 'GENERATE_REPORT',
    payload: {},
    priority: 0,
    maxRetries: 3,
    ...overrides,
  });
}

// Moves scheduled_at relative to the DB clock, so tests never depend on the app clock.
async function scheduleAt(jobId, offset) {
  await pool.query(`UPDATE jobs SET scheduled_at = now() + $2::interval WHERE id = $1`, [
    jobId,
    offset,
  ]);
}

beforeEach(truncateAll);
afterAll(closePool);

describe('atomic claim', () => {
  it('lets only one of two concurrent workers claim a single job', async () => {
    const job = await createJob();

    const results = await Promise.all([claimNextJob('worker-a'), claimNextJob('worker-b')]);

    const winners = results.filter(Boolean);
    expect(winners).toHaveLength(1);
    expect(winners[0].id).toBe(job.id);
    const { rows } = await pool.query('SELECT count(*)::int AS n FROM job_attempts');
    expect(rows[0].n).toBe(1);
  });

  it('gives each of many concurrent claimers a different job', async () => {
    for (let i = 0; i < 10; i += 1) await createJob();

    const results = await Promise.all(
      Array.from({ length: 20 }, (_, i) => claimNextJob(`worker-${i}`)),
    );

    const claimedIds = results.filter(Boolean).map((job) => job.id);
    expect(claimedIds).toHaveLength(10);
    expect(new Set(claimedIds).size).toBe(10);
    expect(results.filter((job) => job === null)).toHaveLength(10);
  });

  it('skips a row locked by another transaction instead of waiting for it', async () => {
    const locked = await createJob({ priority: 10 });
    const free = await createJob({ priority: 1 });

    const holder = await pool.connect();
    try {
      await holder.query('BEGIN');
      await holder.query('SELECT id FROM jobs WHERE id = $1 FOR UPDATE', [locked.id]);

      // Without SKIP LOCKED the claim blocks on the held row, and the holder can only
      // release it after the claim returns. The watchdog turns that hang into a failure.
      let watchdog;
      const blocked = new Promise((resolve) => {
        watchdog = setTimeout(() => resolve('blocked'), 2000);
      });
      const claimed = await Promise.race([claimNextJob('worker-a'), blocked]);
      clearTimeout(watchdog);
      expect(claimed).not.toBe('blocked');
      expect(claimed.id).toBe(free.id);
      expect(await claimNextJob('worker-b')).toBeNull();
    } finally {
      await holder.query('ROLLBACK');
      holder.release();
    }

    const afterRelease = await claimNextJob('worker-c');
    expect(afterRelease.id).toBe(locked.id);
  });

  it('gives each claim a distinct lease id and increments attempts', async () => {
    const job = await createJob();

    const first = await claimNextJob('worker-a');
    // Stand-in for a requeue until failJob and the reaper exist.
    await pool.query(`UPDATE jobs SET status = 'QUEUED' WHERE id = $1`, [job.id]);
    const second = await claimNextJob('worker-b');

    expect(first).toMatchObject({ id: job.id, attempts: 1, worker_id: 'worker-a', status: 'RUNNING' });
    expect(second).toMatchObject({ id: job.id, attempts: 2, worker_id: 'worker-b', status: 'RUNNING' });
    expect(first.lease_id).toBeTruthy();
    expect(second.lease_id).not.toBe(first.lease_id);
  });

  it('opens a RUNNING attempt row and sets the lease expiry from the DB clock', async () => {
    const job = await createJob();

    const claimed = await claimNextJob('worker-a', 30_000);

    const attempts = await pool.query('SELECT * FROM job_attempts WHERE job_id = $1', [job.id]);
    expect(attempts.rows).toHaveLength(1);
    expect(attempts.rows[0]).toMatchObject({
      attempt_no: 1,
      lease_id: claimed.lease_id,
      worker_id: 'worker-a',
      outcome: 'RUNNING',
      finished_at: null,
    });

    const lease = await pool.query(
      `SELECT lease_expires_at - updated_at AS duration FROM jobs WHERE id = $1`,
      [job.id],
    );
    expect(lease.rows[0].duration).toEqual({ seconds: 30 });
  });

  it('claims a higher priority job before a lower priority due job', async () => {
    const low = await createJob({ priority: 1 });
    const high = await createJob({ priority: 9 });
    await scheduleAt(high.id, '-1 second');
    await scheduleAt(low.id, '-1 hour');

    expect((await claimNextJob('worker-a')).id).toBe(high.id);
    expect((await claimNextJob('worker-a')).id).toBe(low.id);
  });

  it('claims the earlier scheduled job first when priorities are equal', async () => {
    const later = await createJob();
    const earlier = await createJob();
    await scheduleAt(later.id, '-1 minute');
    await scheduleAt(earlier.id, '-1 hour');

    expect((await claimNextJob('worker-a')).id).toBe(earlier.id);
  });

  it('does not claim a job whose scheduled_at is in the future', async () => {
    const job = await createJob({ priority: 100 });
    await scheduleAt(job.id, '1 hour');

    expect(await claimNextJob('worker-a')).toBeNull();

    await scheduleAt(job.id, '-1 second');
    expect((await claimNextJob('worker-a')).id).toBe(job.id);
  });

  it('never claims RUNNING, SUCCEEDED, FAILED, or CANCELLED jobs', async () => {
    for (const status of ['RUNNING', 'SUCCEEDED', 'FAILED', 'CANCELLED']) {
      const job = await createJob();
      await pool.query('UPDATE jobs SET status = $2 WHERE id = $1', [job.id, status]);
    }

    expect(await claimNextJob('worker-a')).toBeNull();
  });
});

describe('leases and stale workers', () => {
  it.todo('renews a live lease');
  it.todo('rejects renew, complete, and fail after the lease id changes');
  it.todo('requeues a job whose lease has expired and still has retries');
  it.todo('permanently fails an expired lease when retries are exhausted');
  it.todo('does not leave the job RUNNING after the reaper runs');
});
