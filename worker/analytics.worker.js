// Analytics worker: a separate Node.js process (not part of the API) that
// consumes click events from a Redis Stream and writes analytics to PostgreSQL.
//
//   npm run worker        (SERVICE_NAME=analytics-worker node worker/analytics.worker.js)
//
// Running it separately means analytics can be scaled, restarted or even be
// down without affecting redirects. The stream holds the events meanwhile.
import http from 'node:http';
import { config } from '../src/config/env.js';
import { connectDatabase, disconnectDatabase } from '../src/config/database.js';
import { logger } from '../src/utils/logger.js';
import { startClickConsumer } from './analytics.consumer.js';

let consumer;

// Minimal health endpoint: the worker has no other HTTP server, but Docker's
// HEALTHCHECK (and later Prometheus) needs something to ask. It answers 200
// while the process is alive, even while still waiting for Redis or
// retrying a failed batch: those are recoverable states, not reasons to restart.
const healthServer = http.createServer((req, res) => {
  if (req.url !== '/health') {
    res.writeHead(404).end();
    return;
  }
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(
    JSON.stringify({
      status: 'ok',
      uptimeSeconds: Math.round(process.uptime()),
      ...(consumer ? consumer.getStatus() : { consuming: false }),
    }),
  );
});

async function start() {
  healthServer.listen(config.workerHealthPort, () => {
    logger.info({ port: config.workerHealthPort }, 'Worker health endpoint listening');
  });

  // Unlike the API, the worker genuinely NEEDS its dependencies: it waits for
  // PostgreSQL (with retries), and the consumer waits for Redis.
  await connectDatabase();
  consumer = await startClickConsumer();
  logger.info({ stream: config.clicks.stream, group: config.clicks.consumerGroup }, 'Analytics worker consuming');
}

// Graceful shutdown: let the current batch finish and be acknowledged. Anything
// not yet acknowledged stays pending in the stream and is picked up next time.
let shuttingDown = false;
async function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info({ signal }, 'Worker shutdown started');

  const forceExit = setTimeout(() => {
    logger.error('Worker shutdown timed out, forcing exit');
    process.exit(1);
  }, config.shutdownTimeoutMs);
  forceExit.unref();

  try {
    healthServer.close();
    await consumer?.stop();
    await disconnectDatabase();
    logger.info('Worker shutdown complete');
    process.exit(0);
  } catch (err) {
    logger.error({ err }, 'Error during worker shutdown');
    process.exit(1);
  }
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('unhandledRejection', (reason) => {
  logger.fatal({ err: reason }, 'Unhandled promise rejection');
  process.exit(1);
});

start().catch((err) => {
  logger.fatal({ err }, 'Analytics worker failed to start');
  process.exit(1);
});
