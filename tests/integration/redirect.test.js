import request from 'supertest';
import { beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../../src/app.js';
import { connectRedis, redis } from '../../src/config/redis.js';
import { loggedInAgent } from '../helpers/auth.js';
import { prisma, resetState } from '../helpers/db.js';

const app = createApp();
let alice;
let link;

beforeEach(async () => {
  await resetState();
  alice = await loggedInAgent(app);
  link = (await alice.post('/api/v1/urls').send({ url: 'https://example.com/page' })).body.url;
});

const visit = (code) => request(app).get(`/${code}`);

describe('redirects', () => {
  it('redirects with 302 to the original URL', async () => {
    const res = await visit(link.shortCode);
    expect(res.status).toBe(302);
    expect(res.headers.location).toBe('https://example.com/page');
  });

  it('returns 404 for an unknown code', async () => {
    expect((await visit('doesNotExist')).status).toBe(404);
  });

  it('returns 410 for a deactivated or expired link', async () => {
    await alice.patch(`/api/v1/urls/${link.id}`).send({ isActive: false });
    expect((await visit(link.shortCode)).status).toBe(410);

    await prisma.url.update({ where: { id: link.id }, data: { isActive: true, expiresAt: new Date(Date.now() - 1000) } });
    await redis.flushdb();
    expect((await visit(link.shortCode)).status).toBe(410);
  });
});

describe('Redis cache (cache-aside)', () => {
  it('first visit is a MISS, the next is a HIT served from Redis', async () => {
    expect((await visit(link.shortCode)).headers['x-cache']).toBe('MISS');
    expect((await visit(link.shortCode)).headers['x-cache']).toBe('HIT');
    expect(await redis.ttl(`url:${link.shortCode}`)).toBeGreaterThan(3500); // 1-hour TTL
  });

  it('updating a link removes it from the cache, so the change applies immediately', async () => {
    await visit(link.shortCode); // cache it
    await alice.patch(`/api/v1/urls/${link.id}`).send({ url: 'https://example.com/new' });

    const res = await visit(link.shortCode);
    expect(res.headers['x-cache']).toBe('MISS');
    expect(res.headers.location).toBe('https://example.com/new');
  });

  it('still redirects when Redis is down', async () => {
    redis.disconnect();
    const res = await visit(link.shortCode);
    expect(res.status).toBe(302);
    await connectRedis();
  });
});
