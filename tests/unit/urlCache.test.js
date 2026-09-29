import { describe, expect, it } from 'vitest';
import { cacheUrl, getCachedUrl, invalidateUrl } from '../../src/services/urlCache.service.js';

// Unit tests never connect to Redis, which makes this the "Redis is down" case.
describe('URL cache when Redis is unavailable', () => {
  it('reports BYPASS immediately, so callers fall back to PostgreSQL', async () => {
    const started = performance.now();
    expect(await getCachedUrl('abc')).toEqual({ status: 'BYPASS' });
    expect(performance.now() - started).toBeLessThan(20); // fails fast, no timeout wait
  });

  it('silently skips writes and invalidations instead of throwing', async () => {
    await expect(cacheUrl('abc', { id: 1, originalUrl: 'https://a.com', isActive: true, expiresAt: null })).resolves.toBeUndefined();
    await expect(invalidateUrl('abc')).resolves.toBeUndefined();
  });
});
