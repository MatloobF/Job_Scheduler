import { notImplemented, StaleLeaseError } from '../api/errors.js';
import { config } from '../config.js';
import { pool, withTransaction } from '../db/pool.js';
import { backoffDelayMs, shouldRetry } from './retryPolicy.js';

// Every jobs.status change lives here. Routes and the worker call these functions.
// Multi-statement changes use withTransaction from src/db/pool.js.
// Claim, renew, complete, fail, and reap must follow the invariants in CLAUDE.md.

const LIST_LIMIT = 100;

// A missing scheduledAt defaults to the DB's now(), never the app clock.
export async function insertJob({ type, payload, priority, scheduledAt, maxRetries }) {
  const { rows } = await pool.query(
    `INSERT INTO jobs (type, payload, priority, scheduled_at, max_retries)
     VALUES ($1, $2, $3, COALESCE($4::timestamptz, now()), $5)
     RETURNING *`,
    [type, payload, priority, scheduledAt ?? null, maxRetries],
  );
  return rows[0];
}

export async function getJobById(id) {
  const { rows } = await pool.query('SELECT * FROM jobs WHERE id = $1', [id]);
  return rows[0] ?? null;
}

// A null status lists every job. Newest first, capped so the response stays bounded.
export async function listJobsByStatus(status) {
  const { rows } = await pool.query(
    `SELECT * FROM jobs
     WHERE ($1::text IS NULL OR status = $1)
     ORDER BY created_at DESC
     LIMIT $2`,
    [status ?? null, LIST_LIMIT],
  );
  return rows;
}

// Guarded update: only a QUEUED job can be cancelled. If a worker is claiming the
// row at the same moment, this UPDATE waits for the claim's row lock, re-checks
// status, finds RUNNING, and matches 0 rows, so cancel and claim cannot both win.
// Returns { outcome: 'cancelled' | 'missing' | 'not_queued', job }.
export async function cancelJob(id) {
  const updated = await pool.query(
    `UPDATE jobs SET status = 'CANCELLED', updated_at = now()
     WHERE id = $1 AND status = 'QUEUED'
     RETURNING *`,
    [id],
  );
  if (updated.rowCount === 1) return { outcome: 'cancelled', job: updated.rows[0] };

  // Only distinguishes 404 from 409; jobs are never deleted, so this cannot race to missing.
  const existing = await getJobById(id);
  return existing ? { outcome: 'not_queued', job: existing } : { outcome: 'missing', job: null };
}

// Claims the best eligible job and opens its attempt row in one transaction.
// Returns the claimed row, or null when nothing is eligible.
export async function claimNextJob(workerId, leaseDurationMs = config.leaseDurationMs) {
  return withTransaction(async (client) => {
    // The subquery picks and row-locks one eligible job; the outer UPDATE claims it
    // in the same statement, so there is no gap between choosing and claiming.
    // SKIP LOCKED makes concurrent claimers pass over a row another claimer holds
    // and take the next one instead of waiting for it and then matching nothing.
    // Eligibility and lease expiry both use the DB clock (now()), never the app's.
    const claimed = await client.query(
      `UPDATE jobs
       SET status = 'RUNNING',
           attempts = attempts + 1,
           lease_id = gen_random_uuid(),
           worker_id = $1,
           lease_expires_at = now() + ($2 * interval '1 millisecond'),
           updated_at = now()
       WHERE id = (
         SELECT id FROM jobs
         WHERE status = 'QUEUED' AND scheduled_at <= now()
         ORDER BY priority DESC, scheduled_at ASC
         LIMIT 1
         FOR UPDATE SKIP LOCKED
       )
       RETURNING *`,
      [workerId, leaseDurationMs],
    );
    if (claimed.rowCount === 0) return null;

    const job = claimed.rows[0];
    // Same transaction as the claim, so a job is never RUNNING without its attempt row.
    await client.query(
      `INSERT INTO job_attempts (job_id, attempt_no, lease_id, worker_id)
       VALUES ($1, $2, $3, $4)`,
      [job.id, job.attempts, job.lease_id, workerId],
    );
    return job;
  });
}

