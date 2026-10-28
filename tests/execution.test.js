import { describe, it } from 'vitest';

describe('execution', () => {
  it.todo('records a notification for SEND_NOTIFICATION');
  it.todo('persists a sales summary for GENERATE_REPORT');
  it.todo('marks the job SUCCEEDED and stores the result');
});

describe('retries', () => {
  it.todo('requeues a failed job while attempts < 1 + maxRetries');
  it.todo('sets scheduled_at from the backoff delay');
  it.todo('permanently fails when maxRetries is 0 and the first attempt fails');
  it.todo('stores the latest error and an attempt history row');
});

describe('idempotency', () => {
  it.todo('does not insert a second notification when the same job runs again');
  it.todo('does not insert a second report when the same job runs again');
  it.todo('a stale worker cannot mark a newer attempt successful');
});
