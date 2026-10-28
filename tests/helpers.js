import { expect, vi } from 'vitest';
import { pool } from '../src/db/pool.js';
import { insertJob } from '../src/jobs/repository.js';

const TABLES = ['notifications', 'reports', 'job_attempts', 'jobs', 'sales'];

export async function truncateAll() {
  for (const table of TABLES) {
    const found = await pool.query('SELECT to_regclass($1) AS name', [`public.${table}`]);
    if (!found.rows[0].name) continue;
    await pool.query(`TRUNCATE ${table} RESTART IDENTITY CASCADE`);
  }
}

export function createTestJob(overrides = {}) {
  return insertJob({
    type: 'GENERATE_REPORT',
    payload: {},
    priority: 0,
    maxRetries: 3,
    ...overrides,
  });
}

// Moves scheduled_at relative to the DB clock, so tests never depend on the app clock.
export async function scheduleAt(jobId, offset) {
  await pool.query(`UPDATE jobs SET scheduled_at = now() + $2::interval WHERE id = $1`, [
    jobId,
    offset,
  ]);
}

// Makes a requeued job (backoff in the future) claimable now, without sleeping.
export function makeDue(jobId) {
  return scheduleAt(jobId, '0 seconds');
}

// Waits until exactly one session is blocked on a lock while running a query that
// matches `likePattern`, as observed by Postgres itself. Used instead of sleeping.
export async function waitForBlockedQuery(likePattern) {
  await vi.waitFor(
    async () => {
      const { rows } = await pool.query(
        `SELECT count(*)::int AS n FROM pg_stat_activity
         WHERE datname = current_database() AND wait_event_type = 'Lock' AND query LIKE $1`,
        [likePattern],
      );
      expect(rows[0].n).toBe(1);
    },
    { timeout: 5000, interval: 20 },
  );
}

// Simulates an expired lease without sleeping.
export async function expireLease(jobId) {
  await pool.query(
    `UPDATE jobs SET lease_expires_at = now() - interval '1 second' WHERE id = $1`,
    [jobId],
  );
}
