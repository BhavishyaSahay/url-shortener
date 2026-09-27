import { describe, expect, it } from 'vitest';
import {
  AppError,
  ConflictError,
  NotFoundError,
  TooManyRequestsError,
  ValidationError,
} from '../../src/utils/errors.js';

describe('AppError subclasses', () => {
  it.each([
    [new ValidationError(), 400, 'VALIDATION_ERROR'],
    [new NotFoundError(), 404, 'NOT_FOUND'],
    [new ConflictError(), 409, 'CONFLICT'],
    [new TooManyRequestsError(), 429, 'RATE_LIMITED'],
  ])('%o has the right status and code', (err, statusCode, code) => {
    expect(err).toBeInstanceOf(AppError);
    expect(err).toBeInstanceOf(Error);
    expect(err.statusCode).toBe(statusCode);
    expect(err.code).toBe(code);
  });

  it('keeps custom messages and details', () => {
    const err = new ValidationError('Bad URL', [{ field: 'url' }]);
    expect(err.message).toBe('Bad URL');
    expect(err.details).toEqual([{ field: 'url' }]);
    expect(err.name).toBe('ValidationError');
  });

  it('carries Retry-After information for rate limiting', () => {
    expect(new TooManyRequestsError(undefined, 30).retryAfterSeconds).toBe(30);
  });
});
