import { afterAll } from 'vitest';
import { disconnectDatabase } from '../../src/config/database.js';

// Each test file gets its own connection pool; close it when the file finishes.
afterAll(async () => {
  await disconnectDatabase();
});
