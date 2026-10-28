import { pool } from '../src/db/pool.js';

const TABLES = ['notifications', 'reports', 'job_attempts', 'jobs', 'sales'];

export async function truncateAll() {
  for (const table of TABLES) {
    const found = await pool.query('SELECT to_regclass($1) AS name', [`public.${table}`]);
    if (!found.rows[0].name) continue;
    await pool.query(`TRUNCATE ${table} RESTART IDENTITY CASCADE`);
  }
}
