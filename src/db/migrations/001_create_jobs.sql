CREATE TABLE jobs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  type TEXT NOT NULL,
  payload JSONB NOT NULL,
  priority INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'QUEUED',
  scheduled_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  max_retries INTEGER NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  lease_id UUID,
  worker_id TEXT,
  lease_expires_at TIMESTAMPTZ,
  last_error TEXT,
  result JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT jobs_status_check CHECK (
    status IN ('QUEUED', 'RUNNING', 'SUCCEEDED', 'FAILED', 'CANCELLED')
  ),
  CONSTRAINT jobs_max_retries_check CHECK (max_retries >= 0),
  CONSTRAINT jobs_attempts_check CHECK (attempts >= 0)
);
