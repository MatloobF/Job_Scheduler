import { notImplemented } from './errors.js';

// Expected create-job body, once implemented:
// {
//   type: 'SEND_NOTIFICATION' | 'GENERATE_REPORT',
//   payload: object,
//   priority: integer (higher runs first),
//   scheduledAt: ISO timestamp, optional (default now),
//   maxRetries: integer >= 0
// }
// SEND_NOTIFICATION payload: { recipient: string, message: string, simulateFailure?: boolean, simulateCrashAfterWork?: boolean }
// GENERATE_REPORT payload: { simulateFailure?: boolean, simulateCrashAfterWork?: boolean }
// Unknown types and malformed payloads are 400.

export function parseCreateJob(_body) {
  throw notImplemented('parseCreateJob');
}

export function parseStatusQuery(_query) {
  throw notImplemented('parseStatusQuery');
}
