import { notImplemented } from '../api/errors.js';
import { config } from '../config.js';
import { pool, withTransaction } from '../db/pool.js';

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

// WHERE id = $1 AND lease_id = $2 AND status = 'RUNNING' AND lease_expires_at > now().
// rowCount === 0 -> StaleLeaseError.
export async function renewLease(_jobId, _leaseId) {
  throw notImplemented('renewLease');
}

// Same fence as renew, without the expiry predicate (completion of a still-held lease).
// Writes result and status SUCCEEDED. Update job_attempts in the same transaction.
// rowCount === 0 -> StaleLeaseError. Do not write the result if the fence misses.
export async function completeJob(_jobId, _leaseId, _result) {
  throw notImplemented('completeJob');
}

// Same fence. Retry while attempts < 1 + max_retries, otherwise permanent FAILED.
// Record last_error and the attempt outcome in the same transaction.
// rowCount === 0 -> StaleLeaseError.
export async function failJob(_jobId, _leaseId, _errorMessage) {
  throw notImplemented('failJob');
}

// Expired RUNNING leases become QUEUED (with backoff) or FAILED.
// Mark the open attempt LEASE_EXPIRED. A requeued job must be claimable again.
export async function reapExpiredLeases() {
  throw notImplemented('reapExpiredLeases');
}
