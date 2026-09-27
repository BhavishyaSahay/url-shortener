import { config } from './config/env.js';
import { logger } from './utils/logger.js';
import { createApp } from './app.js';

const app = createApp();

const server = app.listen(config.port, () => {
  logger.info({ port: config.port, env: config.env }, 'API server listening');
});

// ---------------------------------------------------------------------------
// Graceful shutdown
// ---------------------------------------------------------------------------
// Docker sends SIGTERM when stopping a container (Ctrl+C sends SIGINT). Instead
// of dying immediately and cutting off in-flight requests, we:
//   1. stop accepting new connections
//   2. let in-flight requests finish
//   3. close connections to external services (PostgreSQL, Redis, Kafka; added in later phases)
//   4. exit
// If this takes longer than SHUTDOWN_TIMEOUT_MS we force-exit, because Docker
// will SIGKILL us anyway after its own grace period (10s by default).
let shuttingDown = false;

async function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info({ signal }, 'Shutdown started');

  const forceExitTimer = setTimeout(() => {
    logger.error('Shutdown timed out, forcing exit');
    process.exit(1);
  }, config.shutdownTimeoutMs);
  forceExitTimer.unref();

  try {
    // server.close() stops new connections and resolves once active requests
    // finish. Node closes idle keep-alive connections automatically.
    await new Promise((resolve, reject) => {
      server.close((err) => (err ? reject(err) : resolve()));
    });
    logger.info('HTTP server closed');

    // Later phases disconnect external clients here, e.g.:
    //   await prisma.$disconnect();   (Phase 2)
    //   await redis.quit();           (Phase 5)
    //   await kafkaProducer.disconnect(); (Phase 6)

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
