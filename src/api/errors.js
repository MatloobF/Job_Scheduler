export class AppError extends Error {
  constructor(status, code, message) {
    super(message);
    this.name = 'AppError';
    this.status = status;
    this.code = code;
  }
}

export class StaleLeaseError extends AppError {
  constructor(message = 'Lease is no longer valid for this job') {
    super(409, 'STALE_LEASE', message);
    this.name = 'StaleLeaseError';
  }
}

export function badRequest(message) {
  return new AppError(400, 'BAD_REQUEST', message);
}

export function notFound(message = 'Job not found') {
  return new AppError(404, 'NOT_FOUND', message);
}

export function conflict(message) {
  return new AppError(409, 'CONFLICT', message);
}

export function notImplemented(name) {
  const error = new Error(`Not implemented: ${name}`);
  error.code = 'NOT_IMPLEMENTED';
  return error;
}
