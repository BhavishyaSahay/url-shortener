import { prisma } from '../config/database.js';
import { GoneError, NotFoundError } from '../utils/errors.js';
import { getUrlStatus } from '../utils/expiration.js';
import { cacheUrl, getCachedUrl } from './urlCache.service.js';

/**
 * Resolve a short code to its destination using the cache-aside pattern:
 *
 *   1. Look in Redis ─── HIT ──────────────────────────────┐
 *        │ MISS (or Redis down = BYPASS)                   │
 *   2. Query PostgreSQL (the source of truth)              │
 *   3. Store the result in Redis (with a TTL)              │
 *        │                                                 │
 *   4. Decide: exists? active? not expired? ◄──────────────┘
 *
 * "Cache-aside" (lazy loading): the APPLICATION manages the cache. Redis
 * never talks to PostgreSQL; entries are filled on demand by the first
 * request that misses, so only links that are actually clicked take memory.
 *
 * @returns {{ url: {id, originalUrl, isActive, expiresAt}, cacheStatus: 'HIT'|'MISS'|'BYPASS' }}
 */
export async function resolveShortCode(shortCode) {
  const cached = await getCachedUrl(shortCode);

  let url;
  if (cached.status === 'HIT') {
    url = cached.url;
  } else {
    url = await prisma.url.findUnique({
      where: { shortCode }, // unique index lookup
      select: { id: true, originalUrl: true, isActive: true, expiresAt: true },
    });
    if (cached.status === 'MISS') {
      await cacheUrl(shortCode, url); // caches "missing" too (url = null)
    }
  }

  if (!url) throw new NotFoundError('Short link not found');

  // Checked on EVERY request, hits included, so expiry is exact.
  const status = getUrlStatus(url);
  if (status === 'inactive') throw new GoneError('This short link has been deactivated');
  if (status === 'expired') throw new GoneError('This short link has expired');

  return { url, cacheStatus: cached.status };
}
