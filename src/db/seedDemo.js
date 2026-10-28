import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { config } from '../config.js';
import {
  cancelJob,
  claimNextJob,
  failJob,
  insertJob,
  reapExpiredLeases,
} from '../jobs/repository.js';
import { processNextJob } from '../worker/worker.js';
import { pool } from './pool.js';
import { seed } from './seed.js';

// Fills the dev database with jobs in every lifecycle state. Rows are produced by the
// real repository functions and worker, never by raw inserts, so each one is a state
// the system can actually reach (matching attempt rows, lease fields, side effects).
//
// Each scenario runs to its end state before the next starts, so the worker only ever
// sees the one due job meant for it. The only waits are for a retry's backoff to pass.

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// A requeued job's first backoff is backoffBaseMs; the margin covers commit latency.
const waitForFirstBackoff = () => sleep(config.backoffBaseMs + 200);

function notification(recipient, message, extra = {}) {
  return {
    type: 'SEND_NOTIFICATION',
    payload: { recipient, message, ...extra.payload },
    priority: extra.priority ?? 5,
    maxRetries: extra.maxRetries ?? 2,
    scheduledAt: extra.scheduledAt,
  };
}

function report(extra = {}) {
  return {
    type: 'GENERATE_REPORT',
    payload: { ...extra.payload },
    priority: extra.priority ?? 3,
    maxRetries: extra.maxRetries ?? 1,
    scheduledAt: extra.scheduledAt,
  };
}

async function succeeded() {
  for (const [recipient, message] of [
    ['alice@example.com', 'Your order has shipped'],
    ['bob@example.com', 'Password changed'],
    ['carol@example.com', 'Weekly digest is ready'],
  ]) {
    await insertJob(notification(recipient, message));
    await processNextJob('demo-worker-1');
  }
  for (let i = 0; i < 2; i += 1) {
    await insertJob(report());
    await processNextJob('demo-worker-2');
  }
}

// Fails once with a recorded error, then succeeds on the retry.
async function retriedThenSucceeded() {
  const job = await insertJob(notification('dave@example.com', 'Invoice #1042'));
  const claimed = await claimNextJob('demo-worker-1');
  await failJob(job.id, claimed.lease_id, 'SMTP timeout (demo)');
  await waitForFirstBackoff();
  await processNextJob('demo-worker-2');
}

// simulateFailure on every attempt: 1 + maxRetries runs, then permanently FAILED.
async function permanentlyFailed() {
  await insertJob(
    notification('erin@example.com', 'Will never send', {
      payload: { simulateFailure: true },
      maxRetries: 1,
    }),
  );
  await processNextJob('demo-worker-1');
  await waitForFirstBackoff();
  await processNextJob('demo-worker-1');
}

// A worker "dies" holding the lease: claimed with a 1 ms lease that the reaper then
// expires. With retries left the job is requeued and a healthy worker finishes it.
async function crashedThenRecovered() {
  await insertJob(report({ maxRetries: 2 }));
  await claimNextJob('demo-worker-crashed', 1);
  await sleep(20);
  await reapExpiredLeases();
  await waitForFirstBackoff();
  await processNextJob('demo-worker-2');
}

// The same crash with maxRetries 0: the reaper fails it permanently.
async function crashedAndFailed() {
  await insertJob(notification('frank@example.com', 'Lost with the worker', { maxRetries: 0 }));
  await claimNextJob('demo-worker-crashed', 1);
  await sleep(20);
  await reapExpiredLeases();
}

async function cancelled() {
  const job = await insertJob(
    notification('grace@example.com', 'Promo we decided not to send', {
      scheduledAt: '2030-06-01T09:00:00Z',
    }),
  );
  await cancelJob(job.id);
}

// Left for a real worker: future-scheduled jobs, one RUNNING lease, and due jobs.
async function pending() {
  await insertJob(notification('heidi@example.com', 'New year greeting', { scheduledAt: '2030-01-01T00:00:00Z' }));
  await insertJob(report({ scheduledAt: '2030-01-01T06:00:00Z' }));

  // Held by a worker that is not running: the reaper requeues it after the lease expires.
  await insertJob(notification('ivan@example.com', 'Held by an idle worker', { priority: 1 }));
  await claimNextJob('demo-worker-idle');

  // Due now: the next `npm run worker` picks these up, higher priority first.
  await insertJob(notification('judy@example.com', 'Waiting for a worker', { priority: 8 }));
  await insertJob(report({ priority: 2 }));
}

async function summary() {
  const statuses = await pool.query(
    'SELECT status, count(*)::int AS jobs FROM jobs GROUP BY status ORDER BY status',
  );
  const outcomes = await pool.query(
    'SELECT outcome, count(*)::int AS attempts FROM job_attempts GROUP BY outcome ORDER BY outcome',
  );
  const tables = await pool.query(
    `SELECT (SELECT count(*) FROM jobs)::int AS jobs,
            (SELECT count(*) FROM job_attempts)::int AS job_attempts,
            (SELECT count(*) FROM notifications)::int AS notifications,
            (SELECT count(*) FROM reports)::int AS reports,
            (SELECT count(*) FROM sales)::int AS sales`,
  );
  console.log('\njobs by status:');
  console.table(statuses.rows);
  console.log('attempts by outcome:');
  console.table(outcomes.rows);
  console.log('rows per table:');
  console.table(tables.rows);
}

export async function seedDemo() {
  // The test suite truncates its own database; demo data belongs in the dev database.
  if (process.env.NODE_ENV === 'test') {
    throw new Error('seed:demo targets the dev database; unset NODE_ENV=test');
  }

  await seed();
  await pool.query('TRUNCATE jobs RESTART IDENTITY CASCADE');
  console.log('cleared jobs, job_attempts, notifications, reports');

  await succeeded();
  await retriedThenSucceeded();
  await permanentlyFailed();
  await crashedThenRecovered();
  await crashedAndFailed();
  await cancelled();
  await pending();
  await summary();
}

function isMain() {
  const entry = process.argv[1];
  return Boolean(entry) && import.meta.url === pathToFileURL(path.resolve(entry)).href;
}

if (isMain()) {
  seedDemo()
    .then(() => pool.end())
    .catch(async (err) => {
      console.error(err.message ?? err);
      await pool.end();
      process.exit(1);
    });
}
