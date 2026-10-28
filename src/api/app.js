import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { ZodError } from 'zod';
import { AppError } from './errors.js';
import { jobsRouter } from './routes/jobs.js';

// Resolved from this file so `npm start` finds the page even if the process
// was not launched from the project root.
const publicDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../public');

export function createApp() {
  const app = express();
  app.use(express.json());

  app.get('/health', (_req, res) => {
    res.json({ ok: true });
  });

  app.use('/jobs', jobsRouter);
  app.use(express.static(publicDir));

  app.use((err, _req, res, _next) => {
    // Raised by express.json() for a body that is not valid JSON.
    if (err.type === 'entity.parse.failed') {
      res.status(400).json({ error: { code: 'BAD_REQUEST', message: 'Request body is not valid JSON' } });
      return;
    }
    if (err instanceof ZodError) {
      res.status(400).json({
        error: {
          code: 'BAD_REQUEST',
          message: err.issues
            .map((issue) => (issue.path.length ? `${issue.path.join('.')}: ${issue.message}` : issue.message))
            .join('; '),
        },
      });
      return;
    }
    if (err instanceof AppError) {
      res.status(err.status).json({ error: { code: err.code, message: err.message } });
      return;
    }
    console.error(err);
    res.status(500).json({ error: { code: 'INTERNAL', message: 'Internal server error' } });
  });

  return app;
}