// Extends a lease the caller still holds. The expiry predicate means a lapsed lease
// cannot be revived: once expired, the job belongs to the reaper.
export async function renewLease(jobId, leaseId, leaseDurationMs = config.leaseDurationMs) {
  const { rows, rowCount } = await pool.query(
    `UPDATE jobs
     SET lease_expires_at = now() + ($3 * interval '1 millisecond'), updated_at = now()
     WHERE id = $1 AND lease_id = $2 AND status = 'RUNNING' AND lease_expires_at > now()
     RETURNING *`,
    [jobId, leaseId, leaseDurationMs],
  );
  if (rowCount === 0) throw new StaleLeaseError();
  return rows[0];
}

// Records success for the caller's lease. Pass `client` to run inside the caller's
// transaction, so a handler's side effect commits or rolls back with this fence.
// No expiry predicate: if the lease lapsed but nobody reaped or reclaimed the job,
// lease_id is still ours and no one else is running it, so the result is valid.
export async function completeJob(jobId, leaseId, result, client) {
  if (!client) return withTransaction((tx) => completeJob(jobId, leaseId, result, tx));

  const { rows, rowCount } = await client.query(
    `UPDATE jobs
     SET status = 'SUCCEEDED', result = $3::jsonb,
         lease_id = NULL, worker_id = NULL, lease_expires_at = NULL, updated_at = now()
     WHERE id = $1 AND lease_id = $2 AND status = 'RUNNING'
     RETURNING *`,
    // Stringified so pg does not turn a JS array into a Postgres array.
    [jobId, leaseId, JSON.stringify(result ?? null)],
  );
  if (rowCount === 0) throw new StaleLeaseError();

  await closeAttempt(client, leaseId, 'SUCCEEDED', null);
  return rows[0];
}

// Records a failed attempt for the caller's lease, then retries or fails for good.
export async function failJob(jobId, leaseId, errorMessage) {
  return withTransaction(async (client) => {
    // Fenced read under a row lock: the backoff needs attempts, and nothing can
    // change the row between this read and the UPDATE in retryOrFail.
    const locked = await client.query(
      `SELECT id, lease_id, attempts, max_retries FROM jobs
       WHERE id = $1 AND lease_id = $2 AND status = 'RUNNING'
       FOR UPDATE`,
      [jobId, leaseId],
    );
    if (locked.rowCount === 0) throw new StaleLeaseError();

    return retryOrFail(client, locked.rows[0], errorMessage, 'FAILED');
  });
}

// Shared by failJob and the reaper so both apply the same retry rule.
// `job` must be a RUNNING row the caller has locked (id, lease_id, attempts, max_retries).
async function retryOrFail(client, job, errorMessage, attemptOutcome) {
  const retry = shouldRetry(job.attempts, job.max_retries);
  const delayMs = retry
    ? backoffDelayMs(job.attempts, config.backoffBaseMs, config.backoffCapMs)
    : 0;

  // The fence is repeated even though the row is locked, so this UPDATE is
  // correct on its own. Clearing the lease makes the old lease_id dead at once.
  const { rows, rowCount } = await client.query(
    `UPDATE jobs
     SET status = CASE WHEN $3::boolean THEN 'QUEUED' ELSE 'FAILED' END,
         scheduled_at = CASE WHEN $3::boolean
                          THEN now() + ($4 * interval '1 millisecond')
                          ELSE scheduled_at END,
         lease_id = NULL, worker_id = NULL, lease_expires_at = NULL,
         last_error = $5, updated_at = now()
     WHERE id = $1 AND lease_id = $2 AND status = 'RUNNING'
     RETURNING *`,
    [job.id, job.lease_id, retry, delayMs, errorMessage],
  );
  if (rowCount === 0) throw new StaleLeaseError();

  await closeAttempt(client, job.lease_id, attemptOutcome, errorMessage);
  return rows[0];
}

// Each lease maps to exactly one attempt row; only an open (RUNNING) one is closed.
async function closeAttempt(client, leaseId, outcome, error) {
  await client.query(
    `UPDATE job_attempts SET outcome = $2, error = $3, finished_at = now()
     WHERE lease_id = $1 AND outcome = 'RUNNING'`,
    [leaseId, outcome, error],
  );
}

// Expired RUNNING leases become QUEUED (with backoff) or FAILED.
// Mark the open attempt LEASE_EXPIRED. A requeued job must be claimable again.
export async function reapExpiredLeases() {
  throw notImplemented('reapExpiredLeases');
}
