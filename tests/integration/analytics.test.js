import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../../src/app.js';
import { storeClickEvents } from '../../worker/analytics.processor.js';
import { loggedInAgent } from '../helpers/auth.js';
import { prisma, resetTables } from '../helpers/db.js';

// These tests drive the worker's processor directly (no Kafka), to check the
// database logic and the analytics API precisely. tests/integration/kafka.e2e.test.js
// covers the real Kafka path.

const app = createApp();
const DAY = 24 * 60 * 60 * 1000;
const CHROME = 'Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0 Safari/537.36';
const FIREFOX = 'Mozilla/5.0 (Macintosh; rv:141.0) Gecko/20100101 Firefox/141.0';

let alice;
let link;

beforeEach(async () => {
  await resetTables();
  alice = await loggedInAgent(app);
  link = (await alice.post('/api/v1/urls').send({ url: 'https://example.com' })).body.url;
});

function click({ at = new Date(), ip = 'visitor-1', userAgent = CHROME, referrer = null, urlId = link.id, shortCode = link.shortCode } = {}) {
  return { eventId: randomUUID(), urlId, shortCode, timestamp: new Date(at).toISOString(), ipHash: ip, userAgent, referrer };
}

describe('storeClickEvents (worker → PostgreSQL)', () => {
  it('stores raw events and the daily rollup', async () => {
    const result = await storeClickEvents([click(), click({ referrer: 'https://www.twitter.com/p/1', userAgent: FIREFOX })]);

    expect(result).toEqual({ received: 2, inserted: 2, duplicates: 0, skippedMissingUrl: 0 });
    const rows = await prisma.clickEvent.findMany({ orderBy: { id: 'asc' } });
    expect(rows.map((r) => [r.browser, r.referrerHost])).toEqual([
      ['Chrome', null],
      ['Firefox', 'twitter.com'],
    ]);
    const [daily] = await prisma.urlDailyStat.findMany();
    expect(daily.clicks).toBe(2);
  });

  it('is idempotent: redelivering the same events changes nothing', async () => {
    const batch = [click(), click(), click()];
    await storeClickEvents(batch);

    // Kafka redelivers after a crash before the offset commit (at-least-once).
    const replay = await storeClickEvents(batch);

    expect(replay).toMatchObject({ inserted: 0, duplicates: 3 });
    expect(await prisma.clickEvent.count()).toBe(3);
    expect((await prisma.urlDailyStat.findFirst()).clicks).toBe(3); // not 6
  });

  it('counts only the new events in a partially-duplicated batch', async () => {
    const seen = click();
    await storeClickEvents([seen]);
    const result = await storeClickEvents([seen, click(), click()]);

    expect(result).toMatchObject({ inserted: 2, duplicates: 1 });
    expect((await prisma.urlDailyStat.findFirst()).clicks).toBe(3);
  });

  it('skips events for URLs that were deleted (or whose code does not match)', async () => {
    const result = await storeClickEvents([
      click({ urlId: 999_999, shortCode: 'gone' }),
      click({ shortCode: 'different-code' }),
      click(),
    ]);
    expect(result).toMatchObject({ inserted: 1, skippedMissingUrl: 2 });
  });

  it('keeps separate daily rows per UTC day', async () => {
    await storeClickEvents([click({ at: '2026-09-28T23:59:00Z' }), click({ at: '2026-09-29T00:01:00Z' })]);
    const days = await prisma.urlDailyStat.findMany({ orderBy: { day: 'asc' } });
    expect(days.map((d) => [d.day.toISOString().slice(0, 10), d.clicks])).toEqual([
      ['2026-09-28', 1],
      ['2026-09-29', 1],
    ]);
  });

  it('deleting a URL deletes its analytics too (ON DELETE CASCADE)', async () => {
    await storeClickEvents([click(), click()]);
    await alice.delete(`/api/v1/urls/${link.id}`);
    expect(await prisma.clickEvent.count()).toBe(0);
    expect(await prisma.urlDailyStat.count()).toBe(0);
  });
});

describe('GET /api/v1/urls/:id/analytics', () => {
  it('returns totals, a zero-filled daily series and breakdowns', async () => {
    const now = Date.now();
    await storeClickEvents([
      click({ at: now, ip: 'v1', referrer: 'https://twitter.com/a' }),
      click({ at: now, ip: 'v1', referrer: 'https://twitter.com/b' }),
      click({ at: now, ip: 'v2', userAgent: FIREFOX }),
      click({ at: now - 2 * DAY, ip: 'v3', referrer: 'https://news.ycombinator.com/' }),
      click({ at: now - 20 * DAY, ip: 'v4', userAgent: FIREFOX, referrer: 'https://old.example.org/' }), // outside a 7-day window
    ]);

    const res = await alice.get(`/api/v1/urls/${link.id}/analytics?days=7`);

    expect(res.status).toBe(200);
    const a = res.body;
    expect(a).toMatchObject({ urlId: link.id, shortCode: link.shortCode, totalClicks: 5, uniqueVisitors: 4 });
    expect(new Date(a.lastClickedAt).getTime()).toBeGreaterThan(now - 5000);

    expect(a.clicksByDay).toHaveLength(7);
    expect(a.clicksByDay.at(-1).clicks).toBe(3); // today
    expect(a.clicksByDay.at(-3).clicks).toBe(1); // 2 days ago
    expect(a.clicksByDay.reduce((sum, d) => sum + d.clicks, 0)).toBe(4); // the 20-day-old click is outside the window

    expect(a.topReferrers).toEqual([
      { referrer: 'twitter.com', clicks: 2 },
      { referrer: 'direct', clicks: 1 },
      { referrer: 'news.ycombinator.com', clicks: 1 },
    ]);
    expect(a.userAgents).toEqual([
      { browser: 'Chrome', clicks: 3 },
      { browser: 'Firefox', clicks: 1 },
    ]);
  });

  it('returns zeros for a link with no clicks', async () => {
    const res = await alice.get(`/api/v1/urls/${link.id}/analytics`);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ totalClicks: 0, uniqueVisitors: 0, lastClickedAt: null, topReferrers: [], userAgents: [] });
    expect(res.body.clicksByDay).toHaveLength(30); // default window
  });

  it('is only visible to the owner (404 for others, 401 when logged out)', async () => {
    const bob = await loggedInAgent(app);
    expect((await bob.get(`/api/v1/urls/${link.id}/analytics`)).status).toBe(404);
    expect((await request(app).get(`/api/v1/urls/${link.id}/analytics`)).status).toBe(401);
  });

  it('validates the days parameter', async () => {
    expect((await alice.get(`/api/v1/urls/${link.id}/analytics?days=0`)).status).toBe(400);
    expect((await alice.get(`/api/v1/urls/${link.id}/analytics?days=366`)).status).toBe(400);
  });
});
