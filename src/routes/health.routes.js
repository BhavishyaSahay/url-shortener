import { Router } from 'express';
import { isDatabaseHealthy } from '../config/database.js';

const router = Router();

// Liveness check: "is this Node process running and able to serve HTTP?"
// It deliberately does NOT check PostgreSQL/Redis/Kafka. If it did, a database
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
// Checks the dependencies a request needs. A load balancer (Nginx/AWS) stops
// routing to an instance that returns 503 here, but does not restart it.
// Redis (Phase 5) and Kafka (Phase 6) checks are added here later.
router.get('/ready', async (req, res) => {
  // During graceful shutdown, report not-ready so traffic drains away
  // before the process exits.
  if (req.app.locals.isShuttingDown) {
    return res.status(503).json({ status: 'shutting_down' });
  }

  const checks = {
    database: (await isDatabaseHealthy()) ? 'up' : 'down',
  };
  const ready = Object.values(checks).every((status) => status === 'up');

  res.status(ready ? 200 : 503).json({ status: ready ? 'ready' : 'not_ready', checks });
});

export default router;
