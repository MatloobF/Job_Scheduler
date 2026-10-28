import dotenv from 'dotenv';

dotenv.config();

function integer(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value)) {
    throw new Error(`${name} must be a number`);
  }
  return value;
}

export const config = {
  databaseUrl: process.env.DATABASE_URL ?? '',
  databaseUrlTest: process.env.DATABASE_URL_TEST ?? '',
  port: integer('PORT', 3000),
  workerId: process.env.WORKER_ID || 'worker-1',
  leaseDurationMs: integer('LEASE_DURATION_MS', 30_000),
  pollIntervalMs: integer('POLL_INTERVAL_MS', 1000),
  reaperIntervalMs: integer('REAPER_INTERVAL_MS', 5000),
  backoffBaseMs: integer('BACKOFF_BASE_MS', 1000),
  backoffCapMs: integer('BACKOFF_CAP_MS', 60_000),
};

export function databaseUrl() {
  if (process.env.NODE_ENV === 'test') {
    if (!config.databaseUrlTest) {
      throw new Error('DATABASE_URL_TEST is required when NODE_ENV=test');
    }
    return config.databaseUrlTest;
  }
  if (!config.databaseUrl) {
    throw new Error('DATABASE_URL is required');
  }
  return config.databaseUrl;
}
