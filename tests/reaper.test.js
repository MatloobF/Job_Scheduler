import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { StaleLeaseError } from '../src/api/errors.js';
import { config } from '../src/config.js';
import { closePool, pool } from '../src/db/pool.js';
import {
  claimNextJob,
  completeJob,
  failJob,
  reapExpiredLeases,
  renewLease,
} from '../src/jobs/repository.js';
import { backoffDelayMs } from '../src/jobs/retryPolicy.js';
import { createTestJob, expireLease, makeDue, truncateAll } from './helpers.js';

async function jobRow(id) {
  const { rows } = await pool.query('SELECT * FROM jobs WHERE id = $1', [id]);
  return rows[0];
}

async function attemptOutcomes(jobId) {
  const { rows } = await pool.query(
    'SELECT outcome FROM job_attempts WHERE job_id = $1 ORDER BY attempt_no',
    [jobId],
  );
  return rows.map((row) => row.outcome);
}

// Creates n jobs, claims them all, and expires every lease.
async function expiredJobs(n) {
  const ids = [];
  for (let i = 0; i < n; i += 1) {
    const job = await createTestJob();
    await claimNextJob(`worker-${i}`);
    await expireLease(job.id);
    ids.push(job.id);
  }
  return ids;
}

beforeEach(truncateAll);
afterAll(closePool);

describe('lease reaper', () => {
  it('requeues a job whose lease has expired and still has retries', async () => {
    const job = await createTestJob({ maxRetries: 2 });
    const claimed = await claimNextJob('worker-crashed');
    await expireLease(job.id);

    const reaped = await reapExpiredLeases();

    expect(reaped.map((row) => row.id)).toEqual([job.id]);
    const row = await jobRow(job.id);
    expect(row).toMatchObject({ status: 'QUEUED', attempts: 1, lease_id: null, worker_id: null });
    expect(row.last_error).toBe('lease expired (worker worker-crashed)');
    expect(await attemptOutcomes(job.id)).toEqual(['LEASE_EXPIRED']);

    const { rows } = await pool.query(
      `SELECT (EXTRACT(EPOCH FROM scheduled_at - updated_at) * 1000)::int AS delay
       FROM jobs WHERE id = $1`,
      [job.id],
    );
    expect(rows[0].delay).toBe(backoffDelayMs(1, config.backoffBaseMs, config.backoffCapMs));

    // Claimable again once the backoff has passed, under a fresh lease.
    await makeDue(job.id);
    const reclaimed = await claimNextJob('worker-healthy');
    expect(reclaimed).toMatchObject({ id: job.id, attempts: 2 });
    expect(reclaimed.lease_id).not.toBe(claimed.lease_id);
  });

  it('permanently fails an expired lease when retries are exhausted', async () => {
    const job = await createTestJob({ maxRetries: 0 });
    await claimNextJob('worker-crashed');
    await expireLease(job.id);

    await reapExpiredLeases();

    expect(await jobRow(job.id)).toMatchObject({ status: 'FAILED', attempts: 1, lease_id: null });
    expect(await attemptOutcomes(job.id)).toEqual(['LEASE_EXPIRED']);
  });

  it('counts an expired lease toward the same retry limit as a failure', async () => {
    const job = await createTestJob({ maxRetries: 1 });
    const first = await claimNextJob('worker-a');
    await failJob(job.id, first.lease_id, 'handler error');
    await makeDue(job.id);
    await claimNextJob('worker-b');
    await expireLease(job.id);

    await reapExpiredLeases();

    expect(await jobRow(job.id)).toMatchObject({ status: 'FAILED', attempts: 2 });
    expect(await attemptOutcomes(job.id)).toEqual(['FAILED', 'LEASE_EXPIRED']);
  });

  it('does not leave the job RUNNING after the reaper runs', async () => {
    const expiredIds = await expiredJobs(3);
    const live = await createTestJob();
    const liveClaim = await claimNextJob('worker-live');
    const queued = await createTestJob();

    await reapExpiredLeases();

    const { rows } = await pool.query(
      `SELECT id FROM jobs WHERE status = 'RUNNING' AND lease_expires_at <= now()`,
    );
    expect(rows).toEqual([]);
    for (const id of expiredIds) expect((await jobRow(id)).status).toBe('QUEUED');
    // A live lease and a job that was never claimed are left alone.
    expect(await jobRow(live.id)).toMatchObject({ status: 'RUNNING', lease_id: liveClaim.lease_id });
    expect(await jobRow(queued.id)).toMatchObject({ status: 'QUEUED', attempts: 0 });
  });

  it('fences off a slow worker whose lease was reaped', async () => {
    const job = await createTestJob();
    const claimed = await claimNextJob('worker-slow');
    await expireLease(job.id);
    await reapExpiredLeases();

    await expect(renewLease(job.id, claimed.lease_id)).rejects.toBeInstanceOf(StaleLeaseError);
    await expect(completeJob(job.id, claimed.lease_id, {})).rejects.toBeInstanceOf(
      StaleLeaseError,
    );
    await expect(failJob(job.id, claimed.lease_id, 'late')).rejects.toBeInstanceOf(
      StaleLeaseError,
    );
    expect((await jobRow(job.id)).status).toBe('QUEUED');
  });

  it('skips a row a worker has locked and reaps it on the next pass', async () => {
    const [lockedId, freeId] = await expiredJobs(2);

    const holder = await pool.connect();
    try {
      await holder.query('BEGIN');
      await holder.query('SELECT id FROM jobs WHERE id = $1 FOR UPDATE', [lockedId]);

      // Without SKIP LOCKED the reaper would block on the held row; fail instead of hanging.
      let watchdog;
      const blocked = new Promise((resolve) => {
        watchdog = setTimeout(() => resolve('blocked'), 2000);
      });
      const reaped = await Promise.race([reapExpiredLeases(), blocked]);
      clearTimeout(watchdog);

      expect(reaped).not.toBe('blocked');
      expect(reaped.map((row) => row.id)).toEqual([freeId]);
    } finally {
      await holder.query('ROLLBACK');
      holder.release();
    }

    const nextPass = await reapExpiredLeases();
    expect(nextPass.map((row) => row.id)).toEqual([lockedId]);
  });

  it('never reaps a job twice when reapers run concurrently', async () => {
    const ids = await expiredJobs(10);

    const passes = await Promise.all([
      reapExpiredLeases(3),
      reapExpiredLeases(3),
      reapExpiredLeases(3),
    ]);

    const reapedIds = passes.flat().map((row) => row.id);
    expect(reapedIds).toHaveLength(10);
    expect(new Set(reapedIds)).toEqual(new Set(ids));
    const { rows } = await pool.query(
      `SELECT count(*)::int AS n FROM job_attempts WHERE outcome = 'LEASE_EXPIRED'`,
    );
    expect(rows[0].n).toBe(10);
  });

  it('drains more expired jobs than one batch in a single call', async () => {
    const ids = await expiredJobs(7);

    const reaped = await reapExpiredLeases(3);

    expect(new Set(reaped.map((row) => row.id))).toEqual(new Set(ids));
  });

  it('returns nothing when no lease has expired', async () => {
    await createTestJob();
    await claimNextJob('worker-a');

    expect(await reapExpiredLeases()).toEqual([]);
  });
});
