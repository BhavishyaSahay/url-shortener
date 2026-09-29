import { setTimeout as sleep } from 'node:timers/promises';
import { Redis } from 'ioredis';
import { config } from './env.js';
import { logger } from '../utils/logger.js';

// ---------------------------------------------------------------------------
// Redis client
// ---------------------------------------------------------------------------
// Redis is an OPTIMIZATION here, not a source of truth: the URL cache can be
// rebuilt from PostgreSQL, and rate-limit counters are allowed to reset. So
// the rule is: if Redis is slow or down, skip it and keep serving requests.
//
// The options make every Redis call fail FAST instead of hanging:
//   lazyConnect         don't connect on import; server.js calls connectRedis()
//   enableOfflineQueue  false: while disconnected, commands error immediately
//                       instead of queueing (and piling up memory) until Redis returns
//   commandTimeout      a command that gets no reply within 500 ms is abandoned
//   retryStrategy       keep reconnecting in the background, backing off up to 5 s
export const redis = new Redis(config.redis.url, {
  lazyConnect: true,
  enableOfflineQueue: false,
  commandTimeout: 500,
  maxRetriesPerRequest: 1,
  retryStrategy: (attempt) => Math.min(attempt * 200, 5_000),
});

// ioredis emits 'error' on every failed reconnect attempt (every few seconds
// while Redis is down). Log the first one, then at most once every 30 s.
let lastErrorLogAt = 0;
redis.on('error', (err) => {
  const now = Date.now();
  if (now - lastErrorLogAt > 30_000) {
    lastErrorLogAt = now;
    logger.warn({ reason: err.code || err.message }, 'Redis unavailable, serving without cache (reconnecting in background)');
  }
});
redis.on('ready', () => {
  lastErrorLogAt = 0;
  logger.info('Connected to Redis');
});

/** True only when commands can be sent right now. Callers skip Redis otherwise. */
export const isRedisReady = () => redis.status === 'ready';

/**
 * Connect at startup, but DON'T block startup on it. Unlike PostgreSQL, the
 * API works without Redis (slower, without rate limiting), so a Redis outage
 * shouldn't stop the API from starting. ioredis keeps retrying in the background.
 */
export async function connectRedis() {
  try {
    await redis.connect();
  } catch {
    // Already logged by the 'error' handler; reconnection continues in the background.
  }
}

/** Readiness probe: PING with a short timeout. */
export async function isRedisHealthy(timeoutMs = 1_000) {
  if (!isRedisReady()) return false;
  try {
    const reply = await Promise.race([
      redis.ping(),
      sleep(timeoutMs, undefined, { ref: false }).then(() => {
        throw new Error('Redis health check timed out');
      }),
    ]);
    return reply === 'PONG';
  } catch {
    return false;
  }
}

export async function disconnectRedis() {
  if (redis.status === 'end') return;
  try {
    // QUIT waits for pending replies, then closes cleanly.
    if (isRedisReady()) await redis.quit();
    else redis.disconnect(); // not connected: just stop the reconnect loop
  } catch {
    redis.disconnect();
  }
  logger.info('Redis connection closed');
}
