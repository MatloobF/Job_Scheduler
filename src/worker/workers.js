import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { config } from '../config.js';

// One process per worker. Loops inside a single process would share `stop()` and
// a simulated crash would exit all of them. Children run worker.js as-is.
const workerScript = path.join(path.dirname(fileURLToPath(import.meta.url)), 'worker.js');
const count = config.workerCount;

if (!Number.isInteger(count) || count < 1) {
  throw new Error('WORKER_COUNT must be an integer of at least 1');
}

const children = new Map();

for (let n = 1; n <= count; n += 1) {
  // One worker keeps WORKER_ID. Several need distinct ids so jobs show who claimed them.
  const workerId = count === 1 ? config.workerId : `worker-${n}`;
  const child = spawn(process.execPath, [workerScript], {
    env: { ...process.env, WORKER_ID: workerId },
    stdio: 'inherit',
  });
  children.set(child, workerId);
  child.on('exit', (code, signal) => {
    children.delete(child);
    console.log(`worker ${workerId} stopped (${signal || code})`);
    if (children.size === 0) process.exit(code && !signal ? code : 0);
  });
}

console.log(`started ${count} worker${count === 1 ? '' : 's'}`);

// Ctrl+C reaches each child through the shared console. A second kill here would
// cut off the graceful stop those processes already handle.
function ignore() {}
process.on('SIGINT', ignore);
process.on('SIGTERM', ignore);
