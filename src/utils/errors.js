// Application errors. Services throw these; the error middleware turns them
// into consistent JSON responses. Anything that is NOT an AppError is treated
// as an unexpected bug and returned as a generic 500.

export class AppError extends Error {
  /**
   * @param {number} statusCode HTTP status code
   * @param {string} code       Stable machine-readable code clients can rely on
   * @param {string} message    Human-readable message (safe to show to clients)
   * @param {unknown} [details] Optional extra info, e.g. validation issues
   */
  constructor(statusCode, code, message, details) {
    super(message);
    this.name = this.constructor.name;
    this.statusCode = statusCode;
    this.code = code;
    this.details = details;
  }
}

export class ValidationError extends AppError {
  constructor(message = 'Invalid request', details) {
    super(400, 'VALIDATION_ERROR', message, details);
  }
}

export class UnauthorizedError extends AppError {
  constructor(message = 'Authentication required') {
    super(401, 'UNAUTHORIZED', message);
  }
}

export class ForbiddenError extends AppError {
  constructor(message = 'You do not have permission to perform this action') {
    super(403, 'FORBIDDEN', message);
  }
}

export class NotFoundError extends AppError {
  constructor(message = 'Resource not found') {
    super(404, 'NOT_FOUND', message);
  }
}

export class ConflictError extends AppError {
  constructor(message = 'Resource already exists') {
    super(409, 'CONFLICT', message);
  }
}

export class GoneError extends AppError {
  constructor(message = 'Resource is no longer available') {
    super(410, 'GONE', message);
  }
}

export class TooManyRequestsError extends AppError {
  constructor(message = 'Too many requests, please try again later', retryAfterSeconds) {
    super(429, 'RATE_LIMITED', message);
    this.retryAfterSeconds = retryAfterSeconds;
  }
}
