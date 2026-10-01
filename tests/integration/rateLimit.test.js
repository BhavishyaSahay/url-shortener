import express from 'express';
import request from 'supertest';
// Concurrency tests get 15 s instead of Vitest's 5 s default: dozens of parallel
// requests can run slowly on a cold machine or a shared CI runner.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../../src/app.js';
import { connectRedis, redis } from '../../src/config/redis.js';
import { errorHandler } from '../../src/middleware/error.middleware.js';
import { rateLimit } from '../../src/middleware/rateLimiter.middleware.js';
import { loggedInAgent } from '../helpers/auth.js';
import { resetTables } from '../helpers/db.js';

// Test limits (vitest.config.js): login 5 per 15 min, URL creation 50 per minute.
const app = createApp();

beforeEach(resetTables);

const attemptLogin = (email = 'victim@example.com') =>
  request(app).post('/api/v1/auth/login').send({ email, password: 'wrong-guess' });

describe('POST /api/v1/auth/login rate limit', () => {
  it('allows 5 attempts, then returns 429 with Retry-After', async () => {
    for (let i = 1; i <= 5; i++) {
      const res = await attemptLogin();
      expect(res.status).toBe(401); // wrong password, but not limited yet
      expect(res.headers['ratelimit-remaining']).toBe(String(5 - i));
    }

    const blocked = await attemptLogin();
    expect(blocked.status).toBe(429);
    expect(blocked.body.error.code).toBe('RATE_LIMITED');
    expect(Number(blocked.headers['retry-after'])).toBeGreaterThan(0);
    expect(Number(blocked.headers['retry-after'])).toBeLessThanOrEqual(15 * 60);
  });

  it('blocks even the correct password once the limit is hit (no oracle for attackers)', async () => {
    await request(app).post('/api/v1/auth/register').send({ email: 'real@example.com', password: 'the-right-password' });
    for (let i = 0; i < 5; i++) await request(app).post('/api/v1/auth/login').send({ email: 'real@example.com', password: 'nope' });

    const res = await request(app).post('/api/v1/auth/login').send({ email: 'real@example.com', password: 'the-right-password' });
    expect(res.status).toBe(429);
  });

  it('counts per IP across different emails (stops credential stuffing)', async () => {
    for (let i = 0; i < 5; i++) await attemptLogin(`user${i}@example.com`);
    expect((await attemptLogin('someone-new@example.com')).status).toBe(429);
  });

  it('stores counters in Redis with an expiry, so they clean themselves up', async () => {
    await attemptLogin();
    const keys = await redis.keys('rl:login:*');
    expect(keys.some((k) => k.startsWith('rl:login:ip:'))).toBe(true);
    expect(keys.some((k) => k.startsWith('rl:login:email:'))).toBe(true);
    expect(keys.join()).not.toContain('victim@example.com'); // emails are hashed
    for (const key of keys) expect(await redis.ttl(key)).toBeGreaterThan(0);
  });
});

describe('POST /api/v1/urls rate limit', () => {
  it('limits each user separately', async () => {
    const [alice, bob] = await Promise.all([loggedInAgent(app), loggedInAgent(app)]);
    const create = (agent, i) => request(app).post('/api/v1/urls').set('Cookie', agent.cookie).send({ url: `https://example.com/${i}` });

    const results = await Promise.all(Array.from({ length: 50 }, (_, i) => create(alice, i)));
    expect(results.every((r) => r.status === 201)).toBe(true);

    expect((await create(alice, 51)).status).toBe(429);
    expect((await create(bob, 1)).status).toBe(201); // Bob has his own counter
  }, 15_000);

  it('counts atomically under concurrency: exactly `max` requests get through', async () => {
    const alice = await loggedInAgent(app);
    const results = await Promise.all(
      Array.from({ length: 60 }, (_, i) => request(app).post('/api/v1/urls').set('Cookie', alice.cookie).send({ url: `https://e.com/${i}` })),
    );
    const statuses = results.map((r) => r.status);
    expect(statuses.filter((s) => s === 201)).toHaveLength(50);
    expect(statuses.filter((s) => s === 429)).toHaveLength(10);
  }, 15_000);
});

describe('rateLimit middleware mechanics', () => {
  // A tiny app with a 1-second window, to test resets without waiting 15 minutes.
  function tinyApp() {
    const tiny = express();
    tiny.get('/limited', rateLimit({ name: 'test', max: 2, windowSeconds: 1, keyFn: () => 'client', message: 'slow down' }), (req, res) =>
      res.json({ ok: true }),
    );
    tiny.use(errorHandler);
    return tiny;
  }

  it('allows requests again once the window has passed', async () => {
    const tiny = tinyApp();
    // Start at the beginning of a fresh second so all three requests share a window.
    await new Promise((r) => setTimeout(r, 1000 - (Date.now() % 1000) + 20));
    expect((await request(tiny).get('/limited')).status).toBe(200);
    expect((await request(tiny).get('/limited')).status).toBe(200);
    expect((await request(tiny).get('/limited')).status).toBe(429);

    await new Promise((r) => setTimeout(r, 1100));
    expect((await request(tiny).get('/limited')).status).toBe(200);
  });

  describe('when Redis is down', () => {
    afterEach(async () => {
      await connectRedis();
    });

    it('fails open: requests are allowed rather than everyone being locked out', async () => {
      const tiny = tinyApp();
      redis.disconnect();
      for (let i = 0; i < 5; i++) {
        const res = await request(tiny).get('/limited');
        expect(res.status).toBe(200);
        expect(res.headers['ratelimit-limit']).toBeUndefined();
      }
    });
  });
});
