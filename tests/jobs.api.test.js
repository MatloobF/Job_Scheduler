import { describe, it } from 'vitest';

describe('job submission', () => {
  it.todo('creates a QUEUED job and returns its id');
  it.todo('rejects an unknown job type');
  it.todo('rejects a SEND_NOTIFICATION payload without recipient or message');
  it.todo('rejects a negative maxRetries');
  it.todo('gets a job by id');
  it.todo('returns 404 for an unknown id');
  it.todo('lists jobs filtered by status');
});

describe('cancellation', () => {
  it.todo('cancels a QUEUED job');
  it.todo('returns 409 when cancelling a RUNNING job');
  it.todo('does not claim a cancelled job');
});
