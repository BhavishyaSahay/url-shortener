// Analytics worker: a separate process that takes clicks off the Redis queue
// and stores them in PostgreSQL, so redirects never wait for a database write.
//
//   npm run worker
import { setTimeout as sleep } from 'node:timers/promises';
import { prisma } from '../src/config/database.js';
import { connectRedis, redis } from '../src/config/redis.js';
import { CLICKS_QUEUE } from '../src/services/clicks.service.js';
import { logger } from '../src/utils/logger.js';
import { saveClick } from './analytics.processor.js';

let running = true;

async function run() {
  await connectRedis();
  logger.info('Analytics worker started');

  while (running) {
    try {
      // BRPOP waits (up to 5 s) until a click is in the queue, then removes and
      // returns it. Returns null if nothing arrived in time.
      const item = await redis.brpop(CLICKS_QUEUE, 5);
      if (item) await saveClick(item[1]);
    } catch {
      await sleep(1000); // Redis unavailable: wait, then try again
    }
  }

  await prisma.$disconnect();
  redis.disconnect();
  logger.info('Analytics worker stopped');
  process.exit(0);
}

// Graceful shutdown: finish the current click, then exit (within 5 s, the BRPOP timeout).
process.on('SIGTERM', () => (running = false));
process.on('SIGINT', () => (running = false));

run();
