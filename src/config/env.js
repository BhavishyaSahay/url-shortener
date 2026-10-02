import dotenv from 'dotenv';
import { z } from 'zod';

// Load .env for local development. In Docker the variables come from the
// environment, and dotenv never overrides them.
dotenv.config({ quiet: true });

// Every environment variable the app reads, validated once at startup.
// A missing or malformed value stops the app immediately with a clear message,
// instead of failing later in the middle of a request.
const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().default(3000),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'silent']).default('info'),
  // Public base URL used to build short links, e.g. http://13.233.10.20
  APP_BASE_URL: z.url().default('http://localhost:3000'),
  DATABASE_URL: z.url(),
  REDIS_URL: z.url().default('redis://localhost:6380'),
  // Signs every login token: long, random, and never committed.
  JWT_SECRET: z.string().min(32, 'must be at least 32 characters'),
  // Secure cookies are only sent over HTTPS. Must be false while the site is plain HTTP.
  COOKIE_SECURE: z.stringbool().default(false),
  // Number of proxies in front of the app (1 behind nginx), so req.ip is the real client IP.
  TRUST_PROXY: z.coerce.number().int().min(0).default(0),
});

const parsed = envSchema.safeParse(process.env);
if (!parsed.success) {
  /* eslint-disable no-console */
  console.error('Invalid environment configuration:');
  for (const issue of parsed.error.issues) console.error(`  - ${issue.path.join('.')}: ${issue.message}`);
  /* eslint-enable no-console */
  process.exit(1);
}

const env = parsed.data;

export const config = {
  env: env.NODE_ENV,
  isProduction: env.NODE_ENV === 'production',
  port: env.PORT,
  logLevel: env.LOG_LEVEL,
  baseUrl: env.APP_BASE_URL.replace(/\/+$/, ''),
  databaseUrl: env.DATABASE_URL,
  redisUrl: env.REDIS_URL,
  jwtSecret: env.JWT_SECRET,
  cookieSecure: env.COOKIE_SECURE,
  trustProxy: env.TRUST_PROXY,
};
