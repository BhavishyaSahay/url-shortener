import { execFileSync } from 'node:child_process';
import { TEST_DATABASE_URL } from './test-database.js';

// Runs once before the integration test suite: brings the test database schema
// up to date by applying any pending migrations. This is the same
// non-destructive command used in production (`prisma migrate deploy`), and it
// creates the database if it doesn't exist yet.
// Test DATA isolation is handled separately: each test truncates the tables
// (see tests/helpers/db.js).
export default function setup() {
  const dbName = new URL(TEST_DATABASE_URL).pathname.slice(1);

  // Safety net: tests truncate tables, so never run them against a database
  // that doesn't look like a test database.
  if (!dbName.endsWith('_test')) {
    throw new Error(`Refusing to use database "${dbName}" for tests: test database names must end with "_test"`);
  }

  execFileSync('npx', ['prisma', 'migrate', 'deploy'], {
    env: { ...process.env, DATABASE_URL: TEST_DATABASE_URL, PRISMA_HIDE_UPDATE_MESSAGE: '1' },
    stdio: 'pipe',
  });
}
