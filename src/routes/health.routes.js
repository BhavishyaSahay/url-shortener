import { Router } from 'express';

const router = Router();

// Liveness check: "is this Node process running and able to serve HTTP?"
// It deliberately does NOT check PostgreSQL/Redis/Kafka. If it did, a database
// outage would make Docker/AWS think every API container is broken and restart
// them all, which doesn't fix the database. Dependency checks belong in
// GET /ready (added once we have dependencies, in Phase 2+).
router.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    uptimeSeconds: Math.round(process.uptime()),
    timestamp: new Date().toISOString(),
  });
});

export default router;
