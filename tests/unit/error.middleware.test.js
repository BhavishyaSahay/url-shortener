import express from 'express';
import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { errorHandler, notFoundHandler } from '../../src/middleware/error.middleware.js';
import { ConflictError, TooManyRequestsError } from '../../src/utils/errors.js';

// A tiny app with routes that fail in different ways, so the error middleware
// can be tested in isolation from the real routes.
function buildTestApp() {
  const app = express();
  app.get('/conflict', () => {
    throw new ConflictError('Alias already taken');
  });
  app.get('/rate-limited', () => {
    throw new TooManyRequestsError(undefined, 42);
  });
  app.get('/async-bug', async () => {
    throw new Error('database password is hunter2');
  });
  app.use(notFoundHandler);
  app.use(errorHandler);
  return app;
}

describe('error middleware', () => {
  const app = buildTestApp();

  it('maps AppError to its status code and a JSON body', async () => {
    const res = await request(app).get('/conflict');
    expect(res.status).toBe(409);
    expect(res.body).toEqual({ error: { code: 'CONFLICT', message: 'Alias already taken' } });
  });

  it('sets Retry-After on rate-limit errors', async () => {
    const res = await request(app).get('/rate-limited');
    expect(res.status).toBe(429);
    expect(res.headers['retry-after']).toBe('42');
  });

  it('catches errors thrown in async handlers (Express 5) as 500', async () => {
    const res = await request(app).get('/async-bug');
    expect(res.status).toBe(500);
    expect(res.body.error.code).toBe('INTERNAL_ERROR');
  });

  it('returns 404 JSON for unknown routes', async () => {
    const res = await request(app).get('/nope');
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('NOT_FOUND');
  });
});
