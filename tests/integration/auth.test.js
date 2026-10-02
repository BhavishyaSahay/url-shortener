import request from 'supertest';
import { beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../../src/app.js';
import { prisma, resetState } from '../helpers/db.js';

const app = createApp();
const alice = { email: 'alice@example.com', password: 'correct-horse-battery' };
const register = (body = alice) => request(app).post('/api/v1/auth/register').send(body);
const login = (body = alice) => request(app).post('/api/v1/auth/login').send(body);

beforeEach(resetState);

describe('register', () => {
  it('creates the user, never returns the password hash, and sets an HTTP-only cookie', async () => {
    const res = await register();
    expect(res.status).toBe(201);
    expect(res.body.user).toEqual({ id: 1, email: 'alice@example.com', createdAt: expect.any(String) });
    expect(res.headers['set-cookie'][0]).toMatch(/access_token=.+HttpOnly; SameSite=Lax/);
  });

  it('stores an Argon2id hash, not the password', async () => {
    await register();
    const user = await prisma.user.findUnique({ where: { email: alice.email } });
    expect(user.passwordHash).toMatch(/^\$argon2id\$/);
  });

  it('returns 409 for an email that is already registered', async () => {
    await register();
    expect((await register({ ...alice, email: 'ALICE@example.com' })).status).toBe(409);
  });

  it('returns 400 for invalid input', async () => {
    expect((await register({ email: 'nope', password: '1' })).status).toBe(400);
  });
});

describe('login, me, logout', () => {
  beforeEach(() => register());

  it('logs in with the right password', async () => {
    const res = await login();
    expect(res.status).toBe(200);
    expect(res.headers['set-cookie'][0]).toMatch(/^access_token=/);
  });

  it('gives the same 401 for a wrong password and an unknown email', async () => {
    const wrongPassword = await login({ ...alice, password: 'wrong-password' });
    const unknownEmail = await login({ email: 'nobody@example.com', password: 'whatever' });
    expect(wrongPassword.status).toBe(401);
    expect(unknownEmail.body).toEqual(wrongPassword.body);
  });

  it('GET /me needs the cookie, and logout clears it', async () => {
    const agent = request.agent(app);
    await agent.post('/api/v1/auth/login').send(alice);
    expect((await agent.get('/api/v1/auth/me')).body.user.email).toBe(alice.email);

    expect((await agent.post('/api/v1/auth/logout')).status).toBe(204);
    expect((await agent.get('/api/v1/auth/me')).status).toBe(401);
  });

  it('rejects a forged token', async () => {
    const res = await request(app).get('/api/v1/auth/me').set('Cookie', 'access_token=not.a.jwt');
    expect(res.status).toBe(401);
  });
});
