// Errors with an HTTP status. Services throw these; the error middleware turns
// them into JSON responses. Any other error is treated as a bug → 500.
export class AppError extends Error {
  constructor(statusCode, code, message, details) {
    super(message);
    this.statusCode = statusCode;
    this.code = code;
    this.details = details;
  }
}

export const ValidationError = (message, details) => new AppError(400, 'VALIDATION_ERROR', message, details);
export const UnauthorizedError = (message = 'Authentication required') => new AppError(401, 'UNAUTHORIZED', message);
export const NotFoundError = (message = 'Not found') => new AppError(404, 'NOT_FOUND', message);
export const ConflictError = (message) => new AppError(409, 'CONFLICT', message);
export const GoneError = (message) => new AppError(410, 'GONE', message);

export function TooManyRequestsError(retryAfterSeconds) {
  const err = new AppError(429, 'RATE_LIMITED', 'Too many requests, please try again later');
  err.retryAfterSeconds = retryAfterSeconds;
  return err;
}

// Prisma error codes
export const isUniqueViolation = (err) => err?.code === 'P2002'; // unique constraint failed
export const isRecordNotFound = (err) => err?.code === 'P2025'; // update/delete matched no row
