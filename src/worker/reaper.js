import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { config } from '../config.js';
import { closePool } from '../db/pool.js';
import { reapExpiredLeases } from '../jobs/repository.js';

// Polling recovery process. Calls reapExpiredLeases every reaperIntervalMs so that
// no job stays RUNNING after its lease expires.

let stopping = false;
let timer = null;

async function runPass() {
  timer = null;
  try {
    const reaped = await reapExpiredLeases();
    for (const job of reaped) {
      console.log(`reaped job ${job.id}: now ${job.status} (${job.last_error})`);
    }
  } catch (err) {
    // A failed pass (e.g. a dropped connection) must not stop recovery for good.
    console.error('reaper pass failed:', err.message);
  }

  if (stopping) {
    await shutdown();
    return;
  }
  // Scheduled after the pass finishes, so passes never overlap.
  timer = setTimeout(runPass, config.reaperIntervalMs);
}

function requestStop() {
  if (stopping) return;
  stopping = true;
  // Between passes: stop now. Mid-pass: runPass shuts down when the pass ends.
  if (timer) {
    clearTimeout(timer);
    timer = null;
    shutdown();
  }
}

async function shutdown() {
  await closePool();
  console.log('reaper stopped');
}

function isMain() {
  const entry = process.argv[1];
  return Boolean(entry) && import.meta.url === pathToFileURL(path.resolve(entry)).href;
}

if (isMain()) {
  process.on('SIGINT', requestStop);
  process.on('SIGTERM', requestStop);
  console.log(`reaper started, interval ${config.reaperIntervalMs} ms`);
  runPass();
}
