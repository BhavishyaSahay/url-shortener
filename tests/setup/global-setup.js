import { execFileSync } from 'node:child_process';
import { TEST_DATABASE_URL } from './test-database.js';

// Runs once before the integration tests: bring the test database's schema up to date.
export default function setup() {
  if (!TEST_DATABASE_URL.includes('_test')) throw new Error('Refusing to run tests against a non-test database');
  execFileSync('npx', ['prisma', 'migrate', 'deploy'], {
    env: { ...process.env, DATABASE_URL: TEST_DATABASE_URL, PRISMA_HIDE_UPDATE_MESSAGE: '1' },
    stdio: 'pipe',
  });
}
