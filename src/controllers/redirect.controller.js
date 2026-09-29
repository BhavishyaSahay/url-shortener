import { buildClickEvent, publishClickEvent } from '../services/clickEvent.service.js';
import * as redirectService from '../services/redirect.service.js';
import { NotFoundError } from '../utils/errors.js';

// Anything that can't possibly be a short code (e.g. "favicon.ico", or 500
// characters of junk) is rejected before touching Redis or PostgreSQL.
const SHORT_CODE_PATTERN = /^[A-Za-z0-9_-]{1,32}$/;

export async function redirect(req, res) {
  const { shortCode } = req.params;
  if (!SHORT_CODE_PATTERN.test(shortCode)) {
    throw new NotFoundError('Short link not found');
  }

  const { url, cacheStatus } = await redirectService.resolveShortCode(shortCode);

  // Debug header: HIT (served from Redis), MISS (from PostgreSQL, now cached),
  // or BYPASS (Redis unavailable). Handy with curl -I and in the load tests.
  res.set('X-Cache', cacheStatus);

  // 302 (temporary), not 301 (permanent): browsers cache 301s indefinitely
  // and would skip our server on later clicks. Then deactivating or editing
  // the link wouldn't take effect, and those clicks would be missing from
  // analytics. no-store keeps the redirect itself out of browser/proxy caches.
  res.set('Cache-Control', 'private, no-store');
  res.redirect(302, url.originalUrl);

  // Analytics happen AFTER the response is sent, and are not awaited: the
  // user never waits for Kafka, and a Kafka failure can't break the redirect.
  // HEAD requests (link checkers, some previewers) aren't counted as clicks.
  if (req.method === 'GET') {
    void publishClickEvent(
      buildClickEvent({
        url,
        shortCode,
        ip: req.ip,
        userAgent: req.get('user-agent'),
        referrer: req.get('referer'),
      }),
    );
  }
}
