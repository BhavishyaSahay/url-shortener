import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../../src/app.js';
import { config } from '../../src/config/env.js';
import { connectProducer, disconnectProducer, ensureClickTopic, kafka } from '../../src/config/kafka.js';
import { buildClickEvent, publishClickEvent } from '../../src/services/clickEvent.service.js';
import { startClickConsumer } from '../../worker/analytics.consumer.js';
import { loggedInAgent } from '../helpers/auth.js';
import { resetTables } from '../helpers/db.js';

// The real pipeline: redirect → Kafka → worker consumer → PostgreSQL → analytics API.
// Needs the Kafka container (docker compose up -d). The topic is unique per
// test run (see vitest.config.js) and deleted at the end.

const app = createApp();
let alice;
let link;
let consumer;

/** Poll until `check()` returns true, or fail after `timeoutMs`. */
async function waitFor(check, { timeoutMs = 20_000, intervalMs = 200 } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  throw new Error(`Condition not met within ${timeoutMs} ms`);
}

const totalClicks = async () => (await alice.get(`/api/v1/urls/${link.id}/analytics`)).body.totalClicks;

beforeAll(async () => {
  await ensureClickTopic();
  await connectProducer();
  await resetTables();
  alice = await loggedInAgent(app);
  link = (await alice.post('/api/v1/urls').send({ url: 'https://example.com/e2e' })).body.url;
}, 60_000);

afterAll(async () => {
  await consumer?.disconnect();
  await disconnectProducer();
  const admin = kafka.admin();
  await admin.connect();
  await admin.deleteTopics({ topics: [config.kafka.clicksTopic] }).catch(() => {});
  await admin.disconnect();
}, 30_000);

describe('click analytics through Kafka', () => {
  it('redirects immediately and buffers clicks in Kafka while the worker is down', async () => {
    for (let i = 0; i < 3; i++) {
      const res = await request(app).get(`/${link.shortCode}`).set('Referer', 'https://twitter.com/post');
      expect(res.status).toBe(302);
    }

    // Worker isn't running: redirects worked, analytics haven't been updated yet.
    await new Promise((r) => setTimeout(r, 500));
    expect(await totalClicks()).toBe(0);
  });

  it('processes the buffered clicks once the worker starts', async () => {
    consumer = await startClickConsumer({ fromBeginning: true });

    await waitFor(async () => (await totalClicks()) === 3);

    const analytics = (await alice.get(`/api/v1/urls/${link.id}/analytics`)).body;
    expect(analytics.topReferrers).toEqual([{ referrer: 'twitter.com', clicks: 3 }]);
  }, 30_000);

  it('processes new clicks in near real time', async () => {
    await request(app).get(`/${link.shortCode}`);
    await waitFor(async () => (await totalClicks()) === 4);
  }, 30_000);

  it('ignores a duplicate delivery of the same event (idempotent consumer)', async () => {
    const event = buildClickEvent({ url: link, shortCode: link.shortCode, ip: '198.51.100.1' });
    expect(await publishClickEvent(event)).toBe(true);
    expect(await publishClickEvent(event)).toBe(true); // same eventId, delivered twice
    // A fresh click afterwards. Same key → same partition, so it's processed
    // after both copies above; once it's counted, the duplicate has been handled.
    await request(app).get(`/${link.shortCode}`);

    await waitFor(async () => (await totalClicks()) >= 6);
    await new Promise((r) => setTimeout(r, 500));
    expect(await totalClicks()).toBe(6); // 4 + event once + fresh click (not 7)
  }, 30_000);
});

describe('when Kafka is unavailable', () => {
  beforeEach(async () => {
    await disconnectProducer();
  });

  it('still redirects, and /ready reports "degraded" (not 503)', async () => {
    const res = await request(app).get(`/${link.shortCode}`);
    expect(res.status).toBe(302);

    const ready = await request(app).get('/ready');
    expect(ready.status).toBe(200);
    expect(ready.body.status).toBe('degraded');
    expect(ready.body.checks.kafka).toBe('down');
  });
});
