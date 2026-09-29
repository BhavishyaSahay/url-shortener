import { defineConfig } from 'vitest/config';
import { TEST_DATABASE_URL, TEST_REDIS_URL } from './tests/setup/test-database.js';

// A fresh Kafka topic and consumer group per test run (the e2e test deletes the
// topic afterwards). Events left over from an earlier run can never leak in.
const runId = Date.now();

export default defineConfig({
  test: {
    environment: 'node',
    env: {
      NODE_ENV: 'test',
      LOG_LEVEL: 'silent',
      // Unit tests never connect, but config validation requires a value.
      DATABASE_URL: TEST_DATABASE_URL,
      // Fixed, test-only secret (never used outside tests).
      JWT_SECRET: 'test-only-jwt-secret-at-least-32-characters-long',
      JWT_EXPIRES_IN: '1d',
      REDIS_URL: TEST_REDIS_URL,
      // Small limits so tests can reach them quickly.
      RATE_LIMIT_LOGIN_MAX: '5',
      RATE_LIMIT_LOGIN_WINDOW: '15m',
      RATE_LIMIT_CREATE_URL_MAX: '50',
      RATE_LIMIT_CREATE_URL_WINDOW: '1m',
      KAFKA_BROKERS: process.env.TEST_KAFKA_BROKERS ?? 'localhost:9092',
      KAFKA_CLICKS_TOPIC: `url-clicks-test-${runId}`,
      KAFKA_CONSUMER_GROUP: `analytics-worker-test-${runId}`,
    },
    projects: [
      {
        extends: true,
        test: {
          name: 'unit',
          include: ['tests/unit/**/*.test.js'],
        },
      },
      {
        extends: true,
        test: {
          name: 'integration',
          include: ['tests/integration/**/*.test.js'],
          globalSetup: ['tests/setup/global-setup.js'],
          setupFiles: ['tests/setup/integration.setup.js'],
          // All integration test files share one database, so run them one at a
          // time to stop them from truncating each other's data mid-test.
          fileParallelism: false,
        },
      },
    ],
  },
});
