import { config } from '../config/env.js';
import { AppError, NotFoundError } from '../utils/errors.js';

export function notFoundHandler(req, res, next) {
  next(NotFoundError(`Route ${req.method} ${req.path} not found`));
}

// Central error handler (Express knows it's one because it takes 4 arguments).
// Express 5 also sends errors thrown in async route handlers here.
// eslint-disable-next-line no-unused-vars
export function errorHandler(err, req, res, next) {
  let error = err;
  if (err?.type === 'entity.parse.failed') error = new AppError(400, 'INVALID_JSON', 'Request body contains invalid JSON');
  if (!(error instanceof AppError)) {
    req.log?.error({ err }, 'Unhandled error');
    // Don't leak internal details in production.
    error = new AppError(500, 'INTERNAL_ERROR', config.isProduction ? 'Internal server error' : err.message);
  }

  if (error.retryAfterSeconds) res.set('Retry-After', String(error.retryAfterSeconds));
  res.status(error.statusCode).json({
    error: { code: error.code, message: error.message, ...(error.details && { details: error.details }) },
  });
}
