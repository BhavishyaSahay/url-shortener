import 'dotenv/config';

// Integration tests run against their own database, which is wiped before
// every run. Never point this at your development or production database.
export const TEST_DATABASE_URL =
  process.env.TEST_DATABASE_URL ?? 'postgresql://postgres:postgres@localhost:5433/url_shortener_test';

// Redis logical database 1 (development uses 0). Flushed between tests.
export const TEST_REDIS_URL = process.env.TEST_REDIS_URL ?? 'redis://localhost:6380/1';
