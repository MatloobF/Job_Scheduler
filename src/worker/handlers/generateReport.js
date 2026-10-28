import { crashAfterWork, failBeforeWork } from '../simulation.js';

// Summarises sales and persists one report per job. Runs inside the worker's
// transaction, together with the fenced completeJob.
export async function generateReport(client, job) {
  failBeforeWork(job.payload);

  // A single INSERT ... SELECT reads sales from one snapshot. COALESCE turns the
  // NULLs that aggregates return on an empty table into zeros and {}.
  // DO UPDATE: a repeated execution refreshes the same row instead of adding one.
  const { rows } = await client.query(
    `INSERT INTO reports (job_id, row_count, total_amount, totals_by_category)
     SELECT $1,
            COALESCE(sum(row_count), 0)::int,
            COALESCE(sum(total), 0),
            COALESCE(jsonb_object_agg(category, total), '{}'::jsonb)
     FROM (
       SELECT category, count(*) AS row_count, sum(amount) AS total
       FROM sales
       GROUP BY category
     ) AS by_category
     ON CONFLICT (job_id) DO UPDATE
       SET row_count = EXCLUDED.row_count,
           total_amount = EXCLUDED.total_amount,
           totals_by_category = EXCLUDED.totals_by_category,
           generated_at = now()
     RETURNING row_count, total_amount, totals_by_category`,
    [job.id],
  );

  crashAfterWork(job.payload);
  const report = rows[0];
  // total_amount stays a string: pg returns NUMERIC as text to avoid float rounding.
  return {
    rowCount: report.row_count,
    totalAmount: report.total_amount,
    totalsByCategory: report.totals_by_category,
  };
}
