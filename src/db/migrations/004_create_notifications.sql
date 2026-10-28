-- job_id as the primary key makes the side effect idempotent: a repeated
-- execution hits ON CONFLICT (job_id) instead of sending a second notification.
CREATE TABLE notifications (
  job_id UUID PRIMARY KEY REFERENCES jobs (id) ON DELETE CASCADE,
  recipient TEXT NOT NULL,
  message TEXT NOT NULL,
  delivered_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
