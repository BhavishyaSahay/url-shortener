import { defineConfig } from 'vitest/config';
import { TEST_DATABASE_URL, TEST_REDIS_URL } from './tests/setup/test-database.js';

export default defineConfig({
  test: {
    environment: 'node',
    env: {
      NODE_ENV: 'test',
      LOG_LEVEL: 'silent',
      DATABASE_URL: TEST_DATABASE_URL,
      REDIS_URL: TEST_REDIS_URL,
      JWT_SECRET: 'test-only-jwt-secret-at-least-32-characters-long',
    },
    projects: [
      { extends: true, test: { name: 'unit', include: ['tests/unit/**/*.test.js'] } },
      {
        extends: true,
        test: {
          name: 'integration',
          include: ['tests/integration/**/*.test.js'],
          globalSetup: ['tests/setup/global-setup.js'], // applies migrations to the test database
          setupFiles: ['tests/setup/integration.setup.js'],
          fileParallelism: false, // the files share one test database
          testTimeout: 15_000,
        },
      },
    ],
  },
});
