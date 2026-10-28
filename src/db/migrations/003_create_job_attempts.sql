-- One row per execution. The primary key's leading job_id column also serves
-- lookups of a job's attempt history.
CREATE TABLE job_attempts (
  job_id UUID NOT NULL REFERENCES jobs (id) ON DELETE CASCADE,
  attempt_no INTEGER NOT NULL,
  -- Each claim issues exactly one lease, so the lease identifies its attempt.
  lease_id UUID NOT NULL UNIQUE,
  worker_id TEXT NOT NULL,
  started_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  finished_at TIMESTAMPTZ,
  outcome TEXT NOT NULL DEFAULT 'RUNNING',
  error TEXT,
  PRIMARY KEY (job_id, attempt_no),
  CONSTRAINT job_attempts_outcome_check CHECK (
    outcome IN ('RUNNING', 'SUCCEEDED', 'FAILED', 'LEASE_EXPIRED')
  ),
  CONSTRAINT job_attempts_attempt_no_check CHECK (attempt_no >= 1)
);
