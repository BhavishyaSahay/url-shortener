import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../../src/app.js';
import { config } from '../../src/config/env.js';
import { redis } from '../../src/config/redis.js';
import { buildClickEvent, publishClickEvent } from '../../src/services/clickEvent.service.js';
import { startClickConsumer } from '../../worker/analytics.consumer.js';
import { loggedInAgent } from '../helpers/auth.js';
import { resetTables } from '../helpers/db.js';

// The real pipeline: redirect → Redis Stream → worker consumer → PostgreSQL →
// analytics API. The stream and consumer group are unique per test run
// (see vitest.config.js).

const app = createApp();
const { stream, consumerGroup: group } = config.clicks;
const FAST = { blockMs: 200, claimEveryMs: 100, retryBaseMs: 20 }; // tiny timeouts for tests

let alice;
let link;
let consumer;

async function waitFor(check, { timeoutMs = 15_000, intervalMs = 100 } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  throw new Error(`Condition not met within ${timeoutMs} ms`);
}

const totalClicks = async () => (await alice.get(`/api/v1/urls/${link.id}/analytics`)).body.totalClicks;
const pendingCount = async () => (await redis.xpending(stream, group))[0];
const clickEvent = () => buildClickEvent({ url: link, shortCode: link.shortCode, ip: '198.51.100.7' });

beforeAll(async () => {
  await resetTables();
  alice = await loggedInAgent(app);
  link = (await alice.post('/api/v1/urls').send({ url: 'https://example.com/stream' })).body.url;
});

afterAll(async () => {
  await consumer?.stop();
});

describe('click analytics through a Redis Stream', () => {
  it('redirects immediately and buffers clicks in the stream while the worker is down', async () => {
    for (let i = 0; i < 3; i++) {
      const res = await request(app).get(`/${link.shortCode}`).set('Referer', 'https://twitter.com/post');
      expect(res.status).toBe(302);
    }
    await waitFor(async () => (await redis.xlen(stream)) === 3);
    expect(await totalClicks()).toBe(0); // nobody has processed them yet
  });

  it('processes the buffered clicks once the worker starts, then deletes them from the stream', async () => {
    consumer = await startClickConsumer(FAST);

    await waitFor(async () => (await totalClicks()) === 3);
    const analytics = (await alice.get(`/api/v1/urls/${link.id}/analytics`)).body;
    expect(analytics.topReferrers).toEqual([{ referrer: 'twitter.com', clicks: 3 }]);

    await waitFor(async () => (await redis.xlen(stream)) === 0); // XACK + XDEL after the DB commit
    expect(await pendingCount()).toBe(0);
  });

  it('processes new clicks in near real time', async () => {
    await request(app).get(`/${link.shortCode}`);
    await waitFor(async () => (await totalClicks()) === 4);
  });

  it('ignores a duplicate delivery of the same event (idempotent consumer)', async () => {
    const event = clickEvent();
    expect(await publishClickEvent(event)).toBe(true);
    expect(await publishClickEvent(event)).toBe(true); // same eventId, twice
    await request(app).get(`/${link.shortCode}`); // plus one genuinely new click

    await waitFor(async () => (await totalClicks()) >= 6);
    await waitFor(async () => (await redis.xlen(stream)) === 0);
    expect(await totalClicks()).toBe(6); // 4 + the event once + the new click, not 7
  });

  it('skips a malformed entry (poison message) without blocking the ones behind it', async () => {
    await redis.xadd(stream, '*', 'event', '{this is not json');
    await request(app).get(`/${link.shortCode}`);

    await waitFor(async () => (await totalClicks()) === 7);
    await waitFor(async () => (await redis.xlen(stream)) === 0);
    expect(await pendingCount()).toBe(0); // the bad entry was acknowledged, not retried forever
  });

  it('recovers entries left pending by a consumer that crashed (XAUTOCLAIM)', async () => {
    await consumer.stop();
    consumer = undefined;

    // A worker reads an entry, then "crashes" before acknowledging it.
    await publishClickEvent(clickEvent());
    const delivered = await redis.xreadgroup('GROUP', group, 'crashed-worker', 'COUNT', 10, 'STREAMS', stream, '>');
    expect(delivered[0][1]).toHaveLength(1);
    expect(await pendingCount()).toBe(1); // stuck on the dead consumer

    // A new worker claims entries pending longer than claimIdleMs.
    consumer = await startClickConsumer({ ...FAST, claimIdleMs: 200 });
    await waitFor(async () => (await totalClicks()) === 8);
    await waitFor(async () => (await pendingCount()) === 0);
  });

  it('moves an entry that keeps failing to the dead-letter stream instead of retrying forever', async () => {
    await consumer.stop();
    consumer = await startClickConsumer({
      ...FAST,
      maxDeliveries: 2,
      store: async () => {
        throw new Error('simulated database failure');
      },
    });

    await publishClickEvent(clickEvent());

    const deadLetter = `${stream}:dead-letter`;
    await waitFor(async () => (await redis.xlen(deadLetter)) === 1);
    await waitFor(async () => (await pendingCount()) === 0);

    const [[, fields]] = await redis.xrange(deadLetter, '-', '+');
    expect(fields).toEqual(expect.arrayContaining(['originalId', 'event']));
    expect(await totalClicks()).toBe(8); // never stored
  });
});
