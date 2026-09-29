import { config } from './config/env.js';
import { connectDatabase, disconnectDatabase } from './config/database.js';
import { connectRedis, disconnectRedis } from './config/redis.js';
import { logger } from './utils/logger.js';
import { createApp } from './app.js';

const app = createApp();
let server;

// Startup order matters: connect to dependencies FIRST, then accept traffic.
// If PostgreSQL is still starting (common with Docker Compose), connectDatabase
// retries. The API never listens while pretending the database is available.
async function start() {
  await connectDatabase(); // required: waits/retries, exits if it never comes up
  await connectRedis(); // optional: never blocks startup, reconnects in the background

  server = app.listen(config.port, () => {
    logger.info({ port: config.port, env: config.env }, 'API server listening');
  });
}

// ---------------------------------------------------------------------------
// Graceful shutdown
// ---------------------------------------------------------------------------
// Docker sends SIGTERM when stopping a container (Ctrl+C sends SIGINT). Instead
// of dying immediately and cutting off in-flight requests, we:
//   1. mark the instance not-ready (GET /ready returns 503)
//   2. stop accepting new connections and let in-flight requests finish
//   3. close connections to external services
//   4. exit
// If this takes longer than SHUTDOWN_TIMEOUT_MS we force-exit, because Docker
// will SIGKILL us anyway after its own grace period (10s by default).
let shuttingDown = false;

async function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  app.locals.isShuttingDown = true;
  logger.info({ signal }, 'Shutdown started');

  const forceExitTimer = setTimeout(() => {
    logger.error('Shutdown timed out, forcing exit');
    process.exit(1);
  }, config.shutdownTimeoutMs);
  forceExitTimer.unref();

  try {
    // server.close() stops new connections and resolves once active requests
    // finish. Node closes idle keep-alive connections automatically.
    // `server` is undefined if the signal arrived while still connecting on startup.
    if (server) {
      await new Promise((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
      });
      logger.info('HTTP server closed');
    }

    // Close external clients only after in-flight requests have finished,
    // because those requests may still need the database.
    await Promise.all([disconnectDatabase(), disconnectRedis()]);
    // Phase 6: await kafkaProducer.disconnect();

    logger.info('Shutdown complete');
    process.exit(0);
  } catch (err) {
    logger.error({ err }, 'Error during shutdown');
    process.exit(1);
  }
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

// A bug that escapes all handlers leaves the process in an unknown state.
// Log it and exit; Docker's restart policy will start a fresh container.
process.on('unhandledRejection', (reason) => {
  logger.fatal({ err: reason }, 'Unhandled promise rejection');
  process.exit(1);
});
process.on('uncaughtException', (err) => {
  logger.fatal({ err }, 'Uncaught exception');
  process.exit(1);
});

start().catch((err) => {
  logger.fatal({ err }, 'Failed to start API server');
  process.exit(1);
});
