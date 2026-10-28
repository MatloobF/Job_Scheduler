import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { StaleLeaseError } from '../api/errors.js';
import { config } from '../config.js';
import { closePool, withTransaction } from '../db/pool.js';
import { claimNextJob, completeJob, failJob, renewLease } from '../jobs/repository.js';
import { generateReport } from './handlers/generateReport.js';
import { sendNotification } from './handlers/sendNotification.js';
import { SimulatedCrashError } from './simulation.js';

// Poll loop: claim a job, run its handler while renewing the lease, record the outcome.
// Every status change goes through the fenced repository functions; this file never
// sets jobs.status itself.

const handlers = {
  SEND_NOTIFICATION: sendNotification,
  GENERATE_REPORT: generateReport,
};

// In tests a simulated crash propagates as an error. The worker process replaces this
// with a real exit, so the open transaction dies with the connection.
let crashProcess = (err) => {
  throw err;
};

let stopping = false;
let wakeUp = null;

// Claims and runs at most one job. Returns { outcome: 'idle' } when nothing is eligible.
export async function processNextJob(workerId = config.workerId) {
  const job = await claimNextJob(workerId);
  if (!job) return { outcome: 'idle' };

  const outcome = await runJob(job);
  console.log(`[${workerId}] job ${job.id} (${job.type}, attempt ${job.attempts}): ${outcome}`);
  return { jobId: job.id, outcome };
}

async function runJob(job) {
  const lease = startLeaseRenewal(job);
  let error = null;
  try {
    // The handler's side effect and the fenced complete share one transaction,
    // so if the fence misses, the side effect rolls back with it.
    await withTransaction(async (client) => {
      const result = await runHandler(client, job);
      // JS cannot interrupt the handler, so a failed renewal is checked here instead.
      // Without this, an expired but unreaped lease would still pass completeJob's fence.
      if (lease.lost) throw new StaleLeaseError('Lease renewal failed during execution');
      await completeJob(job.id, job.lease_id, result, client);
    });
  } catch (err) {
    error = err;
  } finally {
    lease.stop();
  }

  if (!error) return 'succeeded';
  // A crash records nothing: the attempt stays RUNNING until its lease expires.
  if (error instanceof SimulatedCrashError) throw error;
  // The lease is gone: someone else owns the job now, so record nothing.
  if (error instanceof StaleLeaseError || lease.lost) return 'stale';
  return recordFailure(job, error);
}

async function runHandler(client, job) {
  const handler = handlers[job.type];
  if (!handler) throw new Error(`No handler for job type ${job.type}`);
  try {
    return await handler(client, job);
  } catch (err) {
    // Exits inside the open transaction in the worker process: nothing is committed
    // and no ROLLBACK is sent, exactly as if the process had died here.
    if (err instanceof SimulatedCrashError) crashProcess(err);
    throw err;
  }
}

async function recordFailure(job, error) {
  try {
    await failJob(job.id, job.lease_id, error.message);
    return 'failed';
  } catch (err) {
    // Reaped between the handler failing and this write; the reaper already recorded it.
    if (err instanceof StaleLeaseError) return 'stale';
    throw err;
  }
}

// Renews every leaseDuration / 3, so two renewals can fail before the lease expires.
// Any renewal error marks the lease lost; the worker then records no result.
function startLeaseRenewal(job) {
  let lost = false;
  const timer = setInterval(async () => {
    if (lost) return;
    try {
      await renewLease(job.id, job.lease_id);
    } catch (err) {
      lost = true;
      console.warn(`job ${job.id}: lease renewal failed, abandoning attempt (${err.message})`);
    }
  }, Math.floor(config.leaseDurationMs / 3));

  return {
    get lost() {
      return lost;
    },
    stop() {
      clearInterval(timer);
    },
  };
}

// Runs until stop() is called. The current job always finishes before the loop exits.
export async function runWorker(workerId = config.workerId) {
  stopping = false;
  while (!stopping) {
    try {
      const { outcome } = await processNextJob(workerId);
      if (outcome === 'idle' && !stopping) await idle(config.pollIntervalMs);
    } catch (err) {
      if (err instanceof SimulatedCrashError) throw err;
      // e.g. the database is briefly unreachable; back off and keep polling.
      console.error(`[${workerId}] iteration failed: ${err.message}`);
      await idle(config.pollIntervalMs);
    }
  }
}

// Stops claiming new jobs; wakes the loop if it is waiting between polls.
export function stop() {
  stopping = true;
  if (wakeUp) wakeUp();
}

function idle(ms) {
  return new Promise((resolve) => {
    const timer = setTimeout(done, ms);
    wakeUp = done;
    function done() {
      clearTimeout(timer);
      wakeUp = null;
      resolve();
    }
  });
}

function isMain() {
  const entry = process.argv[1];
  return Boolean(entry) && import.meta.url === pathToFileURL(path.resolve(entry)).href;
}

if (isMain()) {
  crashProcess = () => {
    console.error('simulated crash after work: exiting without cleanup');
    process.exit(1);
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
  console.log(`worker ${config.workerId} started`);
  runWorker(config.workerId).then(async () => {
    await closePool();
    console.log(`worker ${config.workerId} stopped`);
  });
}
