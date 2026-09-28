import cookieParser from 'cookie-parser';
import express from 'express';
import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { requireAuth } from '../../src/middleware/auth.middleware.js';
import { errorHandler } from '../../src/middleware/error.middleware.js';
import { signAccessToken } from '../../src/utils/jwt.js';

// Minimal app: one protected route that echoes req.user.
const app = express();
app.use(cookieParser());
app.get('/protected', requireAuth, (req, res) => res.json(req.user));
app.use(errorHandler);

describe('requireAuth middleware', () => {
  it('accepts a valid token from the access_token cookie', async () => {
    const res = await request(app).get('/protected').set('Cookie', `access_token=${signAccessToken(5)}`);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ id: 5 });
  });

  it('accepts a valid token from the Authorization: Bearer header', async () => {
    const res = await request(app).get('/protected').set('Authorization', `Bearer ${signAccessToken(9)}`);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ id: 9 });
  });

  it('returns 401 with no token', async () => {
    const res = await request(app).get('/protected');
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('UNAUTHORIZED');
  });

  it('returns 401 for an invalid token', async () => {
    const res = await request(app).get('/protected').set('Cookie', 'access_token=garbage');
    expect(res.status).toBe(401);
  });

  it('ignores non-Bearer Authorization schemes', async () => {
    const res = await request(app).get('/protected').set('Authorization', 'Basic dXNlcjpwYXNz');
    expect(res.status).toBe(401);
  });
});
