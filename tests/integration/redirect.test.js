import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createApp } from '../../src/app.js';
import { connectRedis, redis } from '../../src/config/redis.js';
import { loggedInAgent } from '../helpers/auth.js';
import { prisma, resetTables } from '../helpers/db.js';

const app = createApp();
let alice;

beforeEach(async () => {
  await resetTables();
  alice = await loggedInAgent(app);
});

afterEach(() => {
  vi.useRealTimers();
});

async function createLink(body) {
  const res = await alice.post('/api/v1/urls').send(body);
  expect(res.status).toBe(201);
  return res.body.url;
}
const visit = (code) => request(app).get(`/${code}`);

describe('GET /:shortCode: redirect', () => {
  it('redirects with 302 to the original URL', async () => {
    const link = await createLink({ url: 'https://example.com/products/this-is-a-very-long-url' });

    const res = await visit(link.shortCode);

    expect(res.status).toBe(302);
    expect(res.headers.location).toBe('https://example.com/products/this-is-a-very-long-url');
    expect(res.headers['cache-control']).toBe('private, no-store');
  });

  it('works for custom aliases', async () => {
    await createLink({ url: 'https://example.com/promo', customAlias: 'promo-2026' });
    const res = await visit('promo-2026');
    expect(res.status).toBe(302);
    expect(res.headers.location).toBe('https://example.com/promo');
  });

  it('returns 404 for a short code that does not exist', async () => {
    const res = await visit('doesNotExist');
    expect(res.status).toBe(404);
    expect(res.body.error.message).toBe('Short link not found');
  });

  it('returns 404 without touching Redis for paths that cannot be short codes', async () => {
    for (const path of ['favicon.ico', 'a'.repeat(33), 'bad%20code']) {
      expect((await visit(path)).status).toBe(404);
    }
    expect(await redis.dbsize()).toBe(0);
  });

  it('returns 410 Gone for a deactivated link', async () => {
    const link = await createLink({ url: 'https://example.com' });
    await alice.patch(`/api/v1/urls/${link.id}`).send({ isActive: false });

    const res = await visit(link.shortCode);
    expect(res.status).toBe(410);
    expect(res.body.error.message).toContain('deactivated');
  });

  it('returns 410 Gone for an expired link', async () => {
    const link = await createLink({ url: 'https://example.com' });
    await prisma.url.update({ where: { id: link.id }, data: { expiresAt: new Date(Date.now() - 1000) } });

    const res = await visit(link.shortCode);
    expect(res.status).toBe(410);
    expect(res.body.error.message).toContain('expired');
  });

  it('does not shadow the fixed routes', async () => {
    expect((await request(app).get('/health')).body.status).toBe('ok');
    expect((await request(app).get('/ready')).status).toBe(200);
  });
});

