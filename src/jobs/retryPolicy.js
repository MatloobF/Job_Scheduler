import { notImplemented } from '../api/errors.js';

// delay = min(baseMs * 2^(attempts - 1), capMs)
// attempts is the number of executions already started.
export function backoffDelayMs(_attempts, _baseMs, _capMs) {
  throw notImplemented('backoffDelayMs');
}

// A job may run at most 1 + maxRetries times.
// Retry when attempts < 1 + maxRetries. attempts is executions already started.
export function shouldRetry(_attempts, _maxRetries) {
  throw notImplemented('shouldRetry');
}
