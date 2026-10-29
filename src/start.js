import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { config } from './config.js';

// One Render process starts the API, the reaper, and each worker as its own process.
// A simulated crash calls process.exit inside that worker only. Render restarts a
// service when this process exits, so an API exit ends this process too.

const dir = path.dirname(fileURLToPath(import.meta.url));
const children = new Set();
let stopping = false;

function start(script, env = {}) {
  const child = spawn(process.execPath, [path.join(dir, script)], {
    env: { ...process.env, ...env },
    stdio: 'inherit',
  });
  children.add(child);
  return child;
}

function watch(name, script, env, { exitOnStop }) {
  const child = start(script, env);
  child.on('exit', (code, signal) => {
    children.delete(child);
    console.log(`${name} stopped (${signal || code})`);
    if (stopping) return;
    if (exitOnStop) {
      shutdown(code && !signal ? code : 1);
      return;
    }
    // A worker or reaper crash leaves the API up. Replace that one process.
    setTimeout(() => {
      if (!stopping) watch(name, script, env, { exitOnStop });
    }, 1000);
  });
}

function shutdown(code) {
  if (stopping) return;
  stopping = true;
  for (const child of children) child.kill('SIGTERM');
  // worker.js finishes its current job on SIGTERM. Exit after that window so
  // Render still observes this process stopping.
  setTimeout(() => process.exit(code), 5000);
}

const count = config.workerCount;
if (!Number.isInteger(count) || count < 1) {
  throw new Error('WORKER_COUNT must be an integer of at least 1');
}

watch('api', 'api/server.js', {}, { exitOnStop: true });
watch('reaper', 'worker/reaper.js', {}, { exitOnStop: false });
for (let n = 1; n <= count; n += 1) {
  const workerId = count === 1 ? config.workerId : `worker-${n}`;
  watch(workerId, 'worker/worker.js', { WORKER_ID: workerId }, { exitOnStop: false });
}

process.on('SIGTERM', () => shutdown(0));
process.on('SIGINT', () => shutdown(0));
