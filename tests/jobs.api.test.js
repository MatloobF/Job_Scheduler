import request from 'supertest';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/api/app.js';
import { closePool, pool } from '../src/db/pool.js';
import { truncateAll } from './helpers.js';

const app = createApp();

const notificationJob = {
  type: 'SEND_NOTIFICATION',
  payload: { recipient: 'a@example.com', message: 'hello' },
  priority: 5,
  maxRetries: 2,
};

async function createJob(body = notificationJob) {
  const res = await request(app).post('/jobs').send(body);
  expect(res.status).toBe(201);
  return res.body;
}

beforeEach(truncateAll);
afterAll(closePool);

describe('job submission', () => {
  it('creates a QUEUED job and returns its id', async () => {
    const job = await createJob();

    expect(job.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(job).toMatchObject({ status: 'QUEUED', attempts: 0, priority: 5, maxRetries: 2 });

    const { rows } = await pool.query('SELECT status, payload FROM jobs WHERE id = $1', [job.id]);
    expect(rows[0]).toEqual({ status: 'QUEUED', payload: notificationJob.payload });
  });

  it('defaults priority to 0 and scheduled_at to the database time', async () => {
    const job = await createJob({ type: 'GENERATE_REPORT', payload: {}, maxRetries: 0 });

    const { rows } = await pool.query(
      'SELECT priority, scheduled_at <= now() AS due FROM jobs WHERE id = $1',
      [job.id],
    );
    expect(rows[0]).toEqual({ priority: 0, due: true });
  });

  it('stores a client-supplied scheduledAt', async () => {
    const job = await createJob({ ...notificationJob, scheduledAt: '2030-01-01T00:00:00Z' });
    expect(new Date(job.scheduledAt).toISOString()).toBe('2030-01-01T00:00:00.000Z');
  });

  it('rejects an unknown job type', async () => {
    const res = await request(app).post('/jobs').send({ ...notificationJob, type: 'MINE_BITCOIN' });

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('BAD_REQUEST');
  });

  it('rejects a SEND_NOTIFICATION payload without recipient or message', async () => {
    const noRecipient = await request(app)
      .post('/jobs')
      .send({ ...notificationJob, payload: { message: 'hello' } });
    const noMessage = await request(app)
      .post('/jobs')
      .send({ ...notificationJob, payload: { recipient: 'a@example.com' } });

    expect(noRecipient.status).toBe(400);
    expect(noRecipient.body.error.message).toContain('payload.recipient');
    expect(noMessage.status).toBe(400);
    expect(noMessage.body.error.message).toContain('payload.message');
  });

  it('rejects unknown payload keys', async () => {
    const res = await request(app)
      .post('/jobs')
      .send({ ...notificationJob, payload: { ...notificationJob.payload, simulateFailur: true } });
    expect(res.status).toBe(400);
  });

  it('rejects a negative maxRetries', async () => {
    const res = await request(app).post('/jobs').send({ ...notificationJob, maxRetries: -1 });
    expect(res.status).toBe(400);
    expect(res.body.error.message).toContain('maxRetries');
  });

  it('rejects a missing maxRetries and a non-integer priority', async () => {
    const { maxRetries: _omitted, ...withoutRetries } = notificationJob;
    const missing = await request(app).post('/jobs').send(withoutRetries);
    const fractional = await request(app).post('/jobs').send({ ...notificationJob, priority: 1.5 });

    expect(missing.status).toBe(400);
    expect(fractional.status).toBe(400);
  });

  it('rejects a body that is not valid JSON', async () => {
    const res = await request(app)
      .post('/jobs')
      .set('Content-Type', 'application/json')
      .send('{"type":');

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('BAD_REQUEST');
  });

  it('gets a job by id', async () => {
    const created = await createJob();

    const res = await request(app).get(`/jobs/${created.id}`);

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ id: created.id, type: 'SEND_NOTIFICATION', status: 'QUEUED' });
  });

  it('returns 404 for an unknown id', async () => {
    const res = await request(app).get('/jobs/00000000-0000-0000-0000-000000000000');

    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('NOT_FOUND');
  });

  it('returns 400 for an id that is not a UUID', async () => {
    const res = await request(app).get('/jobs/not-a-uuid');
    expect(res.status).toBe(400);
  });

  it('lists jobs filtered by status', async () => {
    const kept = await createJob();
    const cancelled = await createJob();
    await request(app).post(`/jobs/${cancelled.id}/cancel`).expect(200);

    const queued = await request(app).get('/jobs?status=QUEUED');
    const all = await request(app).get('/jobs');

    expect(queued.status).toBe(200);
    expect(queued.body.map((job) => job.id)).toEqual([kept.id]);
    expect(all.body).toHaveLength(2);
  });

  it('rejects an unknown status filter', async () => {
    const res = await request(app).get('/jobs?status=DONE');
    expect(res.status).toBe(400);
  });
});

describe('cancellation', () => {
  it('cancels a QUEUED job', async () => {
    const job = await createJob();

    const res = await request(app).post(`/jobs/${job.id}/cancel`);

    expect(res.status).toBe(200);
    expect(res.body.status).toBe('CANCELLED');
  });

  it('returns 404 when cancelling an unknown job', async () => {
    const res = await request(app).post('/jobs/00000000-0000-0000-0000-000000000000/cancel');
    expect(res.status).toBe(404);
  });

  it('returns 409 when cancelling a RUNNING job', async () => {
    const job = await createJob();
    // Stand-in for a claim until claimNextJob exists; tests may set up state directly.
    await pool.query(`UPDATE jobs SET status = 'RUNNING' WHERE id = $1`, [job.id]);

    const res = await request(app).post(`/jobs/${job.id}/cancel`);

    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('CONFLICT');
    const after = await request(app).get(`/jobs/${job.id}`);
    expect(after.body.status).toBe('RUNNING');
  });

  it('returns 409 when cancelling an already cancelled job', async () => {
    const job = await createJob();
    await request(app).post(`/jobs/${job.id}/cancel`).expect(200);

    const res = await request(app).post(`/jobs/${job.id}/cancel`);
    expect(res.status).toBe(409);
  });

  it('lets exactly one of several concurrent cancels succeed', async () => {
    const job = await createJob();

    const responses = await Promise.all(
      Array.from({ length: 5 }, () => request(app).post(`/jobs/${job.id}/cancel`)),
    );

    const statuses = responses.map((res) => res.status).sort();
    expect(statuses).toEqual([200, 409, 409, 409, 409]);
  });

  it.todo('does not claim a cancelled job');
});
