// Analytics worker: a separate Node.js process (not part of the API) that
// consumes click events from Kafka and writes analytics to PostgreSQL.
//
//   npm run worker        (SERVICE_NAME=analytics-worker node worker/analytics.worker.js)
//
// Running it separately means analytics can be scaled, restarted or even be
// down without affecting redirects. Kafka holds the events meanwhile.
import http from 'node:http';
import { setTimeout as sleep } from 'node:timers/promises';
import { config } from '../src/config/env.js';
import { connectDatabase, disconnectDatabase } from '../src/config/database.js';
import { ensureClickTopic } from '../src/config/kafka.js';
import { logger } from '../src/utils/logger.js';
import { startClickConsumer } from './analytics.consumer.js';

let consumer;
let consuming = false;

// Minimal health endpoint: the worker has no other HTTP server, but Docker's
// HEALTHCHECK (and later Prometheus) needs something to ask. It answers 200
// while the process is alive: even while still waiting for Kafka, because
// that's startup, not a fault. A crashed consumer exits the process anyway.
const healthServer = http.createServer((req, res) => {
  if (req.url !== '/health') {
    res.writeHead(404).end();
    return;
  }
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ status: 'ok', consuming, uptimeSeconds: Math.round(process.uptime()) }));
});

async function start() {
  healthServer.listen(config.workerHealthPort, () => {
    logger.info({ port: config.workerHealthPort }, 'Worker health endpoint listening');
  });

  // Unlike the API, the worker genuinely NEEDS both dependencies: there's
  // nothing useful it can do without them, so it waits (with retries) for both.
  await connectDatabase();
  await ensureClickTopic();

  consumer = await startClickConsumer({ onCrash: crash });
  consumer.on(consumer.events.GROUP_JOIN, () => {
    consuming = true;
  });
  logger.info({ topic: config.kafka.clicksTopic, group: config.kafka.consumerGroup }, 'Analytics worker consuming');
}

// The consumer gave up (e.g. Kafka unreachable for too long). Exit non-zero so
// the supervisor restarts a fresh worker, which resumes from the last committed
// offset. Don't wait long on a broken consumer's disconnect.
async function crash(err) {
  logger.fatal({ err }, 'Kafka consumer crashed, exiting so the supervisor can restart the worker');
  await Promise.race([consumer?.disconnect(), sleep(3_000)]).catch(() => {});
  await disconnectDatabase().catch(() => {});
  process.exit(1);
}

// Graceful shutdown: disconnecting the consumer finishes the current batch,
// commits its offsets and leaves the group cleanly, so the partitions are
// reassigned immediately instead of after the session timeout.
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
    consuming = false;
    healthServer.close();
    await consumer?.disconnect();
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
