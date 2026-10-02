import { isRedisReady, redis } from '../config/redis.js';
import { TooManyRequestsError } from '../utils/errors.js';

// Fixed-window rate limiting in Redis.
// Time is split into windows (e.g. 15 minutes); each client gets one counter
// per window. INCR is atomic, so concurrent requests can't miscount, and Redis
// is shared by every API instance, so the limit holds across all of them.
export function getWindow(nowMs, windowSeconds) {
  const windowMs = windowSeconds * 1000;
  const windowId = Math.floor(nowMs / windowMs);
  const secondsLeft = Math.ceil(((windowId + 1) * windowMs - nowMs) / 1000);
  return { windowId, secondsLeft };
}

function rateLimit({ name, max, windowSeconds, key }) {
  return async (req, res, next) => {
    // Fail open: if Redis is down, allow the request rather than block everyone.
    if (!isRedisReady()) return next();

    const { windowId, secondsLeft } = getWindow(Date.now(), windowSeconds);
    const redisKey = `ratelimit:${name}:${key(req)}:${windowId}`;
    try {
      // MULTI runs both commands together: increment, and expire the counter after the window.
      const [[, count]] = await redis.multi().incr(redisKey).expire(redisKey, windowSeconds).exec();
      if (count > max) return next(TooManyRequestsError(secondsLeft));
    } catch {
      // Redis error: fail open
    }
    next();
  };
}

// 10 login attempts per 15 minutes per IP address (slows down password guessing).
export const loginRateLimit = rateLimit({ name: 'login', max: 10, windowSeconds: 15 * 60, key: (req) => req.ip });

// 30 new short URLs per minute per user.
export const createUrlRateLimit = rateLimit({ name: 'create', max: 30, windowSeconds: 60, key: (req) => req.user.id });
