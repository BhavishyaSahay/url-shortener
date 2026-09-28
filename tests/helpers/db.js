import { prisma } from '../../src/config/database.js';

/** Empty all tables and restart ID sequences, so each test starts from a clean state. */
export async function resetTables() {
  await prisma.$executeRaw`TRUNCATE TABLE urls, users RESTART IDENTITY CASCADE`;
}

export function createUser(overrides = {}) {
  return prisma.user.create({
    data: { email: `user${Math.random().toString(36).slice(2, 8)}@example.com`, passwordHash: 'not-a-real-hash', ...overrides },
  });
}

export { prisma };
