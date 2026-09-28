import jwt from 'jsonwebtoken';
import request from 'supertest';
import { beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../../src/app.js';
import { prisma, resetTables } from '../helpers/db.js';

const app = createApp();
const credentials = { email: 'alice@example.com', password: 'correct-horse-battery' };

const register = (body = credentials) => request(app).post('/api/v1/auth/register').send(body);
const login = (body = credentials) => request(app).post('/api/v1/auth/login').send(body);
const authCookie = (res) => res.headers['set-cookie']?.find((c) => c.startsWith('access_token='));

beforeEach(resetTables);

describe('POST /api/v1/auth/register', () => {
  it('creates the user, returns it without the password hash, and logs them in', async () => {
    const res = await register({ email: '  Alice@Example.com ', password: credentials.password });

    expect(res.status).toBe(201);
    expect(res.body.user).toEqual({ id: expect.any(Number), email: 'alice@example.com', createdAt: expect.any(String) });
    expect(JSON.stringify(res.body)).not.toMatch(/password/i);
    expect(authCookie(res)).toBeDefined();
  });

  it('sets a secure-by-default auth cookie', async () => {
    const cookie = authCookie(await register());
    expect(cookie).toMatch(/HttpOnly/);
    expect(cookie).toMatch(/SameSite=Lax/);
    expect(cookie).toMatch(/Path=\//);
    expect(cookie).toMatch(/Max-Age=86400/); // matches JWT_EXPIRES_IN=1d
  });

  it('stores an Argon2id hash, never the plaintext password', async () => {
    await register();
    const row = await prisma.user.findUnique({ where: { email: credentials.email } });
    expect(row.passwordHash).toMatch(/^\$argon2id\$/);
    expect(row.passwordHash).not.toContain(credentials.password);
  });

  it('returns 409 for an email that is already registered (case-insensitive)', async () => {
    await register();
    const res = await register({ ...credentials, email: 'ALICE@example.com' });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('CONFLICT');
  });

  it('lets exactly one of several simultaneous sign-ups with the same email succeed', async () => {
    // A "check then insert" implementation fails this test: all requests can pass the
    // check before any of them inserts. The unique index makes it atomic.
    const results = await Promise.all(Array.from({ length: 5 }, () => register()));
    const statuses = results.map((r) => r.status).sort();

    expect(statuses).toEqual([201, 409, 409, 409, 409]);
    expect(await prisma.user.count()).toBe(1);
  });

  it('returns 400 with field details for invalid input', async () => {
    const res = await register({ email: 'nope', password: '123' });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
    expect(res.body.error.details.map((d) => d.field).sort()).toEqual(['email', 'password']);
  });

  it('marks auth responses as non-cacheable', async () => {
    const res = await register();
    expect(res.headers['cache-control']).toBe('no-store');
  });
});

describe('POST /api/v1/auth/login', () => {
  beforeEach(async () => {
    await register();
  });

  it('logs in with the right password and sets the auth cookie', async () => {
    const res = await login({ email: 'ALICE@example.com', password: credentials.password });
    expect(res.status).toBe(200);
    expect(res.body.user.email).toBe(credentials.email);
    expect(authCookie(res)).toBeDefined();
  });

  it('returns 401 for a wrong password, without setting a cookie', async () => {
    const res = await login({ ...credentials, password: 'wrong-password' });
    expect(res.status).toBe(401);
    expect(authCookie(res)).toBeUndefined();
  });

  it('gives the SAME response for an unknown email as for a wrong password (no user enumeration)', async () => {
    const wrongPassword = await login({ ...credentials, password: 'wrong-password' });
    const unknownEmail = await login({ email: 'nobody@example.com', password: 'whatever' });

    expect(unknownEmail.status).toBe(wrongPassword.status);
    expect(unknownEmail.body.error.message).toBe(wrongPassword.body.error.message);
    expect(unknownEmail.body.error.message).toBe('Invalid email or password');
  });

  it('returns 400 for a missing password', async () => {
    const res = await login({ email: credentials.email });
    expect(res.status).toBe(400);
  });
});

describe('GET /api/v1/auth/me', () => {
  it('returns the logged-in user when the cookie is sent', async () => {
    const agent = request.agent(app); // keeps cookies between requests, like a browser
    await agent.post('/api/v1/auth/register').send(credentials);

    const res = await agent.get('/api/v1/auth/me');
    expect(res.status).toBe(200);
    expect(res.body.user.email).toBe(credentials.email);
  });

  it('returns 401 without a token', async () => {
    const res = await request(app).get('/api/v1/auth/me');
    expect(res.status).toBe(401);
  });

  it('returns 401 for an expired token', async () => {
    const { body } = await register();
    const expired = jwt.sign({}, process.env.JWT_SECRET, { subject: String(body.user.id), issuer: 'url-shortener', expiresIn: -1 });

    const res = await request(app).get('/api/v1/auth/me').set('Cookie', `access_token=${expired}`);
    expect(res.status).toBe(401);
  });

  it('returns 401 when the token is valid but the user was deleted', async () => {
    const res = await register();
    const cookie = authCookie(res).split(';')[0];
    await prisma.user.delete({ where: { id: res.body.user.id } });

    const me = await request(app).get('/api/v1/auth/me').set('Cookie', cookie);
    expect(me.status).toBe(401);
  });
});

describe('POST /api/v1/auth/logout', () => {
  it('clears the cookie so later requests are unauthenticated', async () => {
    const agent = request.agent(app);
    await agent.post('/api/v1/auth/register').send(credentials);
    expect((await agent.get('/api/v1/auth/me')).status).toBe(200);

    const res = await agent.post('/api/v1/auth/logout');
    expect(res.status).toBe(204);
    expect(authCookie(res)).toMatch(/Expires=Thu, 01 Jan 1970/);

    expect((await agent.get('/api/v1/auth/me')).status).toBe(401);
  });

  it('is safe to call when not logged in', async () => {
    const res = await request(app).post('/api/v1/auth/logout');
    expect(res.status).toBe(204);
  });
});
