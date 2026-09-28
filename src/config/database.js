import { setTimeout as sleep } from 'node:timers/promises';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '@prisma/client';
import pg from 'pg';
import { config } from './env.js';
import { logger } from '../utils/logger.js';

// ---------------------------------------------------------------------------
// Connection pool
// ---------------------------------------------------------------------------
// Opening a PostgreSQL connection is expensive (TCP + auth + a new backend
// process on the server). A pool opens a few connections and reuses them
// across requests. When all `max` connections are busy, further queries wait
// in a queue instead of opening more connections and overwhelming Postgres.
//
// Rough budget: (API instances x DB_POOL_MAX) + worker pool < Postgres max_connections (100).
export const pool = new pg.Pool({
  connectionString: config.database.url,
  max: config.database.poolMax,
  idleTimeoutMillis: 30_000, // close connections idle for 30s
  connectionTimeoutMillis: 5_000, // fail fast instead of hanging if Postgres is unreachable
});

// An idle connection can fail when Postgres restarts. Without this listener that
// 'error' event would crash the process. The pool drops the broken connection
// and opens a new one on the next query.
pool.on('error', (err) => {
  logger.error({ err }, 'Idle PostgreSQL connection error');
});

// Prisma 7 talks to the database through a "driver adapter". PrismaPg runs
// Prisma's queries on our node-postgres pool, so we control the pool
// settings and can read its stats (used for metrics in Phase 10).
// Query errors are not logged here: they propagate to the caller, and
// unexpected ones are logged once by the central error handler.
export const prisma = new PrismaClient({
  adapter: new PrismaPg(pool),
  log: [{ emit: 'event', level: 'warn' }],
});
prisma.$on('warn', (e) => logger.warn({ prisma: e.message }, 'Prisma warning'));

// Connection errors carry the useful part in `code` (e.g. ECONNREFUSED);
// Prisma's message is mostly whitespace in that case.
const describeDbError = (err) => err.code || err.message?.trim() || 'unknown error';

// ---------------------------------------------------------------------------
// Lifecycle helpers used by server.js and GET /ready
// ---------------------------------------------------------------------------

/**
 * Wait until PostgreSQL accepts queries, retrying with exponential backoff.
 * In Docker, the API container may start before Postgres is ready. Instead of
 * crashing (or serving requests that will all fail), the API waits.
 */
export async function connectDatabase({ maxAttempts = 10, initialDelayMs = 500 } = {}) {
  for (let attempt = 1; ; attempt++) {
    try {
      await prisma.$queryRaw`SELECT 1`;
      logger.info('Connected to PostgreSQL');
      return;
    } catch (err) {
      if (attempt >= maxAttempts) {
        throw new Error(`Could not connect to PostgreSQL after ${attempt} attempts: ${describeDbError(err)}`, {
          cause: err,
        });
      }
      const delayMs = Math.min(initialDelayMs * 2 ** (attempt - 1), 10_000);
      logger.warn({ attempt, maxAttempts, retryInMs: delayMs, reason: describeDbError(err) }, 'PostgreSQL not ready, retrying');
      await sleep(delayMs);
    }
  }
}

/** Readiness probe: true if a trivial query succeeds within the timeout. */
export async function isDatabaseHealthy(timeoutMs = 2_000) {
  try {
    await Promise.race([
      prisma.$queryRaw`SELECT 1`,
      // ref: false, so a leftover timer never keeps the process alive
      sleep(timeoutMs, undefined, { ref: false }).then(() => {
        throw new Error('Database health check timed out');
      }),
    ]);
    return true;
  } catch {
    return false;
  }
}

/** Close Prisma, then the pool (we created the pool, so we must end it). */
export async function disconnectDatabase() {
  await prisma.$disconnect();
  await pool.end();
  logger.info('PostgreSQL pool closed');
}
