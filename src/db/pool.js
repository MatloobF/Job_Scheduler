import pg from 'pg';
import { databaseUrl } from '../config.js';

const { Pool } = pg;

export const pool = new Pool({ connectionString: databaseUrl() });

export async function withTransaction(fn) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    try {
      await client.query('ROLLBACK');
    } catch (rollbackErr) {
      err.rollbackError = rollbackErr;
    }
    throw err;
  } finally {
    client.release();
  }
}

export async function closePool() {
  await pool.end();
}
