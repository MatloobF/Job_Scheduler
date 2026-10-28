# Job scheduler

A small job scheduling and execution platform on Node.js and PostgreSQL. Clients submit background jobs over HTTP. Concurrent workers claim them atomically, hold them under a renewable lease, retry failures with exponential backoff, and recover from crashed or stalled workers.

The guarantee is **at-least-once execution with idempotent effects**. A job may run more than once (for example after a crash), but its side effect is written at most once per job.

## Setup

Requires Node.js 22, Docker, and npm.

```bash
cp .env.example .env          # Windows cmd: copy .env.example .env
docker compose up -d          # Postgres 16 with databases scheduler and scheduler_test
npm install
npm run migrate               # applies src/db/migrations/*.sql in order
npm run seed                  # sample sales rows for GENERATE_REPORT
npm run dev                   # API on PORT (default 3000)
npm run worker                # a worker; set WORKER_ID to run several
npm run reaper                # the lease reaper
npm test                      # full suite against scheduler_test
```

Postgres is published on **`localhost:5433`**, not 5432, so it does not clash with a locally installed PostgreSQL. Credentials for local use are in `.env.example`. `.env` is git-ignored.

Stop the worker or reaper with Ctrl+C. The worker finishes its current job and claims nothing new. The reaper finishes its current pass.

### Configuration (`.env`)

| Variable | Default | Meaning |
| --- | --- | --- |
| `LEASE_DURATION_MS` | 30000 | Lease length. The worker renews every third of it (10 s). |
| `POLL_INTERVAL_MS` | 1000 | Worker wait when no job is eligible. |
| `REAPER_INTERVAL_MS` | 5000 | Pause between reaper passes. |
| `BACKOFF_BASE_MS` / `BACKOFF_CAP_MS` | 1000 / 60000 | Retry delay `min(base * 2^(attempts-1), cap)`. |

### API

| Method and path | Success | Errors |
| --- | --- | --- |
| `POST /jobs` | 201 with the job | 400 invalid body, unknown type, bad payload |
| `GET /jobs?status=QUEUED` | 200, newest first, at most 100 | 400 unknown status |
| `GET /jobs/:id` | 200 | 400 id is not a UUID, 404 |
| `POST /jobs/:id/cancel` | 200 with the cancelled job | 400, 404, 409 if the job is not QUEUED |

Errors always have the shape `{ "error": { "code", "message" } }`.

```bash
curl -X POST localhost:3000/jobs -H 'content-type: application/json' -d '{
  "type": "SEND_NOTIFICATION",
  "payload": { "recipient": "a@example.com", "message": "hello" },
  "priority": 5,
  "maxRetries": 2
}'
```

| Field | Rules |
| --- | --- |
| `type` | `SEND_NOTIFICATION` or `GENERATE_REPORT` |
| `payload` | `SEND_NOTIFICATION`: `recipient`, `message` (non-empty strings). `GENERATE_REPORT`: `{}`. Both accept `simulateFailure` and `simulateCrashAfterWork` booleans. Unknown keys are rejected. |
| `priority` | Integer within Postgres `INTEGER`, default 0. Higher runs first. |
| `maxRetries` | Required integer, 0 to 100. The cap keeps `1 + max_retries` from overflowing. |
| `scheduledAt` | Optional ISO 8601 timestamp with a timezone. Defaults to the database's `now()`. |

## Engineering notes

### 1. Architecture and schema

```
  clients ──HTTP──► API (Express)            worker × N            reaper
                      │ insert / read /       │ claim, renew,        │ expired leases →
                      │ guarded cancel        │ complete, fail       │ requeue or fail
                      ▼                       ▼                      ▼
                 ┌──────────────── PostgreSQL (single source of truth) ───────────────┐
                 │ jobs · job_attempts · notifications · reports · sales               │
                 └─────────────────────────────────────────────────────────────────────┘
```

The API, any number of workers, and the reaper are separate processes that share nothing but the database. All coordination happens through row locks and guarded `UPDATE` statements. There is no in-memory queue, no leader election and no extra infrastructure.

Every change to `jobs.status` lives in [`src/jobs/repository.js`](src/jobs/repository.js). Routes, the worker and the reaper call repository functions and never write the status themselves. SQL is raw and parameterised (`pg`, no ORM).

**Job lifecycle**

```
            claim                complete
  QUEUED ──────────► RUNNING ──────────────► SUCCEEDED
    ▲  │                │
    │  │ cancel         │ fail or lease expiry
    │  ▼                ├── attempts < 1 + max_retries ──► QUEUED (scheduled_at = now() + backoff)
    │ CANCELLED         └── otherwise ───────────────────► FAILED
    └───────────────────────┘
```

