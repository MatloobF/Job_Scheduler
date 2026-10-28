import { describe, expect, it } from 'vitest';
import { backoffDelayMs, shouldRetry } from '../src/jobs/retryPolicy.js';

describe('shouldRetry', () => {
  it('never retries when maxRetries is 0', () => {
    expect(shouldRetry(1, 0)).toBe(false);
  });

  it('allows exactly 1 + maxRetries executions', () => {
    expect(shouldRetry(1, 2)).toBe(true);
    expect(shouldRetry(2, 2)).toBe(true);
    expect(shouldRetry(3, 2)).toBe(false);
  });
});

describe('backoffDelayMs', () => {
  it('doubles from the base delay', () => {
    expect([1, 2, 3, 4].map((n) => backoffDelayMs(n, 1000, 60_000))).toEqual([
      1000, 2000, 4000, 8000,
    ]);
  });

  it('stops at the cap', () => {
    expect(backoffDelayMs(6, 1000, 60_000)).toBe(32_000);
    expect(backoffDelayMs(7, 1000, 60_000)).toBe(60_000);
    expect(backoffDelayMs(101, 1000, 60_000)).toBe(60_000);
  });
});
