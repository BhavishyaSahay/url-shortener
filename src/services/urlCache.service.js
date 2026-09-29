import { config } from '../config/env.js';
import { isRedisReady, redis } from '../config/redis.js';
import { logger } from '../utils/logger.js';

// Redis cache for short-code lookups.
//
//   key    url:<shortCode>            e.g. url:aB92x
//   value  JSON {id, originalUrl, isActive, expiresAt}   the fields a redirect decision needs
//          or {missing: true}                            "this code doesn't exist" (negative cache)
//
// We cache the fields needed to DECIDE, not just the destination, so
// expiry is re-checked on every hit. A cached link still stops redirecting at
// the exact second it expires, whatever its cache TTL.

const keyFor = (shortCode) => `url:${shortCode}`;
const MISSING = { missing: true };

/**
 * Look up a short code in Redis.
 * @returns {{ status: 'HIT', url: object|null } | { status: 'MISS' } | { status: 'BYPASS' }}
 *   HIT with url=null means "known not to exist" (negative cache hit).
 *   BYPASS means Redis is unavailable and the caller must go to PostgreSQL.
 */
export async function getCachedUrl(shortCode) {
  if (!isRedisReady()) return { status: 'BYPASS' };
  try {
    const raw = await redis.get(keyFor(shortCode));
    if (raw === null) return { status: 'MISS' };
    const value = JSON.parse(raw);
    return { status: 'HIT', url: value.missing ? null : value };
  } catch (err) {
    logger.warn({ err, shortCode }, 'Redis GET failed, falling back to PostgreSQL');
    return { status: 'BYPASS' };
  }
}

/**
 * Store a lookup result. `url` = the row from PostgreSQL, or null if it doesn't exist.
 * Real links are cached for URL_CACHE_TTL. "Doesn't exist" gets a much shorter
 * TTL, so that someone requesting random codes can't hammer PostgreSQL, yet a
 * code that becomes valid later isn't hidden for long.
 */
export async function cacheUrl(shortCode, url) {
  if (!isRedisReady()) return;
  const value = url
    ? { id: url.id, originalUrl: url.originalUrl, isActive: url.isActive, expiresAt: url.expiresAt }
    : MISSING;
  const ttl = url ? config.redis.urlCacheTtlSeconds : config.redis.negativeCacheTtlSeconds;
  try {
    // SET key value EX ttl: write and set the expiry in one atomic command.
    await redis.set(keyFor(shortCode), JSON.stringify(value), 'EX', ttl);
  } catch (err) {
    logger.warn({ err, shortCode }, 'Redis SET failed, continuing without caching');
  }
}

/**
 * Remove a cached entry after the URL changed in PostgreSQL. Called after
 * create (to clear a negative entry), update and delete.
 */
export async function invalidateUrl(shortCode) {
  if (!isRedisReady()) return;
  try {
    await redis.del(keyFor(shortCode));
  } catch (err) {
    // The stale entry expires on its own after at most URL_CACHE_TTL.
    logger.warn({ err, shortCode }, 'Redis DEL failed, stale cache entry will expire via TTL');
  }
}
