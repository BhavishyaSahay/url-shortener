import { createHash } from 'node:crypto';
import { config } from '../config/env.js';
import { isRedisReady, redis } from '../config/redis.js';
import { TooManyRequestsError } from '../utils/errors.js';
import { logger } from '../utils/logger.js';

// ---------------------------------------------------------------------------
// Fixed-window rate limiting, stored in Redis
// ---------------------------------------------------------------------------
// Time is cut into fixed windows (e.g. 15-minute blocks). Each client gets
// one counter per window:
//
//   key: rl:login:ip:203.0.113.7:1932117     (1932117 = window number)
//   INCR  → 1, 2, 3 …   request allowed while count ≤ max
//   EXPIRE after one window, so old counters delete themselves
//
// Why Redis rather than a JS object in memory? With two API instances behind
// Nginx, an in-memory counter per instance would let a client make 2x max
// requests. Redis is shared by all instances, and INCR is atomic, so two
// simultaneous requests can never both read "9" and both write "10".

/** Which window `nowMs` falls in, and how many seconds until it resets. Pure, so easy to unit test. */
export function getFixedWindow(nowMs, windowSeconds) {
  const windowMs = windowSeconds * 1000;
  const windowId = Math.floor(nowMs / windowMs);
  const resetSeconds = Math.ceil(((windowId + 1) * windowMs - nowMs) / 1000);
  return { windowId, resetSeconds };
}

/**
 * Count one request against `key`. Returns { count, resetSeconds }, or null
 * if Redis is unavailable.
 */
async function hit(key, windowSeconds) {
  if (!isRedisReady()) return null;
  const { windowId, resetSeconds } = getFixedWindow(Date.now(), windowSeconds);
  const redisKey = `rl:${key}:${windowId}`;
  try {
    // MULTI/EXEC runs both commands as one atomic unit, so a counter is never
    // left without an expiry (which would leak memory).
    const [[incrErr, count], [expireErr]] = await redis.multi().incr(redisKey).expire(redisKey, windowSeconds).exec();
    if (incrErr || expireErr) throw incrErr || expireErr;
    return { count, resetSeconds };
  } catch (err) {
    logger.warn({ err, key }, 'Rate limiter Redis error, allowing request');
    return null;
  }
}

/**
 * Build a rate-limiting middleware.
 * @param {object} options
 * @param {string} options.name            namespace for the Redis keys
 * @param {number} options.max             requests allowed per window
 * @param {number} options.windowSeconds   window length
 * @param {(req) => string|null} options.keyFn  who to count against (IP, user ID…); null = skip
 * @param {string} options.message         error message for 429 responses
 */
export function rateLimit({ name, max, windowSeconds, keyFn, message }) {
  return async function rateLimitMiddleware(req, res, next) {
    const identifier = keyFn(req);
    if (!identifier) return next();

    const result = await hit(`${name}:${identifier}`, windowSeconds);

    // FAIL OPEN: if Redis is down we let requests through rather than
    // rejecting every login. Availability beats strict limiting here; the
    // trade-off is weaker brute-force protection during a Redis outage.
    if (!result) return next();

    // Standard headers so well-behaved clients can slow down on their own.
    res.set({
      'RateLimit-Limit': String(max),
      'RateLimit-Remaining': String(Math.max(0, max - result.count)),
      'RateLimit-Reset': String(result.resetSeconds),
    });

    if (result.count > max) {
      req.log?.warn({ limiter: name, count: result.count, max }, 'Rate limit exceeded');
      throw new TooManyRequestsError(message, result.resetSeconds);
    }
    next();
  };
}

// Emails are hashed in Redis keys, so the cache doesn't hold a readable list
// of who is trying to log in.
function emailKey(email) {
  if (typeof email !== 'string' || !email.trim()) return null;
  return createHash('sha256').update(email.trim().toLowerCase()).digest('hex').slice(0, 32);
}

// Login is limited two ways:
//   per IP     stops one machine from trying many accounts (credential stuffing)
//   per email  stops many machines from guessing one account's password
export const loginRateLimit = [
  rateLimit({
    name: 'login:ip',
    ...config.rateLimit.login,
    keyFn: (req) => req.ip,
    message: 'Too many login attempts, please try again later',
  }),
  rateLimit({
    name: 'login:email',
    ...config.rateLimit.login,
    keyFn: (req) => emailKey(req.body?.email),
    message: 'Too many login attempts for this account, please try again later',
  }),
];

// URL creation is limited per user (routes run requireAuth first).
export const createUrlRateLimit = rateLimit({
  name: 'create-url',
  ...config.rateLimit.createUrl,
  keyFn: (req) => (req.user ? `user:${req.user.id}` : req.ip),
  message: 'Too many URLs created, please slow down',
});
