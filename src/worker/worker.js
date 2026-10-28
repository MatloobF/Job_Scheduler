import path from 'node:path';
import { pathToFileURL } from 'node:url';

// Poll loop to implement:
// - claimNextJob(workerId)
// - renew every leaseDurationMs / 3 while the handler runs
// - clear the renew timer in finally
// - if renew throws StaleLeaseError, abort and do not write a result
// - SIGINT/SIGTERM: finish the current job, then stop claiming
// - dispatch SEND_NOTIFICATION and GENERATE_REPORT
// Do not set jobs.status from this file.

function isMain() {
  const entry = process.argv[1];
  return Boolean(entry) && import.meta.url === pathToFileURL(path.resolve(entry)).href;
}

if (isMain()) {
  console.error('Worker poll loop is not implemented. See CLAUDE.md.');
  process.exit(1);
}
