import { afterAll, beforeAll } from 'vitest';
import { prisma } from '../../src/config/database.js';
import { connectRedis, redis } from '../../src/config/redis.js';

beforeAll(connectRedis);
afterAll(async () => {
  await prisma.$disconnect();
  await redis.quit().catch(() => {});
});
