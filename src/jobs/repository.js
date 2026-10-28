import { notImplemented } from '../api/errors.js';

// Every jobs.status change lives here. Routes and the worker call these functions.
// Multi-statement changes use withTransaction from src/db/pool.js.
// Claim, renew, complete, fail, and reap must follow the invariants in CLAUDE.md.

export async function insertJob(_input) {
  throw notImplemented('insertJob');
}

export async function getJobById(_id) {
  throw notImplemented('getJobById');
}

export async function listJobsByStatus(_status) {
  throw notImplemented('listJobsByStatus');
}

// Guarded update: WHERE id = $1 AND status = 'QUEUED'.
// Return 'cancelled', 'missing', or 'not_queued'. The route maps those to 200, 404, 409.
export async function cancelJob(_id) {
  throw notImplemented('cancelJob');
}

// Single UPDATE ... WHERE id = (SELECT ... FOR UPDATE SKIP LOCKED LIMIT 1) RETURNING *.
// Eligible: status = 'QUEUED' AND scheduled_at <= now(), order priority DESC, scheduled_at ASC.
// Sets a new lease_id via gen_random_uuid(), increments attempts, status RUNNING.
// Returns the claimed row, or null when nothing is eligible.
export async function claimNextJob(_workerId) {
  throw notImplemented('claimNextJob');
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
