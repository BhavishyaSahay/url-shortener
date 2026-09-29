import { prisma } from '../../src/config/database.js';
import { isRedisReady, redis } from '../../src/config/redis.js';

/**
 * Empty all tables (restarting ID sequences) and the test Redis database, so
 * each test starts from a clean state: no cached URLs, no rate-limit counters.
 */
export async function resetTables() {
  await prisma.$executeRaw`TRUNCATE TABLE click_events, url_daily_stats, urls, users RESTART IDENTITY CASCADE`;
  if (isRedisReady()) await redis.flushdb(); // flushes only the test DB (/1)
}

export function createUser(overrides = {}) {
  return prisma.user.create({
    data: { email: `user${Math.random().toString(36).slice(2, 8)}@example.com`, passwordHash: 'not-a-real-hash', ...overrides },
  });
}

export { prisma };
