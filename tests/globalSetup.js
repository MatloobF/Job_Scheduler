// Runs once before the suite so the test database always has the current schema.
// Imports are dynamic because pool.js picks its database URL at import time.
export async function setup() {
  process.env.NODE_ENV = 'test';
  const { migrate } = await import('../src/db/migrate.js');
  const { closePool } = await import('../src/db/pool.js');
  try {
    await migrate();
  } finally {
    await closePool();
  }
}
