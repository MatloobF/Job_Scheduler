# Job scheduler

Small job scheduling and execution platform. Clients submit background jobs. Workers claim and run them with leases, retries, and recovery after a crash.

This repository is a scaffold. Job submission, claiming, leases, retries, and handlers are not implemented yet. There was no starter repository, so there is no planted bug in this tree.

## Setup

Requires Node.js 22, Docker, and npm.

```bash
copy .env.example .env
docker compose up -d
npm install
npm run migrate
npm run dev
```

`npm run seed` inserts sample `sales` rows. It fails until a later migration creates `sales(id SERIAL PRIMARY KEY, category TEXT NOT NULL, amount NUMERIC NOT NULL)`.

`npm run worker` and `npm run reaper` exit with a message until those loops are implemented.

`npm test` runs Vitest. The current tests are placeholders (`it.todo`) and do not need Postgres. Real tests must use `DATABASE_URL_TEST` and `tests/helpers.js` to truncate tables. Do not sleep to simulate time.

Postgres listens on `localhost:5433`. The Compose file creates `scheduler` and `scheduler_test`. Local credentials are in `.env.example`. Do not commit `.env`.

## What to implement

Follow `CLAUDE.md` in order: schema, API, claim, renew/complete/fail, reaper, worker and handlers, tests, then the notes below.

## Engineering notes

Fill these in after the behavior exists. Describe this codebase, not a design you have not built.

### 1. Architecture and schema

TODO

### 2. Why concurrent claiming is safe

TODO

### 3. Leases and stale-worker fencing

TODO

### 4. Retry and idempotency strategy

TODO

### 5. Crash points

| Point | What is persisted | What happens next |
| --- | --- | --- |
| After claim, before work | TODO | TODO |
| Mid-execution | TODO | TODO |
| After the side effect, before success is recorded | TODO | TODO |
| After success is recorded | TODO | TODO |

The execution guarantee to document is at-least-once execution with idempotent effects.

### 6. Known limitations and production improvements

TODO

### 7. AI tools and verification

See `AI_USAGE.md`.
