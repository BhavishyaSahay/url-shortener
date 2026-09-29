import { afterAll, beforeAll } from 'vitest';
import { disconnectDatabase } from '../../src/config/database.js';
import { connectRedis, disconnectRedis } from '../../src/config/redis.js';

// Each test file gets its own connection pool and Redis client.
beforeAll(async () => {
  await connectRedis();
});

afterAll(async () => {
  await Promise.all([disconnectDatabase(), disconnectRedis()]);
});
