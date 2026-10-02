import { isRedisReady, redis } from '../config/redis.js';

// A Redis list used as a simple queue between the API and the analytics worker:
// the API pushes clicks on the left (LPUSH), the worker takes them from the
// right (BRPOP), so they're processed in order.
export const CLICKS_QUEUE = 'clicks';

/**
 * Queue a click. Called AFTER the redirect response is sent, and not awaited,
 * so the user never waits for analytics. If Redis is down the click is simply
 * not recorded; redirects keep working.
 */
export async function recordClick(click) {
  if (!isRedisReady()) return;
  await redis.lpush(CLICKS_QUEUE, JSON.stringify(click)).catch(() => {});
}