**Schema** (migrations `001`–`006`)

| Table | Purpose | Constraints that matter |
| --- | --- | --- |
| `jobs` | Current state: type, payload, priority, status, `scheduled_at`, `max_retries`, `attempts`, lease fields, `last_error`, `result` | Status CHECK. Partial index `(priority DESC, scheduled_at) WHERE status = 'QUEUED'` serves the claim query and does not grow with finished jobs. |
| `job_attempts` | One row per execution: worker, lease, start and finish time, outcome (`RUNNING`, `SUCCEEDED`, `FAILED`, `LEASE_EXPIRED`), error | PK `(job_id, attempt_no)`. `lease_id` UNIQUE, so each attempt maps to exactly one claim. |
| `notifications` | Side effect of `SEND_NOTIFICATION` | `job_id` primary key: at most one per job. |
| `reports` | Side effect of `GENERATE_REPORT`: row count, total, per-category totals | `job_id` primary key: at most one per job. |
| `sales` | Sample input for reports | |

The lease fields (`lease_id`, `worker_id`, `lease_expires_at`) are set **only while a job is RUNNING**. Every transition out of RUNNING clears them. The per-run history lives in `job_attempts`.

### 2. Why concurrent claiming is safe

```sql
UPDATE jobs
SET status = 'RUNNING', attempts = attempts + 1, lease_id = gen_random_uuid(),
    worker_id = $1, lease_expires_at = now() + ($2 * interval '1 millisecond'), updated_at = now()
WHERE id = (
  SELECT id FROM jobs
  WHERE status = 'QUEUED' AND scheduled_at <= now()
  ORDER BY priority DESC, scheduled_at ASC
  LIMIT 1
  FOR UPDATE SKIP LOCKED
)
RETURNING *;
```

- **One statement picks and claims.** The subquery chooses the job and the outer `UPDATE` claims it, so there is no window between "read" and "write" in application code.
- **`FOR UPDATE` row-locks the chosen job** until the transaction commits. No other claim, cancel or reaper can change it in the meantime.
- **`SKIP LOCKED` sends concurrent claimers to the next unlocked job.** With plain `FOR UPDATE`, they would queue behind the locked row. When it committed, they would re-check it, see RUNNING, and return nothing, even though other jobs were waiting.
- **Eligibility uses only the database clock** (`scheduled_at <= now()`), so app servers with skewed clocks cannot disagree.
- The `job_attempts` row is inserted **in the same transaction**, so a job is never RUNNING without its attempt record.

**Cancel racing a claim.** Cancel is `UPDATE ... WHERE id = $1 AND status = 'QUEUED'`. If a claim holds the row lock, the cancel waits for it. When the claim commits, Postgres re-checks the cancel's `WHERE` against the new row, finds RUNNING, and the cancel matches 0 rows (409). If the cancel goes first, the claim's `status = 'QUEUED'` filter skips the row. Exactly one wins.

**Evidence.**
- Tests run 2 and 20 parallel claimers against 1 and 10 jobs; claimed ids are always unique.
- A deterministic test holds a row lock on one job and asserts the claim takes the other one immediately.
- Mutation checks:
  - Removing `SKIP LOCKED` fails the held-lock test.
  - Removing the row lock entirely produces 20 "successful" claims for 10 jobs.

### 3. Leases and stale-worker fencing

Each claim issues a fresh `lease_id`, which acts as a fencing token. Every worker write repeats the full fence in its `WHERE` clause. If it matches 0 rows, the write throws `StaleLeaseError` and its result is discarded.

| Operation | Fence | Why |
| --- | --- | --- |
| `renewLease` | `id`, `lease_id`, `status = 'RUNNING'`, **`lease_expires_at > now()`** | Once a lease has lapsed, the job belongs to the reaper. A late heartbeat must not revive it. |
| `completeJob` | `id`, `lease_id`, `status = 'RUNNING'` | No expiry check: if the lease lapsed but nobody reaped or reclaimed the job, `lease_id` is still ours and no one else is running it. |
| `failJob` | `id`, `lease_id`, `status = 'RUNNING'` (read under `FOR UPDATE`, then repeated in the `UPDATE`) | The backoff needs `attempts`. The row lock guarantees nothing changes between the read and the update. |

- **Renewal.** While the handler runs, the worker renews every `leaseDuration / 3`, so two renewals in a row can fail before the lease expires. The timer is cleared in `finally`.
- **When a renewal fails,** JavaScript cannot interrupt the running handler. The worker sets a flag and **checks it before `completeJob`**. This closes the one case the fence leaves open: an expired, not-yet-reaped lease that `completeJob` alone would accept.
- **A stale worker can't do damage.** Suppose a worker was paused, its job was reaped and another worker reclaimed it. When it resumes, its `renew`, `complete` and `fail` all miss the fence. Because its side effect and its `completeJob` share one transaction, the side effect rolls back too. Tests cover this end to end: a handler is blocked on a held lock while the job is reaped and reclaimed underneath it.
- **Clocks.** All expiry decisions are `lease_expires_at` compared with Postgres `now()`. The worker's local timers only decide *when to try* renewing; they never decide whether a lease is valid.

