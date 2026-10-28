import { notImplemented } from '../../api/errors.js';

// payload: { recipient, message, simulateFailure?, simulateCrashAfterWork? }
// Insert into notifications with ON CONFLICT (job_id) DO NOTHING (or DO UPDATE).
// Prefer running this write in the same transaction as the fenced complete.
export async function sendNotification(_client, _job) {
  throw notImplemented('sendNotification');
}
