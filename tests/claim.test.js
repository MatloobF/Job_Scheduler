import { describe, it } from 'vitest';

describe('atomic claim', () => {
  it.todo('lets only one of two concurrent workers claim a single job');
  it.todo('gives each claim a distinct lease id and increments attempts');
  it.todo('claims a higher priority job before a lower priority due job');
  it.todo('does not claim a job whose scheduled_at is in the future');
});

describe('leases and stale workers', () => {
  it.todo('renews a live lease');
  it.todo('rejects renew, complete, and fail after the lease id changes');
  it.todo('requeues a job whose lease has expired and still has retries');
  it.todo('permanently fails an expired lease when retries are exhausted');
  it.todo('does not leave the job RUNNING after the reaper runs');
});
