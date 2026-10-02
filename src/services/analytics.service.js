import { prisma } from '../config/database.js';
import { getUrl } from './url.service.js';

/** Click statistics for one URL. Only its owner can see them (getUrl checks that). */
export async function getAnalytics({ userId, id }) {
  const url = await getUrl({ userId, id });

  // All four come from the click_events table, using the (url_id, clicked_at) index.
  const [totalClicks, clicksByDay, topReferrers, userAgents] = await Promise.all([
    prisma.clickEvent.count({ where: { urlId: id } }),
    prisma.$queryRaw`
      SELECT to_char(date_trunc('day', clicked_at), 'YYYY-MM-DD') AS date, COUNT(*)::int AS clicks
      FROM click_events
      WHERE url_id = ${id} AND clicked_at > now() - interval '30 days'
      GROUP BY 1 ORDER BY 1`,
    prisma.$queryRaw`
      SELECT COALESCE(referrer, 'direct') AS referrer, COUNT(*)::int AS clicks
      FROM click_events WHERE url_id = ${id}
      GROUP BY 1 ORDER BY clicks DESC LIMIT 5`,
    prisma.$queryRaw`
      SELECT COALESCE(user_agent, 'unknown') AS "userAgent", COUNT(*)::int AS clicks
      FROM click_events WHERE url_id = ${id}
      GROUP BY 1 ORDER BY clicks DESC LIMIT 5`,
  ]);

  return { urlId: url.id, shortCode: url.shortCode, totalClicks, clicksByDay, topReferrers, userAgents };
}