### 4. Retry and idempotency strategy

**Retry rule.** `attempts` counts executions started; it is incremented at claim time. A job may run at most `1 + max_retries` times:

| `max_retries` | Failing attempt | Result |
| --- | --- | --- |
| 0 | 1st | FAILED |
| 2 | 1st, 2nd | QUEUED with backoff |
| 2 | 3rd | FAILED |

- **Backoff** is `min(base * 2^(attempts-1), cap)`. With the defaults that's 1 s, 2 s, 4 s … 32 s, then 60 s.
- **Where the delay is computed and applied.** It's computed in JS ([`retryPolicy.js`](src/jobs/retryPolicy.js)) and applied in SQL as `now() + (delay * interval '1 millisecond')`. It is never computed from the app's clock.
- **A lease expiry counts as a failed attempt.** `failJob` and the reaper call the same internal helper (`retryOrFail`), so they cannot drift apart on this rule. An expired run was already counted at claim time, so the reaper does not increment `attempts` again.

**Idempotent effects.** There are three layers:
1. **One effect per job.** `notifications.job_id` and `reports.job_id` are primary keys. Handlers write with `ON CONFLICT (job_id) DO NOTHING` (notification) or `DO UPDATE` (report, which refreshes the same row).
2. **The effect shares the fence's transaction.** The handler's write and the fenced `completeJob` commit together or not at all. A crashed or stale attempt leaves no side effect behind.
3. **Concurrent duplicates serialize on the unique key.** If two attempts insert the same `job_id` at once, Postgres makes the second wait for the first. If the first commits, the second does nothing. If it rolls back, the second inserts. Either way, one row. Both outcomes are tested deterministically.

**Failure injection.** `simulateFailure: true` throws before any work. `simulateCrashAfterWork: true` writes the side effect, then crashes. In the worker process that crash is a real `process.exit(1)` inside the open transaction: no commit and no rollback message. Tests see it as a rejected promise.

### 5. Crash points

| Point | What is persisted | What happens next |
| --- | --- | --- |
| After claim, before work | Job RUNNING with `attempts + 1`, a new `lease_id` and `lease_expires_at`. Attempt row `RUNNING`. | No more renewals arrive, so the lease expires. The reaper marks the attempt `LEASE_EXPIRED` and requeues with backoff, or sets FAILED if retries are used up. Another worker then claims it under a new lease. |
| Mid-execution | The same as above. The handler's writes are in an open transaction that was never committed. | Postgres discards the transaction when the connection drops. Recovery is the same as the previous row. If the worker was only stalled, not dead, its later writes miss the fence and roll back. |
| After the side effect, before success is recorded | Nothing new. The side effect and `completeJob` are in one transaction, so a crash before `COMMIT` loses both. | The same recovery. The next attempt writes the side effect once. This was demonstrated with real processes: a worker killed by `simulateCrashAfterWork` left no notification, and the reaper took over. `COMMIT` is atomic, so there is no state where the effect is saved but the job isn't SUCCEEDED. |
| After success is recorded | Job SUCCEEDED with `result`, lease fields cleared, side-effect row, attempt `SUCCEEDED`. | Nothing. The job is never eligible again, and any late write from that worker misses the fence. |

Two related cases: the **reaper** keeps no state of its own, so if it crashes, the next pass (or another reaper) picks up. An **API** crash during `POST /jobs` either inserted the row or didn't, because the insert is a single statement.

### 6. Known limitations and production improvements

