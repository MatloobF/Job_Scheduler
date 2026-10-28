-- Matches the claim query's filter and ORDER BY. Partial, so finished jobs
-- never grow the index the claim scans.
CREATE INDEX jobs_claim_idx ON jobs (priority DESC, scheduled_at)
  WHERE status = 'QUEUED';
