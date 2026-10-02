import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '@prisma/client';
import { config } from './env.js';

// Prisma talks to PostgreSQL through the node-postgres driver adapter, which
// keeps a connection pool (10 connections by default) shared by all requests.
export const prisma = new PrismaClient({
  adapter: new PrismaPg({ connectionString: config.databaseUrl }),
});

/** Used by GET /ready. */
export async function isDatabaseHealthy() {
  try {
    await prisma.$queryRaw`SELECT 1`;
    return true;
  } catch {
    return false;
  }
}
