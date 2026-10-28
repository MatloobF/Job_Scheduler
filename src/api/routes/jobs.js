import { Router } from 'express';
import { AppError } from '../errors.js';

export const jobsRouter = Router();

function unavailable(name) {
  return (_req, _res, next) => {
    next(new AppError(501, 'NOT_IMPLEMENTED', `${name} is not implemented`));
  };
}

jobsRouter.post('/', unavailable('POST /jobs'));
jobsRouter.get('/', unavailable('GET /jobs'));
jobsRouter.get('/:id', unavailable('GET /jobs/:id'));
jobsRouter.post('/:id/cancel', unavailable('POST /jobs/:id/cancel'));
