import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { pool } from './pool.js';

// Column contract for the sales migration Claude Code still has to add:
//   id SERIAL PRIMARY KEY, category TEXT NOT NULL, amount NUMERIC NOT NULL
const SAMPLE_SALES = [
  ['widgets', 10],
  ['widgets', 15],
  ['gadgets', 7],
  ['gadgets', 3],
];

export async function seed() {
  const exists = await pool.query(`SELECT to_regclass('public.sales') AS name`);
  if (!exists.rows[0].name) {
    throw new Error(
      'public.sales does not exist. Add it in a new migration (do not edit 001), then run npm run seed.',
    );
  }

  await pool.query('TRUNCATE sales RESTART IDENTITY');
  await pool.query(
    `INSERT INTO sales (category, amount)
     SELECT * FROM UNNEST($1::text[], $2::numeric[])`,
    [SAMPLE_SALES.map((row) => row[0]), SAMPLE_SALES.map((row) => row[1])],
  );
  console.log(`seeded ${SAMPLE_SALES.length} sales rows`);
}

function isMain() {
  const entry = process.argv[1];
  return Boolean(entry) && import.meta.url === pathToFileURL(path.resolve(entry)).href;
}

if (isMain()) {
  seed()
    .then(() => pool.end())
    .catch(async (err) => {
      console.error(err.message ?? err);
      await pool.end();
      process.exit(1);
    });
}
