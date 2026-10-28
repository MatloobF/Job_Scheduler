import { z } from 'zod';

const JOB_STATUSES = ['QUEUED', 'RUNNING', 'SUCCEEDED', 'FAILED', 'CANCELLED'];

const failureFlags = {
  simulateFailure: z.boolean().optional(),
  simulateCrashAfterWork: z.boolean().optional(),
};

// strict() rejects unknown keys, so a typo like "simulateFailur" is a 400
// instead of being silently ignored.
const sendNotificationPayload = z
  .object({
    recipient: z.string().min(1),
    message: z.string().min(1),
    ...failureFlags,
  })
  .strict();

const generateReportPayload = z.object({ ...failureFlags }).strict();

const commonFields = {
  // Bounded to Postgres INTEGER so an out-of-range value is a 400, not a DB error.
  priority: z.number().int().min(-2147483648).max(2147483647).default(0),
  // Stored as data only; eligibility is always compared against the DB's now().
  scheduledAt: z.string().datetime({ offset: true }).optional(),
  // Capped so 1 + max_retries can never overflow INTEGER in the retry check.
  maxRetries: z.number().int().min(0).max(100),
};

const createJobBody = z.discriminatedUnion('type', [
  z.object({ type: z.literal('SEND_NOTIFICATION'), payload: sendNotificationPayload, ...commonFields }),
  z.object({ type: z.literal('GENERATE_REPORT'), payload: generateReportPayload, ...commonFields }),
]);

const statusQuery = z.object({
  status: z.enum(JOB_STATUSES).optional(),
});

const jobId = z.string().uuid({ message: 'id must be a UUID' });

export function parseCreateJob(body) {
  return createJobBody.parse(body);
}

export function parseStatusQuery(query) {
  return statusQuery.parse(query).status;
}

// Rejects malformed ids before they reach Postgres, which would raise a cast error.
export function parseJobId(id) {
  return jobId.parse(id);
}
