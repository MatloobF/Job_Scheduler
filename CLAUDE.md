# CLAUDE.md

## Context

This is a **4-hour SDE-1 take-home assignment**: a job scheduling and execution platform. Clients submit background jobs; concurrent workers claim and execute them with leases, retries, crash recovery, and stale-worker protection.

I (the candidate) will be **interviewed on this code afterward**, with cross-questions on concurrency, crash scenarios, and edge cases. So:

- **Correctness over features.** A small, correct core beats many half-done features.
- **Explainability over cleverness.** Prefer plain, readable SQL and code that I can defend line by line. No magic libraries, ORMs that hide SQL, or abstractions I didn't ask for.
- **Work in small steps.** Implement one step, run its tests, stop and summarize. Do not jump ahead to later steps unprompted.

## Stack

- Node.js 22 (JavaScript, ES modules) + Express
- PostgreSQL 16 via Docker Compose (Postgres only; app and worker run locally)
- `pg` (node-postgres) with **raw SQL**. No ORM.
- `zod` for payload validation
- Vitest + supertest for tests, against a **real Postgres test database** (never mock the DB)

## Commands

```bash
cp .env.example .env
docker compose up -d          # start Postgres (creates scheduler + scheduler_test DBs)
npm install
npm run migrate               # apply SQL migrations in src/db/migrations
npm run seed                  # seed sample sales data
npm run dev                   # start API server
npm run worker                # start a worker (WORKER_ID env optional)
npm test                      # run full test suite
npx vitest run tests/<file>   # run a single test file
```

Config comes from `.env` (see `.env.example`). Never commit `.env` or any credentials.

## Project structure

```
src/
  config.js        lease duration, poll interval, reaper interval, backoff base/cap
  db/              pool.js (pool + withTransaction), migrate.js, migrations/*.sql, seed.js
  api/             app.js, server.js, routes/jobs.js, validation.js, errors.js
  jobs/            repository.js   # ALL job state transitions (claim, renew, complete, fail, cancel, reap)
                   retryPolicy.js  # backoff + retry-vs-fail decision
  worker/          worker.js (poll loop + lease renewal), reaper.js,
                   handlers/{sendNotification,generateReport}.js
tests/
README.md
AI_USAGE.md
```

Keep job state transitions in `src/jobs/repository.js` only. Routes and the worker call repository functions; they never write `jobs.status` directly. Use the existing `withTransaction` helper in `src/db/pool.js` for multi-statement operations.

## Schema (summary)

- `jobs` (exists in `001_create_jobs.sql`): id (uuid), type, payload (jsonb), priority (int, higher = sooner), status, scheduled_at, max_retries, attempts, lease_id (uuid), worker_id, lease_expires_at, last_error, result (jsonb), created_at, updated_at
  - CHECK status IN ('QUEUED','RUNNING','SUCCEEDED','FAILED','CANCELLED')
  - Add in a new migration: partial index for claiming `(priority DESC, scheduled_at) WHERE status = 'QUEUED'`
- `job_attempts`: job_id, attempt_no, lease_id, worker_id, started_at, finished_at, outcome ('RUNNING','SUCCEEDED','FAILED','LEASE_EXPIRED'), error
- `notifications`: UNIQUE(job_id), recipient, message, delivered_at
- `reports`: UNIQUE(job_id), summary columns
- `sales`: sample data for GENERATE_REPORT

Add new tables in new migration files (`002_...sql`, `003_...sql`). Never edit an applied migration.

## Non-negotiable invariants

These are the core of the assignment. Never violate them, and point it out if a change I request would.

