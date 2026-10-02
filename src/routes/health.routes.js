import { Router } from 'express';
import { isDatabaseHealthy } from '../config/database.js';
import { isRedisReady } from '../config/redis.js';

const router = Router();

// Liveness: is the process running? Docker uses this to restart a crashed container.
// It deliberately doesn't check the database: a database outage isn't fixed by
// restarting the API.
router.get('/health', (req, res) => res.json({ status: 'ok' }));

// Readiness: can this instance serve requests? PostgreSQL is required (503 if
// it's down). Redis is reported but optional: the app still works without it.
router.get('/ready', async (req, res) => {
  const database = await isDatabaseHealthy();
  res.status(database ? 200 : 503).json({
    status: database ? 'ready' : 'not_ready',
    checks: { database: database ? 'up' : 'down', redis: isRedisReady() ? 'up' : 'down' },
  });
});

export default router;
