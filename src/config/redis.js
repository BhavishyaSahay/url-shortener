import { Redis } from 'ioredis';
import { config } from './env.js';
import { logger } from '../utils/logger.js';

// Redis is used for the URL cache, rate-limit counters and the click queue.
// None of it is the source of truth, so if Redis is down the API keeps working
// (just slower, without rate limiting, and without recording clicks).
//
// enableOfflineQueue: false → while disconnected, commands fail immediately
// instead of waiting, so a Redis outage never slows down requests.
// ioredis keeps reconnecting in the background.
export const redis = new Redis(config.redisUrl, {
  lazyConnect: true,
  enableOfflineQueue: false,
  maxRetriesPerRequest: 1,
});

let lastErrorLog = 0;
redis.on('error', (err) => {
  // Log at most once every 30 s, not on every reconnect attempt.
  if (Date.now() - lastErrorLog > 30_000) {
    lastErrorLog = Date.now();
    logger.warn({ reason: err.message }, 'Redis unavailable');
  }
});

export const isRedisReady = () => redis.status === 'ready';

export async function connectRedis() {
  await redis.connect().catch(() => {}); // never block startup; reconnects in the background
}