1. **Atomic claim in the database.** Claim with a single `UPDATE ... WHERE id = (SELECT ... FOR UPDATE SKIP LOCKED LIMIT 1) RETURNING *`. Never SELECT in app code and then UPDATE.
2. **Eligibility:** only `status = 'QUEUED' AND scheduled_at <= now()`. Order by `priority DESC, scheduled_at ASC`.
3. **Database time only.** Use Postgres `now()` for every time comparison and timestamp. Never pass `new Date()` from the app into eligibility or lease logic. Backoff delays computed in JS are applied in SQL as `now() + ($n * interval '1 millisecond')`.
4. **Every claim gets a fresh `lease_id`** (`gen_random_uuid()`) and increments `attempts`.
5. **Fencing on every worker write.** renew, complete, and fail all include `WHERE id = $1 AND lease_id = $2 AND status = 'RUNNING'` (renew also requires `lease_expires_at > now()`). If `rowCount === 0`, throw `StaleLeaseError` and discard the result. Never "fix" a stale write by retrying without the lease check.
6. **All state transitions are guarded UPDATEs** with the expected current status in the WHERE clause. Cancel is `UPDATE ... WHERE id = $1 AND status = 'QUEUED'`; on 0 rows, return 404 if missing, else 409.
7. **Attempts semantics:** `attempts` = executions started. A job may run at most `1 + max_retries` times. Retry if `attempts < 1 + max_retries`, else permanent FAILED. Keep this exact rule consistent in fail() and the reaper.
8. **Expired lease counts as a failed attempt.** The reaper requeues (with backoff) or permanently fails, and marks the attempt `LEASE_EXPIRED`. Nothing may stay stuck in RUNNING.
9. **Backoff:** delay = `min(base * 2^(attempts-1), cap)`. Base and cap are configurable.
10. **Idempotent side effects.** Handlers write with `ON CONFLICT (job_id) DO NOTHING` / `DO UPDATE`. Where possible, run the handler's DB write and the fenced `complete` in **one transaction**, so a stale worker's side effect rolls back.
11. **Never claim exactly-once execution** in code comments or docs. The guarantee is **at-least-once execution with idempotent effects**.
12. Status/attempt changes and their `job_attempts` row update happen in the **same transaction**.

## Coding conventions

- Parameterized queries only (`$1, $2`). Never string-interpolate values into SQL.
- Errors: validation → 400, not found → 404, invalid state transition → 409, with a JSON body `{ error: { code, message } }`.
- Validate payloads per job type with zod; reject unknown types.
- Small functions, clear names, short comments explaining **why** (especially on SQL WHERE clauses). No dead code, no speculative features.
- Worker: renew lease every `leaseDuration / 3`; stop the renew timer in `finally`; if renewal fails, abort without writing a result. Handle SIGINT/SIGTERM by finishing the current job and not claiming new ones.
- Support failure injection via payload flags for tests and demo: `simulateFailure: true`, `simulateCrashAfterWork: true`.

## Testing rules

- Tests hit the real Postgres test DB (`DATABASE_URL_TEST`; `NODE_ENV=test` is set in `vitest.config.js`). Truncate tables before each test.
- **No sleeps for time-based logic.** Simulate expiry and due times by updating rows directly (e.g. set `lease_expires_at = now() - interval '1 second'`).
- Concurrency tests must actually run in parallel: `Promise.all` over multiple pool connections, and assert claimed IDs are unique.
- Required coverage: submission + invalid payloads, concurrent claiming, priority + scheduled time, success, retry limits + backoff (including boundary values like `max_retries = 0`), lease-expiry recovery, cancellation (including cancel vs. running), stale worker completion rejected, duplicate execution idempotency.
- Run the relevant tests after every change. Never weaken or delete a test to make it pass; report the failure instead.

## Workflow

- Follow the plan step by step: schema → API → claim → renew/complete/fail → reaper → worker + handlers → tests → README.
- After each step: run tests, give me a 3–5 line summary of what changed and **why it's safe under concurrency**, then suggest a commit message. Don't commit unless I ask.
- If something is ambiguous, ask instead of guessing.
- Don't add infrastructure (Kubernetes, queues, Redis, metrics stacks). Single machine, Postgres only.

## AI disclosure

Append a short entry to `AI_USAGE.md` after each step: what was generated, what I changed, and how it was verified (which tests). The README's AI section is built from this log.

## README must cover

1. Architecture and schema
2. Why concurrent claiming is safe (row locks + SKIP LOCKED + single-statement update)
3. Leases and fencing against stale workers
4. Retry and idempotency strategy
5. Crash-point table (after claim / mid-execution / after work before success / after success)
6. Known limitations and production improvements
7. AI tools used and verification

## Scaffold status

This tree is a skeleton. Do not treat it as a solution.

- Working already: config, `pg` pool, `withTransaction`, migration runner, Docker Compose, Express app shell, error shape, `StaleLeaseError`.
- Not implemented (each throws `Not implemented: <name>`): repository state transitions, retry policy, zod validation, job routes, worker loop, reaper, both handlers.
- `src/db/migrations/001_create_jobs.sql` is applied schema. Do not edit it. Add the claim index, `job_attempts`, `notifications`, `reports`, and `sales` as `002_...sql` onward.
- `npm run seed` expects `sales(id SERIAL PRIMARY KEY, category TEXT NOT NULL, amount NUMERIC NOT NULL)`. Match that in the sales migration.
- No starter repository was provided, so there is no planted bug to find. Do not invent one.
- Tests under `tests/` are `it.todo` placeholders. Replace each todo with a real test as you implement that behavior. `npm test` currently passes because every case is still a todo.
