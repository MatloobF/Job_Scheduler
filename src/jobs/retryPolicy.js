// delay = min(baseMs * 2^(attempts - 1), capMs)
// attempts is the number of executions already started, so it is >= 1 here.
export function backoffDelayMs(attempts, baseMs, capMs) {
  return Math.min(baseMs * 2 ** (attempts - 1), capMs);
}

// A job may run at most 1 + maxRetries times.
// Retry when attempts < 1 + maxRetries. attempts is executions already started.
export function shouldRetry(attempts, maxRetries) {
  return attempts < 1 + maxRetries;
}
