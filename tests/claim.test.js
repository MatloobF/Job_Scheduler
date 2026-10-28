import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { closePool, pool } from '../src/db/pool.js';
import { StaleLeaseError } from '../src/api/errors.js';
import { claimNextJob, completeJob, failJob, renewLease } from '../src/jobs/repository.js';
import {
  createTestJob as createJob,
  expireLease,
  makeDue,
  scheduleAt,
  truncateAll,
} from './helpers.js';

// Claims, fails (requeue), and reclaims a job so the first lease is stale.
async function claimTwice() {
  const job = await createJob();
  const first = await claimNextJob('worker-old');
  await failJob(job.id, first.lease_id, 'first attempt failed');
  await makeDue(job.id);
  const second = await claimNextJob('worker-new');
  return { job, oldLease: first.lease_id, current: second };
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
    await failJob(job.id, first.lease_id, 'boom');
    await makeDue(job.id);
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
  it('renews a live lease from the DB clock', async () => {
    const job = await createJob();
    const claimed = await claimNextJob('worker-a', 1000);

    const renewed = await renewLease(job.id, claimed.lease_id, 30_000);

    expect(renewed.lease_id).toBe(claimed.lease_id);
    const { rows } = await pool.query(
      `SELECT lease_expires_at - updated_at AS duration FROM jobs WHERE id = $1`,
      [job.id],
    );
    expect(rows[0].duration).toEqual({ seconds: 30 });
  });

  it('refuses to revive an expired lease', async () => {
    const job = await createJob();
    const claimed = await claimNextJob('worker-a');
    await expireLease(job.id);

    await expect(renewLease(job.id, claimed.lease_id)).rejects.toBeInstanceOf(StaleLeaseError);

    const { rows } = await pool.query(
      'SELECT lease_expires_at < now() AS expired FROM jobs WHERE id = $1',
      [job.id],
    );
    expect(rows[0].expired).toBe(true);
  });

  it('rejects renew, complete, and fail after the lease id changes', async () => {
    const { job, oldLease, current } = await claimTwice();

    await expect(renewLease(job.id, oldLease)).rejects.toBeInstanceOf(StaleLeaseError);
    await expect(completeJob(job.id, oldLease, { stale: true })).rejects.toBeInstanceOf(
      StaleLeaseError,
    );
    await expect(failJob(job.id, oldLease, 'stale failure')).rejects.toBeInstanceOf(
      StaleLeaseError,
    );

    // The current attempt is untouched by any of the stale writes.
    const { rows } = await pool.query('SELECT * FROM jobs WHERE id = $1', [job.id]);
    expect(rows[0]).toMatchObject({
      status: 'RUNNING',
      lease_id: current.lease_id,
      attempts: 2,
      result: null,
      last_error: 'first attempt failed',
    });
  });

  it('rejects every write once the job has left RUNNING', async () => {
    const job = await createJob();
    const claimed = await claimNextJob('worker-a');
    await completeJob(job.id, claimed.lease_id, { ok: true });

    await expect(renewLease(job.id, claimed.lease_id)).rejects.toBeInstanceOf(StaleLeaseError);
    await expect(completeJob(job.id, claimed.lease_id, {})).rejects.toBeInstanceOf(
      StaleLeaseError,
    );
    await expect(failJob(job.id, claimed.lease_id, 'late')).rejects.toBeInstanceOf(
      StaleLeaseError,
    );
  });
  // Lease-expiry recovery is covered in tests/reaper.test.js.
});
