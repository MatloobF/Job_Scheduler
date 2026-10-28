import { crashAfterWork, failBeforeWork } from '../simulation.js';

// payload: { recipient, message, simulateFailure?, simulateCrashAfterWork? }
// Runs inside the worker's transaction, together with the fenced completeJob.
export async function sendNotification(client, job) {
  const { recipient, message } = job.payload;
  failBeforeWork(job.payload);

  // One notification per job: a repeated execution hits the job_id key and writes
  // nothing. If another attempt's insert is still uncommitted, this waits for it.
  const inserted = await client.query(
    `INSERT INTO notifications (job_id, recipient, message)
     VALUES ($1, $2, $3)
     ON CONFLICT (job_id) DO NOTHING`,
    [job.id, recipient, message],
  );

  crashAfterWork(job.payload);
  return { recipient, delivered: true, duplicate: inserted.rowCount === 0 };
}
