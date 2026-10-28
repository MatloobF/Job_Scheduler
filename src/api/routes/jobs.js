import { Router } from 'express';
import { cancelJob, getJobById, insertJob, listJobsByStatus } from '../../jobs/repository.js';
import { conflict, notFound } from '../errors.js';
import { parseCreateJob, parseJobId, parseStatusQuery } from '../validation.js';

export const jobsRouter = Router();

// Express 4 does not forward rejected promises to the error handler.
function asyncRoute(handler) {
  return (req, res, next) => {
    handler(req, res).catch(next);
  };
}

// The API speaks camelCase; rows come back from Postgres in snake_case.
function serializeJob(row) {
  return {
    id: row.id,
    type: row.type,
    payload: row.payload,
    priority: row.priority,
    status: row.status,
    scheduledAt: row.scheduled_at,
    maxRetries: row.max_retries,
    attempts: row.attempts,
    workerId: row.worker_id,
    leaseExpiresAt: row.lease_expires_at,
    lastError: row.last_error,
    result: row.result,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

jobsRouter.post(
  '/',
  asyncRoute(async (req, res) => {
    const job = await insertJob(parseCreateJob(req.body));
    res.status(201).json(serializeJob(job));
  }),
);

jobsRouter.get(
  '/',
  asyncRoute(async (req, res) => {
    const jobs = await listJobsByStatus(parseStatusQuery(req.query));
    res.json(jobs.map(serializeJob));
  }),
);

jobsRouter.get(
  '/:id',
  asyncRoute(async (req, res) => {
    const job = await getJobById(parseJobId(req.params.id));
    if (!job) throw notFound();
    res.json(serializeJob(job));
  }),
);

jobsRouter.post(
  '/:id/cancel',
  asyncRoute(async (req, res) => {
    const { outcome, job } = await cancelJob(parseJobId(req.params.id));
    if (outcome === 'missing') throw notFound();
    if (outcome === 'not_queued') throw conflict(`Job is ${job.status} and cannot be cancelled`);
    res.json(serializeJob(job));
  }),
);
