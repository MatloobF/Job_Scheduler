# AI usage log

Append one short entry after each implementation step: what was generated, what you changed by hand, and which tests verified it.

## Scaffold

- Cursor generated this skeleton: config, Postgres pool and `withTransaction`, migration runner, `001_create_jobs.sql`, Express shell, function stubs, and `it.todo` test names.
- No job lifecycle behavior was implemented. No bug was planted.
- Verified by `npm test` (todo suite only). Postgres was not required for that run.

## Step 1: Schema

- Claude Code generated migrations `002`–`006`: partial claim index on `jobs (priority DESC, scheduled_at) WHERE status = 'QUEUED'`, and tables `job_attempts`, `notifications`, `reports`, `sales`. One file per table, `001` untouched.
- Design choices: `job_attempts.lease_id` is UNIQUE so each attempt row maps to exactly one claim; `notifications` and `reports` use `job_id` as primary key so side effects can be idempotent via `ON CONFLICT (job_id)`.
- Changed: Docker Postgres moved from host port 5432 to 5433 (`docker-compose.yml`, `.env.example`, README) because a local Windows PostgreSQL service already held 5432.
- Verified: migrations applied to `scheduler` and `scheduler_test`, rerun applies nothing; `npm run seed` inserts 4 rows; manual SQL checks confirmed duplicate `notifications.job_id` rejected, `ON CONFLICT DO NOTHING` inserts 0 rows, duplicate `lease_id` rejected, invalid `outcome` rejected, FK enforced, claim query uses `jobs_claim_idx`. `npm test` still all todo.

## Step 2: API

- Claude Code generated: zod schemas per job type (`validation.js`), `insertJob` / `getJobById` / `listJobsByStatus` / `cancelJob` in the repository, the four routes, and `tests/globalSetup.js` (migrates the test DB before the suite).
- Design choices: cancel is a single guarded `UPDATE ... WHERE id = $1 AND status = 'QUEUED'`; a follow-up SELECT only distinguishes 404 from 409. Missing `scheduledAt` defaults to DB `now()`. `maxRetries` is required and capped at 100 so `1 + max_retries` cannot overflow; `priority` defaults to 0. Payloads are `strict()` so unknown keys are rejected.
- Also fixed in the scaffold: malformed JSON bodies and non-UUID ids returned 500, now 400; zod error messages now include the field path. Express 4 does not catch async errors, so routes use a small `asyncRoute` wrapper.
- Verified: `tests/jobs.api.test.js`, 19 passing (submission, invalid payloads, get/list, 404/400, cancel 200/404/409, 5 concurrent cancels yield exactly one 200). "Does not claim a cancelled job" stays todo until claim exists.
