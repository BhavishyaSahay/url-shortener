import { defineConfig } from 'vitest/config';
import { TEST_DATABASE_URL } from './tests/setup/test-database.js';

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
