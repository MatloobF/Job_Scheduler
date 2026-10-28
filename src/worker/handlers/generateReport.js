import { notImplemented } from '../../api/errors.js';

// Read sample rows from sales and persist one summary in reports, keyed by job_id.
// ON CONFLICT (job_id) DO UPDATE so a repeated attempt does not create a second report.
// simulateFailure / simulateCrashAfterWork follow the same rules as sendNotification.
export async function generateReport(_client, _job) {
  throw notImplemented('generateReport');
}
