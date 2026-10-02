import { recordClick } from '../services/clicks.service.js';
import { resolveShortCode } from '../services/redirect.service.js';
import { NotFoundError } from '../utils/errors.js';

const SHORT_CODE = /^[A-Za-z0-9_-]{1,32}$/;

// "https://www.twitter.com/some/post" → "www.twitter.com"; none/invalid → null (a direct visit)
function referrerHost(referrer) {
  try {
    return new URL(referrer).hostname;
  } catch {
    return null;
  }
}

// GET /:shortCode
export async function redirect(req, res) {
  const { shortCode } = req.params;
  if (!SHORT_CODE.test(shortCode)) throw NotFoundError('Short link not found');

  const { url, cacheStatus } = await resolveShortCode(shortCode);

  res.set('X-Cache', cacheStatus); // HIT = served from Redis, MISS = read from PostgreSQL
  // 302 (temporary), not 301 (permanent): browsers cache 301s and would skip
  // our server next time, so edits, deactivation and click counting would stop working.
  res.set('Cache-Control', 'no-store');
  res.redirect(302, url.originalUrl);

  // After responding: queue the click for the analytics worker, without waiting.
  void recordClick({
    urlId: url.id,
    clickedAt: new Date().toISOString(),
    referrer: referrerHost(req.get('referer')),
    userAgent: req.get('user-agent')?.slice(0, 255) ?? null,
  });
}
