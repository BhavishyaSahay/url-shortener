import request from 'supertest';
import { beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../../src/app.js';
import { encode } from '../../src/utils/base62.js';
import { loggedInAgent } from '../helpers/auth.js';
import { prisma, resetState } from '../helpers/db.js';

const app = createApp();
let alice;
let bob;

beforeEach(async () => {
  await resetState();
  alice = await loggedInAgent(app);
  bob = await loggedInAgent(app);
});

const create = (agent, body) => agent.post('/api/v1/urls').send(body);

describe('creating short URLs', () => {
  it('the generated short code is the Base62 encoding of the database ID', async () => {
    const res = await create(alice, { url: 'https://example.com/a/very/long/url' });
    expect(res.status).toBe(201);
    expect(res.body.url.shortCode).toBe(encode(res.body.url.id));
    expect(res.body.url.shortUrl).toBe(`http://localhost:3000/${res.body.url.shortCode}`);
  });

  it('supports a custom alias and an expiry date', async () => {
    const res = await create(alice, { url: 'https://example.com', customAlias: 'my-link', expiresAt: '2099-01-01T00:00:00Z' });
    expect(res.body.url).toMatchObject({ shortCode: 'my-link', isCustomAlias: true, status: 'active' });
  });

  it('returns 409 when the alias is already taken', async () => {
    await create(alice, { url: 'https://a.com', customAlias: 'taken' });
    expect((await create(bob, { url: 'https://b.com', customAlias: 'taken' })).status).toBe(409);
  });

  it('returns 400 for an invalid URL and 401 when not logged in', async () => {
    expect((await create(alice, { url: 'javascript:alert(1)' })).status).toBe(400);
    expect((await request(app).post('/api/v1/urls').send({ url: 'https://a.com' })).status).toBe(401);
  });

  it('skips a generated code that is already used as a custom alias', async () => {
    await prisma.$queryRaw`SELECT setval('urls_id_seq', 5000)`; // the next ID will be 5001
    await create(bob, { url: 'https://bob.com', customAlias: encode(5001) });

    const res = await create(alice, { url: 'https://alice.com' });
    expect(res.body.url.shortCode).not.toBe(encode(5001));
    expect(res.body.url.shortCode).toBe(encode(res.body.url.id));
  });

  it('gives every concurrent request a unique code', async () => {
    const results = await Promise.all(
      Array.from({ length: 20 }, (_, i) => request(app).post('/api/v1/urls').set('Cookie', alice.cookie).send({ url: `https://e.com/${i}` })),
    );
    expect(new Set(results.map((r) => r.body.url.shortCode)).size).toBe(20);
  });
});

describe('managing URLs', () => {
  let id;
  beforeEach(async () => {
    id = (await create(alice, { url: 'https://old.com' })).body.url.id;
  });

  it('lists only your own URLs, newest first', async () => {
    await create(alice, { url: 'https://newer.com' });
    const res = await alice.get('/api/v1/urls');
    expect(res.body.urls.map((u) => u.originalUrl)).toEqual(['https://newer.com', 'https://old.com']);
    expect((await bob.get('/api/v1/urls')).body.urls).toEqual([]);
  });

  it("another user's URL is a 404 for get, update and delete", async () => {
    expect((await bob.get(`/api/v1/urls/${id}`)).status).toBe(404);
    expect((await bob.patch(`/api/v1/urls/${id}`).send({ isActive: false })).status).toBe(404);
    expect((await bob.delete(`/api/v1/urls/${id}`)).status).toBe(404);
  });

  it('updates the destination and deactivates', async () => {
    const res = await alice.patch(`/api/v1/urls/${id}`).send({ url: 'https://new.com', isActive: false });
    expect(res.body.url).toMatchObject({ originalUrl: 'https://new.com', isActive: false, status: 'inactive' });
  });

  it('deletes', async () => {
    expect((await alice.delete(`/api/v1/urls/${id}`)).status).toBe(204);
    expect((await alice.get(`/api/v1/urls/${id}`)).status).toBe(404);
  });
});
