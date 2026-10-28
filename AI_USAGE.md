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
- Tests: `tests/reaper.test.js` (requeue with backoff and reclaim under a new lease, permanent fail at `maxRetries = 0`, expiry and failure share one retry limit, nothing expired stays RUNNING while live leases are untouched, slow worker fenced after reap, locked row skipped then reaped next pass, 3 concurrent reapers never reap a job twice, batching drains 7 jobs with batch size 3). The 3 reaper todos moved here from `claim.test.js`.
- Verified by mutation: removing `SKIP LOCKED` fails the locked-row test; removing the expiry predicate fails 2 tests. The concurrent-reapers test still passed without `SKIP LOCKED`: `FOR UPDATE` alone prevents double reaping, `SKIP LOCKED` prevents blocking.
- Smoke test: `node src/worker/reaper.js` reaped a planted expired job in the dev DB. Graceful SIGINT/SIGTERM shutdown was not verified: on Windows, `child.kill('SIGTERM')` terminates the process without running handlers.
- `npm test`: 56 passed, 4 todo.

## Step 6: Worker and handlers

- Claude Code generated both handlers, `src/worker/simulation.js` (failure flags), and the worker: `processNextJob` (claim, run, record), lease renewal every `leaseDurationMs / 3`, `runWorker` / `stop` with graceful shutdown.
- Design choices: the handler's write and the fenced `completeJob` share one transaction. A failed renewal sets a flag checked before complete, because `completeJob` alone accepts an expired but unreaped lease. `simulateCrashAfterWork` throws `SimulatedCrashError`; the worker process turns it into `process.exit(1)` inside the open transaction, tests see a rejection.
- Bugs caught by the new tests and fixed: `runJob` passed `SimulatedCrashError` to `failJob` (a crash was recorded as a failure); the loop could wait a full poll interval after `stop()` landed during an empty claim. An idle-wake test based on timer counts was flaky (pg schedules its own timers) and was rewritten to spy on `setTimeout`.
- Tests: `execution.test.js` handler effects, empty sales, handler reruns leave one notification / one refreshed report. `tests/worker.test.js`: simulated failure, simulated crash then reaper to FAILED, run reaped and reclaimed mid-execution (handler blocked on a held `sales` lock) is discarded, renewal failure records nothing (fake `setInterval`), two concurrent workers run 5 jobs once each, stop() finishes the current job, stop() wakes an idle poll. No sleeps.
- Verified by mutation: removing the lease-lost check fails the renewal test; committing the side effect before complete fails the reaped-mid-run test. Full suite passed 3 consecutive runs.
- End-to-end smoke test (real API, worker, reaper processes on the dev DB): two jobs succeeded, the crash job's real `exit(1)` left no notification, the reaper marked it FAILED. Graceful Ctrl+C shutdown still unverified on Windows.
- `npm test`: 68 passed, 0 todo.

## Step 7: Test audit

- Claude Code mapped every `CLAUDE.md` coverage requirement to tests and ran a one-off coverage report (`@vitest/coverage-v8` installed with `--no-save`, then pruned; `package-lock.json` restored from git after npm rewrote one line).
- Added 13 tests, no production code changed: two attempts inserting the same notification concurrently (second waits on the unique key, then `DO NOTHING`, or inserts if the first rolls back); successful lease renewal while a handler runs (fake `setInterval`, DB expiry extended); backoff reaching and staying at the cap through `failJob`; `undefined` result stored as JSON null; job with an unknown type fails instead of crashing the worker; API priority at/past the INTEGER limit, `maxRetries` 100/101, `scheduledAt` without timezone or garbage, past `scheduledAt` claimable, non-JSON content type; cancel during retry backoff; 409 cancelling SUCCEEDED and FAILED.
- Static checks: no `new Date` / `Date.now` in `src`, no interpolated SQL in `src`, no `jobs.status` writes outside the repository. Renamed two test names that read as "exactly once" claims.
- Left uncovered on purpose: `recordFailure` when the job is reaped between handler failure and `failJob` (microsecond window, needs a test-only hook), the worker loop's DB-unreachable path, the unreachable 0-rows branch in `retryOrFail`, and process entry points (`server.js`, `reaper.js`, worker `isMain` block; exercised by the smoke tests instead).
- Coverage: repository 100% statements / 98% branches, handlers, validation, routes, retry policy 100%, worker 86% / 91%. `npm test`: 81 passed, 3 consecutive runs.

## Step 8: README

- Claude Code drafted the README engineering notes (architecture and schema, claim safety, leases and fencing, retry and idempotency, crash-point table, limitations, AI usage and verification) plus setup, configuration and API reference, from the implemented code and the test and mutation results recorded above.
- Checked against the code: claim SQL copied from `repository.js`, fence table matches each function's WHERE clause, test count (81) and mutation results match the runs logged in steps 3–7, and the only "exactly-once" wording is a negation.

## Step 9: Demo seed in the README

- Added `npm run seed:demo` to the setup commands and a paragraph describing what it writes: the four sales rows, then sample jobs in every status, replacing existing dev-database jobs. Noted that it skips `NODE_ENV=test` and that a running worker will claim the due jobs.
- No code or tests changed. Checked the paragraph against `src/db/seed.js` and `src/db/seedDemo.js`.
