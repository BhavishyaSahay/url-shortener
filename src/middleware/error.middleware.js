import { config } from '../config/env.js';
import { AppError, NotFoundError } from '../utils/errors.js';

// Runs when no route matched. Passing the error to next() sends it to errorHandler.
export function notFoundHandler(req, res, next) {
  next(new NotFoundError(`Route ${req.method} ${req.path} not found`));
}

// Central error handler. Express recognises it as an error handler because it
// takes four arguments. Express 5 also sends rejected promises from async route
// handlers here, so controllers don't need try/catch.
// eslint-disable-next-line no-unused-vars
export function errorHandler(err, req, res, next) {
  const normalized = normalizeError(err);

  // Expected client errors (4xx) are logged at warn level by pino-http based on
  // the status code. Unexpected errors get the full error object and stack.
  if (normalized.statusCode >= 500) {
    req.log?.error({ err }, 'Unhandled error');
  }

  if (normalized.retryAfterSeconds) {
    res.set('Retry-After', String(normalized.retryAfterSeconds));
  }

  const body = {
    error: {
      code: normalized.code,
      message: normalized.message,
      ...(normalized.details !== undefined && { details: normalized.details }),
      ...(req.id && { requestId: req.id }),
    },
  };

  res.status(normalized.statusCode).json(body);
}

function normalizeError(err) {
  if (err instanceof AppError) return err;

  // Errors raised by express.json() when parsing the request body.
  if (err?.type === 'entity.parse.failed') {
    return new AppError(400, 'INVALID_JSON', 'Request body contains invalid JSON');
  }
  if (err?.type === 'entity.too.large') {
    return new AppError(413, 'PAYLOAD_TOO_LARGE', 'Request body is too large');
  }

  // Unknown error = a bug. Don't leak internal messages or stack traces in production.
  const message = config.isProduction ? 'Internal server error' : err?.message || 'Internal server error';
  return new AppError(500, 'INTERNAL_ERROR', message);
}
