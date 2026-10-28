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

## Step 3: Atomic claim

- Claude Code generated `claimNextJob`: one `UPDATE ... WHERE id = (SELECT ... FOR UPDATE SKIP LOCKED LIMIT 1) RETURNING *` plus the `job_attempts` insert, both inside `withTransaction` (two statements chosen over a CTE for readability).
- Tests: `tests/claim.test.js` atomic-claim section (2 and 20 parallel claimers, deterministic SKIP LOCKED test holding a row lock, lease id + attempts, attempt row, DB-clock lease expiry, priority, scheduled_at ordering, future jobs, non-QUEUED statuses). API tests now use a real claim for the 409 case, plus "does not claim a cancelled job" and a cancel-vs-claim race.
- Verified by mutation: removing `SKIP LOCKED` fails the locked-row test; removing the row lock entirely fails it and the 20-claimer test (20 "successful" claims for 10 jobs). The 2-claimer race test alone did not catch it, so it is evidence, not proof. The first mutation run hung the suite, so the locked-row test now has a 2 s watchdog that turns a block into a failure.
- `npm test`: 30 passed, 15 todo.

## Step 4: Renew, complete, fail, retry policy

- Claude Code generated `backoffDelayMs` / `shouldRetry`, `renewLease`, `completeJob` (optional `client` so a handler's write can share its transaction), `failJob`, and an internal `retryOrFail` helper that the reaper will reuse so both apply the same retry rule.
- Design choices: renew requires `lease_expires_at > now()` (a lapsed lease is never revived); complete does not (an unreaped lease is still ours). `failJob` does a fenced `SELECT ... FOR UPDATE` to read `attempts` for the JS backoff, then a fenced UPDATE. Lease fields are cleared whenever a job leaves RUNNING. Results are passed as `JSON.stringify(...)::jsonb` because pg turns JS arrays into Postgres arrays.
- Tests: `tests/retryPolicy.test.js` (boundaries, cap); `claim.test.js` renew, expired renew, stale renew/complete/fail after the lease id changes, writes after the job left RUNNING; `execution.test.js` success + attempt row, array result, expired-but-unreaped complete, retry boundary with `maxRetries` 2 and 0, exact backoff delay from DB time, attempt history, stale complete rejected, stale side effect rolled back.
- Verified by mutation: removing `lease_id = $2` from complete fails 3 stale-worker tests; changing `shouldRetry` to `<=` fails 4 boundary tests. `npm test`: 47 passed, 7 todo.

## Step 5: Reaper

- Claude Code generated `reapExpiredLeases(batchSize = 100)`: per batch, one transaction that selects `status = 'RUNNING' AND lease_expires_at <= now()` with `FOR UPDATE SKIP LOCKED`, then applies the shared `retryOrFail` helper with outcome `LEASE_EXPIRED`. Loops until a batch comes back short. `src/worker/reaper.js` runs it on `reaperIntervalMs`, scheduling each pass after the previous one finishes, logging and continuing on errors.
- Design choices: the expired run already counted as an attempt at claim, so the reaper does not increment `attempts`; it shares the retry rule with `failJob`. Clearing `lease_id` fences off a slow worker immediately.
- Tests: `tests/reaper.test.js` (requeue with backoff and reclaim under a new lease, permanent fail at `maxRetries = 0`, expiry and failure share one retry limit, nothing expired stays RUNNING while live leases are untouched, slow worker fenced after reap, locked row skipped then reaped next pass, 3 concurrent reapers reap 10 jobs exactly once, batching drains 7 jobs with batch size 3). The 3 reaper todos moved here from `claim.test.js`.
- Verified by mutation: removing `SKIP LOCKED` fails the locked-row test; removing the expiry predicate fails 2 tests. The concurrent-reapers test still passed without `SKIP LOCKED`: `FOR UPDATE` alone prevents double reaping, `SKIP LOCKED` prevents blocking.
- Smoke test: `node src/worker/reaper.js` reaped a planted expired job in the dev DB. Graceful SIGINT/SIGTERM shutdown was not verified: on Windows, `child.kill('SIGTERM')` terminates the process without running handlers.
- `npm test`: 56 passed, 4 todo.
