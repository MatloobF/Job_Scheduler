import path from 'node:path';
import { pathToFileURL } from 'node:url';

// Polling recovery process. Call reapExpiredLeases on reaperIntervalMs.
// A job must not stay RUNNING after its lease expires.

function isMain() {
  const entry = process.argv[1];
  return Boolean(entry) && import.meta.url === pathToFileURL(path.resolve(entry)).href;
}

if (isMain()) {
  console.error('Lease reaper is not implemented. See CLAUDE.md.');
  process.exit(1);
}
