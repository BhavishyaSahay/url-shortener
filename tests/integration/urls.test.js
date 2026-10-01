import request from 'supertest';
// Concurrency tests get 15 s instead of Vitest's 5 s default: dozens of parallel
// requests can run slowly on a cold machine or a shared CI runner.
import { beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../../src/app.js';
import { encode } from '../../src/utils/base62.js';
import { loggedInAgent } from '../helpers/auth.js';
import { prisma, resetTables } from '../helpers/db.js';

const app = createApp();
const nextYear = `${new Date().getUTCFullYear() + 1}-12-31T00:00:00.000Z`;

let alice;
let bob;

beforeEach(async () => {
  await resetTables();
  [alice, bob] = await Promise.all([loggedInAgent(app, 'alice@example.com'), loggedInAgent(app, 'bob@example.com')]);
});

const createUrl = (agent, body) => agent.post('/api/v1/urls').send(body);
// Independent request per call: used for the concurrency tests.
const createUrlConcurrently = (agent, body) => request(app).post('/api/v1/urls').set('Cookie', agent.cookie).send(body);

describe('POST /api/v1/urls', () => {
  it('creates a short URL whose code is the Base62 encoding of its database ID', async () => {
    const res = await createUrl(alice, { url: 'https://example.com/products/this-is-a-very-long-url' });

    expect(res.status).toBe(201);
    const { url } = res.body;
    expect(url).toMatchObject({
      originalUrl: 'https://example.com/products/this-is-a-very-long-url',
      isCustomAlias: false,
      isActive: true,
      expiresAt: null,
      status: 'active',
    });
    expect(url.shortCode).toBe(encode(url.id));
    expect(url.shortUrl).toBe(`http://localhost:3000/${url.shortCode}`);
    expect(res.headers.location).toBe(`/api/v1/urls/${url.id}`);
  });

  it('creates a URL with a custom alias and an expiry date', async () => {
    const res = await createUrl(alice, { url: 'https://example.com', customAlias: 'my-link', expiresAt: nextYear });

    expect(res.status).toBe(201);
    expect(res.body.url).toMatchObject({ shortCode: 'my-link', isCustomAlias: true, expiresAt: nextYear, status: 'active' });
  });

  it('returns 409 when the alias is taken, even by another user', async () => {
    await createUrl(alice, { url: 'https://a.com', customAlias: 'taken' });
    const res = await createUrl(bob, { url: 'https://b.com', customAlias: 'taken' });

    expect(res.status).toBe(409);
    expect(res.body.error.message).toContain('taken');
  });

  it('treats aliases as case-sensitive ("Promo" and "promo" are different links)', async () => {
    expect((await createUrl(alice, { url: 'https://a.com', customAlias: 'Promo' })).status).toBe(201);
    expect((await createUrl(alice, { url: 'https://b.com', customAlias: 'promo' })).status).toBe(201);
  });

  it.each([
    [{ url: 'not-a-url' }, 'url'],
    [{ url: 'javascript:alert(1)' }, 'url'],
    [{ url: 'https://a.com', customAlias: 'no spaces' }, 'customAlias'],
    [{ url: 'https://a.com', customAlias: 'health' }, 'customAlias'],
    [{ url: 'https://a.com', expiresAt: '2020-01-01T00:00:00Z' }, 'expiresAt'],
    [{}, 'url'],
  ])('returns 400 for %o', async (body, field) => {
    const res = await createUrl(alice, body);
    expect(res.status).toBe(400);
    expect(res.body.error.details.map((d) => d.field)).toContain(field);
  });

  it('returns 401 when not logged in', async () => {
    const res = await request(app).post('/api/v1/urls').send({ url: 'https://a.com' });
    expect(res.status).toBe(401);
  });

  it('skips a generated code that collides with an existing custom alias', async () => {
    // Make the next sequence value predictable, then pre-claim its code as an alias.
    await prisma.$queryRaw`SELECT setval('urls_id_seq', 5000)`; // next nextval() = 5001
    await prisma.url.create({
      data: { id: 1, userId: bob.user.id, shortCode: encode(5001), originalUrl: 'https://bob.com', isCustomAlias: true },
    });

    const res = await createUrl(alice, { url: 'https://alice.com' });

    expect(res.status).toBe(201);
    expect(res.body.url.id).toBe(5002); // 5001 was skipped
    expect(res.body.url.shortCode).toBe(encode(5002));
  });

  it('generates unique codes for many simultaneous requests', async () => {
    const results = await Promise.all(Array.from({ length: 25 }, (_, i) => createUrlConcurrently(alice, { url: `https://example.com/${i}` })));

    expect(results.every((r) => r.status === 201)).toBe(true);
    const codes = results.map((r) => r.body.url.shortCode);
    expect(new Set(codes).size).toBe(25);
  }, 15_000);

  it('lets exactly one of several simultaneous requests claim the same alias', async () => {
    const results = await Promise.all(
      Array.from({ length: 5 }, (_, i) =>
        createUrlConcurrently(i % 2 ? alice : bob, { url: 'https://a.com', customAlias: 'race' }),
      ),
    );
    expect(results.map((r) => r.status).sort()).toEqual([201, 409, 409, 409, 409]);
  }, 15_000);
});

describe('GET /api/v1/urls', () => {
  it('lists only the caller\'s URLs, newest first, with pagination', async () => {
    for (let i = 1; i <= 5; i++) await createUrl(alice, { url: `https://alice.com/${i}` });
    await createUrl(bob, { url: 'https://bob.com' });

    const page1 = await alice.get('/api/v1/urls?limit=2');
    expect(page1.status).toBe(200);
    expect(page1.body.urls.map((u) => u.originalUrl)).toEqual(['https://alice.com/5', 'https://alice.com/4']);
    expect(page1.body.pagination).toEqual({ page: 1, limit: 2, total: 5, totalPages: 3 });

    const page3 = await alice.get('/api/v1/urls?limit=2&page=3');
    expect(page3.body.urls.map((u) => u.originalUrl)).toEqual(['https://alice.com/1']);

    const bobs = await bob.get('/api/v1/urls');
    expect(bobs.body.urls).toHaveLength(1);
  });

  it('returns 400 for invalid pagination', async () => {
    expect((await alice.get('/api/v1/urls?limit=500')).status).toBe(400);
  });
});

describe('GET /api/v1/urls/:id', () => {
  it('returns the caller\'s URL', async () => {
    const { body } = await createUrl(alice, { url: 'https://a.com' });
    const res = await alice.get(`/api/v1/urls/${body.url.id}`);
    expect(res.status).toBe(200);
    expect(res.body.url.id).toBe(body.url.id);
  });

  it('returns 404 (not 403) for another user\'s URL, so its existence is not revealed', async () => {
    const { body } = await createUrl(alice, { url: 'https://a.com' });
    const res = await bob.get(`/api/v1/urls/${body.url.id}`);
    expect(res.status).toBe(404);
    expect(res.body.error.message).toBe('URL not found');
  });

  it('returns 404 for a nonexistent ID and 400 for a malformed one', async () => {
    expect((await alice.get('/api/v1/urls/999999')).status).toBe(404);
    expect((await alice.get('/api/v1/urls/abc')).status).toBe(400);
    expect((await alice.get('/api/v1/urls/99999999999')).status).toBe(400); // beyond INTEGER range
  });

  it('reports status "expired" once expiresAt has passed', async () => {
    const { body } = await createUrl(alice, { url: 'https://a.com', expiresAt: nextYear });
    await prisma.url.update({ where: { id: body.url.id }, data: { expiresAt: new Date(Date.now() - 1000) } });

    const res = await alice.get(`/api/v1/urls/${body.url.id}`);
    expect(res.body.url.status).toBe('expired');
  });
});

describe('PATCH /api/v1/urls/:id', () => {
  let urlId;
  beforeEach(async () => {
    urlId = (await createUrl(alice, { url: 'https://old.com', expiresAt: nextYear })).body.url.id;
  });

  it('deactivates a URL', async () => {
    const res = await alice.patch(`/api/v1/urls/${urlId}`).send({ isActive: false });
    expect(res.status).toBe(200);
    expect(res.body.url).toMatchObject({ isActive: false, status: 'inactive' });
  });

  it('changes the destination and removes the expiry, keeping the short code', async () => {
    const before = await alice.get(`/api/v1/urls/${urlId}`);
    const res = await alice.patch(`/api/v1/urls/${urlId}`).send({ url: 'https://new.com', expiresAt: null });

    expect(res.status).toBe(200);
    expect(res.body.url).toMatchObject({ originalUrl: 'https://new.com', expiresAt: null, shortCode: before.body.url.shortCode });
    expect(new Date(res.body.url.updatedAt) > new Date(before.body.url.updatedAt)).toBe(true);
  });

  it('refuses to change the short code', async () => {
    const res = await alice.patch(`/api/v1/urls/${urlId}`).send({ shortCode: 'hijack' });
    expect(res.status).toBe(400);
  });

  it('returns 404 for another user\'s URL and leaves it unchanged', async () => {
    const res = await bob.patch(`/api/v1/urls/${urlId}`).send({ url: 'https://evil.com' });
    expect(res.status).toBe(404);
    expect((await prisma.url.findUnique({ where: { id: urlId } })).originalUrl).toBe('https://old.com');
  });

  it('returns 400 for an expiry in the past', async () => {
    const res = await alice.patch(`/api/v1/urls/${urlId}`).send({ expiresAt: '2020-01-01T00:00:00Z' });
    expect(res.status).toBe(400);
  });
});

describe('DELETE /api/v1/urls/:id', () => {
  it('deletes the caller\'s URL', async () => {
    const { body } = await createUrl(alice, { url: 'https://a.com' });

    const res = await alice.delete(`/api/v1/urls/${body.url.id}`);
    expect(res.status).toBe(204);
    expect((await alice.get(`/api/v1/urls/${body.url.id}`)).status).toBe(404);
  });

  it('returns 404 for another user\'s URL and does not delete it', async () => {
    const { body } = await createUrl(alice, { url: 'https://a.com' });

    const res = await bob.delete(`/api/v1/urls/${body.url.id}`);
    expect(res.status).toBe(404);
    expect(await prisma.url.count({ where: { id: body.url.id } })).toBe(1);
  });

  it('frees a custom alias for reuse after deletion', async () => {
    const { body } = await createUrl(alice, { url: 'https://a.com', customAlias: 'reusable' });
    await alice.delete(`/api/v1/urls/${body.url.id}`);
    expect((await createUrl(bob, { url: 'https://b.com', customAlias: 'reusable' })).status).toBe(201);
  });
});
