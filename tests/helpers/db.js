import { prisma } from '../../src/config/database.js';
import { redis } from '../../src/config/redis.js';

/** Empty every table and the test Redis database, so each test starts clean. */
export async function resetState() {
  await prisma.$executeRaw`TRUNCATE TABLE click_events, urls, users RESTART IDENTITY CASCADE`;
  await redis.flushdb();
}

export { prisma };
