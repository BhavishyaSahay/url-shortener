import { z } from 'zod';
import { prisma } from '../src/config/database.js';

// ---------------------------------------------------------------------------
// Pure helpers (no I/O), unit tested in tests/unit/analytics.processor.test.js
// ---------------------------------------------------------------------------

// The contract between the API (producer) and this worker (consumer). Messages
// that don't match are "poison messages": logged and skipped, so one bad message
// can't block the queue forever.
const clickEventSchema = z.object({
  eventId: z.uuid(),
  // Capped at PostgreSQL INTEGER's max: a larger ID would make the whole batch's
  // INSERT fail, every time it's retried (a poison message validation must catch).
  urlId: z.number().int().positive().max(2_147_483_647),
  shortCode: z.string().min(1).max(32),
  timestamp: z.iso.datetime(),
  ipHash: z.string().max(64).nullable(),
  userAgent: z.string().max(512).nullable(),
  referrer: z.string().max(2048).nullable(),
});

/** Parse a stream entry's "event" field (a JSON string) into a click event, or null if it's malformed. */
export function parseClickEvent(value) {
  try {
    const result = clickEventSchema.safeParse(JSON.parse(String(value)));
    return result.success ? result.data : null;
  } catch {
    return null;
  }
}

/**
 * Bucket a user agent into a browser family. Deliberately simple: the order
 * matters because most browsers claim to be several others (Edge's UA contains
 * "Chrome" and "Safari"; Chrome's contains "Safari").
 */
export function classifyBrowser(userAgent) {
  if (!userAgent) return 'Unknown';
  const ua = userAgent.toLowerCase();
  if (/bot|crawler|spider|curl|wget|python-requests|httpclient|axios|node-fetch|go-http-client/.test(ua)) return 'Bot';
  if (ua.includes('edg/')) return 'Edge';
  if (ua.includes('opr/') || ua.includes('opera')) return 'Opera';
  if (ua.includes('firefox/') || ua.includes('fxios/')) return 'Firefox';
  if (ua.includes('chrome/') || ua.includes('crios/')) return 'Chrome';
  if (ua.includes('safari/')) return 'Safari';
  return 'Other';
}

/** "https://www.twitter.com/some/post?x=1" → "twitter.com"; missing/invalid → null (direct). */
export function referrerHost(referrer) {
  if (!referrer) return null;
  try {
    return new URL(referrer).hostname.replace(/^www\./, '').slice(0, 255) || null;
  } catch {
    return null;
  }
}

/** UTC calendar day of a timestamp, e.g. "2026-09-29". Daily stats are bucketed in UTC. */
export const utcDay = (date) => new Date(date).toISOString().slice(0, 10);

/** Count clicks per (urlId, day), e.g. [{ urlId: 4, day: '2026-09-29', clicks: 12 }]. */
export function countClicksByUrlAndDay(clicks) {
  const counts = new Map();
  for (const { urlId, clickedAt } of clicks) {
    const key = `${urlId}|${utcDay(clickedAt)}`;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return [...counts]
    .map(([key, count]) => {
      const [urlId, day] = key.split('|');
      return { urlId: Number(urlId), day, clicks: count };
    })
    // Always update rows in the same order: two transactions locking rows in
    // opposite orders is the classic recipe for a deadlock.
    .sort((a, b) => a.urlId - b.urlId || a.day.localeCompare(b.day));
}

// ---------------------------------------------------------------------------
// Database writes
// ---------------------------------------------------------------------------

/**
 * Store a batch of click events. Everything happens in ONE transaction:
 *
 *   1. Drop events whose URL no longer exists (deleted after the click).
 *   2. INSERT raw click_events … ON CONFLICT (event_id) DO NOTHING
 *        → only NEW events come back (duplicates from redelivery are skipped)
 *   3. For those new events only, add to url_daily_stats with an upsert:
 *        INSERT … ON CONFLICT (url_id, day) DO UPDATE SET clicks = clicks + n
 *
 * If anything fails, the whole batch rolls back and throws. The consumer then
 * does NOT acknowledge (XACK) the entries, so they stay pending and are
 * retried. Because of steps 2 and 3, processing a batch twice gives the same
 * result as once (idempotent), which turns the queue's at-least-once delivery
 * into exactly-once EFFECTS in our database.
 *
 * @returns {Promise<{received: number, inserted: number, duplicates: number, skippedMissingUrl: number}>}
 */
export async function storeClickEvents(events) {
  if (events.length === 0) return { received: 0, inserted: 0, duplicates: 0, skippedMissingUrl: 0 };

  return prisma.$transaction(async (tx) => {
    // 1. Keep only events for URLs that still exist AND still have the same
    //    short code (guards against acting on stale events for a reused ID).
    const urlIds = [...new Set(events.map((e) => e.urlId))];
    const urls = await tx.url.findMany({ where: { id: { in: urlIds } }, select: { id: true, shortCode: true } });
    const codeById = new Map(urls.map((u) => [u.id, u.shortCode]));
    const valid = events.filter((e) => codeById.get(e.urlId) === e.shortCode);

    // 2. Raw events. skipDuplicates → ON CONFLICT DO NOTHING; the rows
    //    returned are only the ones actually inserted.
    const inserted = await tx.clickEvent.createManyAndReturn({
      data: valid.map((e) => ({
        eventId: e.eventId,
        urlId: e.urlId,
        clickedAt: new Date(e.timestamp),
        ipHash: e.ipHash,
        userAgent: e.userAgent,
        browser: classifyBrowser(e.userAgent),
        referrerHost: referrerHost(e.referrer),
      })),
      skipDuplicates: true,
      select: { urlId: true, clickedAt: true },
    });

    // 3. Daily rollup, from newly inserted events only.
    for (const { urlId, day, clicks } of countClicksByUrlAndDay(inserted)) {
      await tx.$executeRaw`
        INSERT INTO url_daily_stats (url_id, day, clicks)
        VALUES (${urlId}, ${day}::date, ${clicks})
        ON CONFLICT (url_id, day) DO UPDATE SET clicks = url_daily_stats.clicks + EXCLUDED.clicks`;
    }

    return {
      received: events.length,
      inserted: inserted.length,
      duplicates: valid.length - inserted.length,
      skippedMissingUrl: events.length - valid.length,
    };
  });
}
