import { prisma } from '../config/database.js';
import { isRedisReady, redis } from '../config/redis.js';
import { GoneError, NotFoundError } from '../utils/errors.js';
import { getUrlStatus } from '../utils/expiration.js';

const CACHE_TTL_SECONDS = 60 * 60; // cached links expire from Redis after 1 hour
const cacheKey = (shortCode) => `url:${shortCode}`;

/**
 * Cache-aside lookup:
 *   1. look in Redis → HIT: use it
 *   2. MISS → read PostgreSQL (the source of truth) → save in Redis with a TTL
 *   3. check the link is active and not expired (on every request, so a cached
 *      link still stops working exactly when it expires)
 */
export async function resolveShortCode(shortCode) {
  let url = await readCache(shortCode);
  const cacheStatus = url ? 'HIT' : 'MISS';

  if (!url) {
    url = await prisma.url.findUnique({
      where: { shortCode },
      select: { id: true, originalUrl: true, isActive: true, expiresAt: true },
    });
    if (!url) throw NotFoundError('Short link not found');
    await writeCache(shortCode, url);
  }

  const status = getUrlStatus(url);
  if (status === 'inactive') throw GoneError('This short link has been deactivated');
  if (status === 'expired') throw GoneError('This short link has expired');
  return { url, cacheStatus };
}

// If Redis is down, every lookup simply becomes a miss: slower, but still correct.
async function readCache(shortCode) {
  if (!isRedisReady()) return null;
  try {
    const cached = await redis.get(cacheKey(shortCode));
    return cached ? JSON.parse(cached) : null;
  } catch {
    return null;
  }
}

async function writeCache(shortCode, url) {
  if (!isRedisReady()) return;
  await redis.set(cacheKey(shortCode), JSON.stringify(url), 'EX', CACHE_TTL_SECONDS).catch(() => {});
}

/** Called after a URL is updated or deleted, so the next redirect reloads it from PostgreSQL. */
export async function removeFromCache(shortCode) {
  if (!isRedisReady()) return;
  await redis.del(cacheKey(shortCode)).catch(() => {});
}
