import { config } from './config/env.js';
import { prisma } from './config/database.js';
import { connectRedis, redis } from './config/redis.js';
import { createApp } from './app.js';
import { logger } from './utils/logger.js';

await connectRedis();
const server = createApp().listen(config.port, () => logger.info(`API listening on port ${config.port}`));

// Graceful shutdown: Docker sends SIGTERM when stopping or redeploying a container.
// Stop accepting new requests, let in-flight ones finish, then close connections.
function shutdown(signal) {
  logger.info({ signal }, 'Shutting down');
  setTimeout(() => process.exit(1), 10_000).unref(); // give up after 10 s
  server.close(async () => {
    await prisma.$disconnect();
    await redis.quit().catch(() => {});
    process.exit(0);
  });
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
