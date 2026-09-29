import { prisma } from '../config/database.js';
import { getUrl } from './url.service.js';

const DAY_MS = 24 * 60 * 60 * 1000;
const TOP_N = 10;

/** Midnight UTC, `daysAgo` days before `now`. */
export function startOfUtcDay(now, daysAgo = 0) {
  const d = new Date(now);
  d.setUTCHours(0, 0, 0, 0);
  return new Date(d.getTime() - daysAgo * DAY_MS);
}

/**
 * Turn sparse daily rows into a continuous series with explicit zeros, so a
 * chart doesn't silently skip days with no clicks.
 *   rows: [{ day: Date(2026-09-27), clicks: 5 }]  (only days that had clicks)
 *   →     [{ date: '2026-09-26', clicks: 0 }, { date: '2026-09-27', clicks: 5 }, …]
 */
export function fillDailySeries(rows, from, days) {
  const byDate = new Map(rows.map((r) => [new Date(r.day).toISOString().slice(0, 10), r.clicks]));
  return Array.from({ length: days }, (_, i) => {
    const date = new Date(from.getTime() + i * DAY_MS).toISOString().slice(0, 10);
    return { date, clicks: byDate.get(date) ?? 0 };
  });
}

/**
 * Analytics for one URL, only for its owner (getUrl filters by id AND userId,
 * so someone else's URL is a 404).
 *
 * Totals are all-time; the breakdowns cover the last `days` days (UTC).
 * Data is EVENTUALLY consistent: a click shows up here once the worker has
 * processed it from Kafka (normally well under a second).
 */
export async function getUrlAnalytics({ userId, id, days, now = new Date() }) {
  const url = await getUrl({ userId, id });
  const from = startOfUtcDay(now, days - 1); // e.g. days=7 → today plus the 6 previous days

  const [totalAgg, dailyRows, [visitors], topReferrers, userAgents] = await Promise.all([
    // Cheap: sums one small row per day from the rollup table.
    prisma.urlDailyStat.aggregate({ where: { urlId: id }, _sum: { clicks: true } }),

    prisma.urlDailyStat.findMany({
      where: { urlId: id, day: { gte: from } },
      orderBy: { day: 'asc' },
      select: { day: true, clicks: true },
    }),

    // The breakdowns below need the raw events. The (url_id, clicked_at)
    // index narrows the scan to this URL's clicks (and time range).
    // Tagged-template $queryRaw sends values as bind parameters, never as SQL text,
    // so there's no SQL injection risk.
    prisma.$queryRaw`
      SELECT COUNT(DISTINCT ip_hash)::int AS "uniqueVisitors", MAX(clicked_at) AS "lastClickedAt"
      FROM click_events WHERE url_id = ${id}`,

    prisma.$queryRaw`
      SELECT COALESCE(referrer_host, 'direct') AS referrer, COUNT(*)::int AS clicks
      FROM click_events
      WHERE url_id = ${id} AND clicked_at >= ${from}
      GROUP BY 1 ORDER BY clicks DESC, referrer ASC LIMIT ${TOP_N}`,

    prisma.$queryRaw`
      SELECT browser, COUNT(*)::int AS clicks
      FROM click_events
      WHERE url_id = ${id} AND clicked_at >= ${from}
      GROUP BY 1 ORDER BY clicks DESC, browser ASC LIMIT ${TOP_N}`,
  ]);

  return {
    urlId: url.id,
    shortCode: url.shortCode,
    totalClicks: totalAgg._sum.clicks ?? 0,
    uniqueVisitors: visitors.uniqueVisitors,
    lastClickedAt: visitors.lastClickedAt,
    period: { days, from: from.toISOString(), to: now.toISOString() },
    clicksByDay: fillDailySeries(dailyRows, from, days),
    topReferrers,
    userAgents,
  };
}