describe('cache-aside behaviour', () => {
  it('first visit is a MISS (from PostgreSQL), later visits are HITs (from Redis)', async () => {
    const link = await createLink({ url: 'https://example.com' });

    const first = await visit(link.shortCode);
    const second = await visit(link.shortCode);

    expect(first.headers['x-cache']).toBe('MISS');
    expect(second.headers['x-cache']).toBe('HIT');
    expect(second.headers.location).toBe(first.headers.location);
  });

  it('stores the decision fields as JSON with a TTL', async () => {
    const link = await createLink({ url: 'https://example.com' });
    await visit(link.shortCode);

    const cached = JSON.parse(await redis.get(`url:${link.shortCode}`));
    expect(cached).toEqual({ id: link.id, originalUrl: 'https://example.com', isActive: true, expiresAt: null });

    const ttl = await redis.ttl(`url:${link.shortCode}`);
    expect(ttl).toBeGreaterThan(3500); // URL_CACHE_TTL = 1h
    expect(ttl).toBeLessThanOrEqual(3600);
  });

  it('really serves HITs from Redis: a change made behind the app\'s back is not seen until invalidation', async () => {
    const link = await createLink({ url: 'https://old.example.com' });
    await visit(link.shortCode); // cache it

    // Edit PostgreSQL directly, bypassing the API (so no invalidation happens).
    await prisma.url.update({ where: { id: link.id }, data: { originalUrl: 'https://sneaky.example.com' } });
    expect((await visit(link.shortCode)).headers.location).toBe('https://old.example.com');
  });

  it('invalidates the cache when the owner updates the link', async () => {
    const link = await createLink({ url: 'https://old.example.com' });
    await visit(link.shortCode);
    expect(await redis.exists(`url:${link.shortCode}`)).toBe(1);

    await alice.patch(`/api/v1/urls/${link.id}`).send({ url: 'https://new.example.com' });
    expect(await redis.exists(`url:${link.shortCode}`)).toBe(0);

    const res = await visit(link.shortCode);
    expect(res.headers['x-cache']).toBe('MISS');
    expect(res.headers.location).toBe('https://new.example.com');
  });

  it('invalidates the cache on deactivate and delete', async () => {
    const link = await createLink({ url: 'https://example.com' });
    await visit(link.shortCode);

    await alice.patch(`/api/v1/urls/${link.id}`).send({ isActive: false });
    expect((await visit(link.shortCode)).status).toBe(410);

    await alice.patch(`/api/v1/urls/${link.id}`).send({ isActive: true });
    expect((await visit(link.shortCode)).status).toBe(302);

    await alice.delete(`/api/v1/urls/${link.id}`);
    expect((await visit(link.shortCode)).status).toBe(404);
  });

  it('re-checks expiry on cache HITs, so a cached link stops working at the exact expiry time', async () => {
    const expiresAt = new Date(Date.now() + 60 * 60 * 1000); // in 1 hour
    const link = await createLink({ url: 'https://example.com', expiresAt: expiresAt.toISOString() });
    await visit(link.shortCode); // cached, with a TTL longer than... nothing: expiry is inside the value

    // Jump the clock past expiresAt (only Date is faked; network timers stay real).
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(expiresAt.getTime() + 1000);

    const res = await visit(link.shortCode);
    expect(res.status).toBe(410);
  });

  it('caches "not found" briefly (negative caching) to protect PostgreSQL', async () => {
    const first = await visit('ghost123');
    const second = await visit('ghost123');

    expect(first.headers['x-cache']).toBeUndefined(); // errors don't set X-Cache
    expect(second.status).toBe(404);
    expect(JSON.parse(await redis.get('url:ghost123'))).toEqual({ missing: true });

    const ttl = await redis.ttl('url:ghost123');
    expect(ttl).toBeGreaterThan(0);
    expect(ttl).toBeLessThanOrEqual(60); // URL_NEGATIVE_CACHE_TTL = 60s
  });

  it('clears a negative entry when that alias is created, so the new link works immediately', async () => {
    expect((await visit('brand-new')).status).toBe(404); // caches "missing"

    await createLink({ url: 'https://example.com/new', customAlias: 'brand-new' });

    const res = await visit('brand-new');
    expect(res.status).toBe(302);
    expect(res.headers.location).toBe('https://example.com/new');
  });
});

describe('when Redis is down', () => {
  afterEach(async () => {
    await connectRedis(); // restore for later tests
  });

  it('still redirects, straight from PostgreSQL (X-Cache: BYPASS)', async () => {
    const link = await createLink({ url: 'https://example.com' });

    redis.disconnect(); // simulate an outage
    const res = await visit(link.shortCode);

    expect(res.status).toBe(302);
    expect(res.headers.location).toBe('https://example.com');
    expect(res.headers['x-cache']).toBe('BYPASS');
  });

  it('still lets users create and manage links', async () => {
    redis.disconnect();
    const res = await alice.post('/api/v1/urls').send({ url: 'https://example.com' });
    expect(res.status).toBe(201);
  });

  it('reports "degraded" (but still 200) on /ready', async () => {
    redis.disconnect();
    const res = await request(app).get('/ready');
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('degraded');
    expect(res.body.checks).toMatchObject({ database: 'up', redis: 'down' });
  });
});
