import request from 'supertest';
import { beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../../src/app.js';
import { redis } from '../../src/config/redis.js';
import { CLICKS_QUEUE } from '../../src/services/clicks.service.js';
import { saveClick } from '../../worker/analytics.processor.js';
import { loggedInAgent } from '../helpers/auth.js';
import { prisma, resetState } from '../helpers/db.js';

const app = createApp();
let alice;
let link;

beforeEach(async () => {
  await resetState();
  alice = await loggedInAgent(app);
  link = (await alice.post('/api/v1/urls').send({ url: 'https://example.com' })).body.url;
});

/** Do what the worker loop does: take every queued click and save it. */
async function runWorker() {
  await new Promise((r) => setTimeout(r, 50)); // the API queues the click just after responding
  let item;
  while ((item = await redis.rpop(CLICKS_QUEUE))) await saveClick(item);
}

describe('click analytics', () => {
  it('a redirect queues the click in Redis instead of writing to PostgreSQL', async () => {
    await request(app).get(`/${link.shortCode}`).set('Referer', 'https://twitter.com/post').set('User-Agent', 'TestBrowser/1.0');
    await new Promise((r) => setTimeout(r, 50));

    expect(await redis.llen(CLICKS_QUEUE)).toBe(1);
    expect(await prisma.clickEvent.count()).toBe(0); // nothing written yet: that's the worker's job
    expect(JSON.parse(await redis.lindex(CLICKS_QUEUE, 0))).toMatchObject({ urlId: link.id, referrer: 'twitter.com', userAgent: 'TestBrowser/1.0' });
  });

  it('the worker stores clicks and the analytics API summarises them', async () => {
    const click = (referrer, ua) => request(app).get(`/${link.shortCode}`).set('Referer', referrer).set('User-Agent', ua);
    await click('https://twitter.com/a', 'Chrome');
    await click('https://twitter.com/b', 'Chrome');
    await click('https://news.ycombinator.com/', 'Firefox');
    await runWorker();

    const res = await alice.get(`/api/v1/urls/${link.id}/analytics`);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      totalClicks: 3,
      clicksByDay: [{ date: new Date().toISOString().slice(0, 10), clicks: 3 }],
      topReferrers: [
        { referrer: 'twitter.com', clicks: 2 },
        { referrer: 'news.ycombinator.com', clicks: 1 },
      ],
      userAgents: [
        { userAgent: 'Chrome', clicks: 2 },
        { userAgent: 'Firefox', clicks: 1 },
      ],
    });
  });

  it('the worker skips a malformed queue item', async () => {
    await expect(saveClick('{not json')).resolves.toBeUndefined();
    expect(await prisma.clickEvent.count()).toBe(0);
  });

  it('only the owner can see analytics', async () => {
    const bob = await loggedInAgent(app);
    expect((await bob.get(`/api/v1/urls/${link.id}/analytics`)).status).toBe(404);
  });
});