- **Side effects live in the same database.** That is what makes the single-transaction design possible. A real email or HTTP call cannot join a Postgres transaction. You would pass the job id (or attempt id) to the provider as an idempotency key, or use a transactional outbox: commit an outbox row with the completion, then deliver it separately.
- **A handler runs inside a database transaction.** Both handlers are short, so this is fine here. Long work would hold a connection and transaction open. You would do the work outside, then record and complete in a short fenced transaction.
- **Polling.** Idle workers query every `POLL_INTERVAL_MS`. `LISTEN/NOTIFY` would cut both latency and idle load. The reaper also polls, so a dead worker's job waits up to the lease duration plus `REAPER_INTERVAL_MS` before it's recovered.
- **A lost lease cannot preempt the handler.** The result is discarded, but the work runs to completion. A real system would pass a cancellation signal (`AbortSignal`) into handlers.
- **No API for operators.** You can't cancel a RUNNING job, there's no dead-letter view, no manual retry, no auth and no rate limiting. `GET /jobs` returns at most 100 rows, with no pagination.
- **Growth.** Finished jobs and attempt rows are kept forever. The partial claim index keeps claiming fast, but you would add archival or partitioning.
- **Scale.** Postgres is a single point of failure, and claiming is one job per round trip. Batch claiming (`LIMIT n`) and a replica for reads would be the next steps.
- **Observability** is console logging only. You would add metrics for queue depth, claim latency, retries and reaps.
- **Not covered by automated tests:**
  - A job reaped in the microseconds between its handler failing and `failJob` (the code path exists and returns `stale`).
  - The worker loop's "database unreachable" path.
  - Graceful Ctrl+C shutdown of the real processes. `stop()` is tested in-process; on Windows, a child process cannot be sent a catchable SIGTERM, so check it manually.

### 7. AI tools and verification

I built this with **Claude Code**, one step at a time: schema, API, claim, renew/complete/fail, reaper, worker and handlers, test audit, README. Each step was explained before implementation, reviewed, tested and committed separately. I made the design choices at each step:
- One migration file per table.
- Claim plus attempt row as two statements in one transaction.
- `completeJob` takes an optional client so it can share the handler's transaction.
- Reaper batches of 100.
- Crash simulation as a thrown error that the worker process turns into a real exit.

The per-step log is in [`AI_USAGE.md`](AI_USAGE.md).

How the generated code was checked:

- **81 tests against a real Postgres database** (no mocks). Concurrency tests run in parallel on separate connections. Time is simulated by updating rows (`lease_expires_at = now() - 1 second`), never by sleeping. Mid-run interleavings are created by holding real row and table locks, and waiting until `pg_stat_activity` shows the blocked query.
- **Mutation checks:** each critical line was deliberately broken to confirm a test fails.

  | Broken | Caught by |
  | --- | --- |
  | `SKIP LOCKED` removed from claim | held-lock claim test |
  | Row lock removed from claim | 20-claimer test (duplicate claims) |
  | `lease_id` removed from complete's fence | 3 stale-worker tests |
  | `shouldRetry` changed to `<=` | 4 retry-boundary tests |
  | `SKIP LOCKED` removed from reaper | held-lock reaper test |
  | Expiry check removed from reaper | 2 reaper tests |
  | Lease-lost check removed from worker | renewal-failure test |
  | Side effect committed before complete | reaped-mid-run test |

  The 2-claimer race test alone did **not** catch a missing row lock: race tests are evidence, not proof. The deterministic held-lock tests are the stronger check. Concurrent reapers also never double-reaped without `SKIP LOCKED`: `FOR UPDATE` provides correctness, `SKIP LOCKED` provides non-blocking behaviour.
- **Bugs caught during development:**
  - A simulated crash was being recorded as an ordinary failure.
  - The worker could wait a full poll interval after `stop()`.
  - `pg` turned JS arrays into Postgres arrays in `result`.
  - Malformed JSON and non-UUID ids returned 500.

  Each is fixed and covered by a test.
- **Static checks:**
  - No `new Date` or `Date.now` in `src`.
  - No SQL built by pasting values into strings.
  - No `jobs.status` writes outside the repository.
  - No exactly-once claims.
- **Coverage (one-off run):** repository 100% of statements and 98% of branches; handlers, validation, routes and retry policy 100%; worker 86% / 91%.
- **End-to-end smoke test with the real processes:**
  - Two jobs were submitted over HTTP and both succeeded.
  - A third job's worker died for real in `simulateCrashAfterWork`, leaving no notification. The reaper then marked it FAILED (`maxRetries: 0`).

**Test map**

| Requirement | Tests |
| --- | --- |
| Submission and invalid payloads | `jobs.api.test.js` › job submission |
| Concurrent claiming | `claim.test.js` › atomic claim |
| Priority and scheduled time | `claim.test.js` › atomic claim |
| Success | `execution.test.js` › execution, `worker.test.js` |
| Retry limits and backoff, incl. `max_retries = 0` and the cap | `execution.test.js` › retries, `retryPolicy.test.js` |
| Lease-expiry recovery | `reaper.test.js` |
| Cancellation, incl. cancel vs. running and cancel vs. claim | `jobs.api.test.js` › cancellation |
| Stale worker completion rejected | `claim.test.js` › leases, `execution.test.js` › idempotency, `reaper.test.js`, `worker.test.js` |
| Duplicate execution idempotency, sequential and concurrent | `execution.test.js` › idempotency |
| Crash, renewal, shutdown | `worker.test.js` |
