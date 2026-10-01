import { Router } from 'express';
import { isDatabaseHealthy } from '../config/database.js';
import { isRedisHealthy } from '../config/redis.js';

const router = Router();

// Liveness check: "is this Node process running and able to serve HTTP?"
// It deliberately does NOT check PostgreSQL or Redis. If it did, a database
// outage would make Docker/AWS think every API container is broken and restart
// them all, which doesn't fix the database.
router.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    uptimeSeconds: Math.round(process.uptime()),
    timestamp: new Date().toISOString(),
  });
});

// Readiness check: "should this instance receive traffic right now?"
// A load balancer (Nginx/AWS) stops routing to an instance that returns 503
// here, but does not restart it.
//
// Dependencies are split into two kinds:
//   critical      PostgreSQL: without it we can't serve anything → 503
//   non-critical  Redis: we still work without it: slower (no cache), no rate
//                 limiting, click events dropped → 200 "degraded". Failing
//                 readiness here would pull EVERY instance out of rotation
//                 during a cache outage, turning "degraded" into "completely down".
router.get('/ready', async (req, res) => {
  // During graceful shutdown, report not-ready so traffic drains away
  // before the process exits.
  if (req.app.locals.isShuttingDown) {
    return res.status(503).json({ status: 'shutting_down' });
  }

  const [databaseUp, redisUp] = await Promise.all([isDatabaseHealthy(), isRedisHealthy()]);
  const checks = {
    database: databaseUp ? 'up' : 'down',
    redis: redisUp ? 'up' : 'down',
  };

  if (!databaseUp) return res.status(503).json({ status: 'not_ready', checks });
  res.json({ status: redisUp ? 'ready' : 'degraded', checks });
});

export default router;
