import dotenv from 'dotenv';
import { z } from 'zod';

// Load .env into process.env for local development. In Docker/production the
// variables are injected by the environment, and dotenv never overrides them.
dotenv.config({ quiet: true });

// Every environment variable the app reads is declared and validated here.
// If something is missing or malformed we crash at startup with a clear
// message, instead of failing later in the middle of a request.
const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  LOG_LEVEL: z
    .enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'])
    .default('info'),
  // Public base URL used when building short links, e.g. https://short.ly
  APP_BASE_URL: z.url().default('http://localhost:3000'),
  // How long to wait for in-flight requests to finish on SIGTERM before forcing exit.
  SHUTDOWN_TIMEOUT_MS: z.coerce.number().int().positive().default(10_000),

  // PostgreSQL
  DATABASE_URL: z.url({ protocol: /^postgres(ql)?$/, error: 'must be a postgresql:// URL' }),
  DB_POOL_MAX: z.coerce.number().int().min(1).max(100).default(10),
});

const parsed = envSchema.safeParse(process.env);

if (!parsed.success) {
  // The logger depends on this config, so plain console output is used here.
  /* eslint-disable no-console */
  console.error('Invalid environment configuration:');
  for (const issue of parsed.error.issues) {
    console.error(`  - ${issue.path.join('.')}: ${issue.message}`);
  }
  /* eslint-enable no-console */
  process.exit(1);
}

const env = parsed.data;

export const config = Object.freeze({
  env: env.NODE_ENV,
  isProduction: env.NODE_ENV === 'production',
  isTest: env.NODE_ENV === 'test',
  port: env.PORT,
  logLevel: env.LOG_LEVEL,
  baseUrl: env.APP_BASE_URL.replace(/\/+$/, ''),
  shutdownTimeoutMs: env.SHUTDOWN_TIMEOUT_MS,
  database: {
    url: env.DATABASE_URL,
    poolMax: env.DB_POOL_MAX,
  },
});
