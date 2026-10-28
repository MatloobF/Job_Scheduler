-- One report per job; a repeated execution overwrites it via
-- ON CONFLICT (job_id) DO UPDATE instead of adding a second row.
CREATE TABLE reports (
  job_id UUID PRIMARY KEY REFERENCES jobs (id) ON DELETE CASCADE,
  row_count INTEGER NOT NULL,
  total_amount NUMERIC NOT NULL,
  totals_by_category JSONB NOT NULL,
  generated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
