import dotenv from 'dotenv';
import { z } from 'zod';

// Load .env into process.env for local development. In Docker/production the
// variables are injected by the environment, and dotenv never overrides them.
dotenv.config({ quiet: true });

// "15m" / "12h" / "7d" / "3600" (plain seconds) -> number of seconds.
const DURATION_UNITS = { s: 1, m: 60, h: 3600, d: 86_400 };
const duration = z
  .string()
  .regex(/^\d+[smhd]?$/, 'must look like 3600, 30s, 15m, 12h or 7d')
  .transform((value) => {
    const [, amount, unit = 's'] = value.match(/^(\d+)([smhd]?)$/);
    return Number(amount) * DURATION_UNITS[unit];
  });

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

  // Authentication. The secret signs every JWT: anyone who knows it can forge
  // a login for any user, so it must be long, random and never committed.
  JWT_SECRET: z.string().min(32, 'must be at least 32 characters (generate a random one, see .env.example)'),
  JWT_EXPIRES_IN: duration.default('1d'),
  // Secure cookies are only sent over HTTPS. Defaults to true in production.
  // (Note: z.coerce.boolean() would turn the string "false" into true; stringbool parses it properly.)
  COOKIE_SECURE: z.stringbool().optional(),

  // Redis (cache + rate-limit counters)
  REDIS_URL: z.url({ protocol: /^rediss?$/, error: 'must be a redis:// URL' }).default('redis://localhost:6380/0'),
  URL_CACHE_TTL: duration.default('1h'),
  URL_NEGATIVE_CACHE_TTL: duration.default('60s'),

  // Rate limiting (fixed window)
  RATE_LIMIT_LOGIN_MAX: z.coerce.number().int().positive().default(10),
  RATE_LIMIT_LOGIN_WINDOW: duration.default('15m'),
  RATE_LIMIT_CREATE_URL_MAX: z.coerce.number().int().positive().default(30),
  RATE_LIMIT_CREATE_URL_WINDOW: duration.default('1m'),

  // Number of reverse proxies (e.g. Nginx) in front of the app. Express then
  // trusts that many X-Forwarded-For hops when working out req.ip.
  TRUST_PROXY: z.coerce.number().int().min(0).default(0),
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
  auth: {
    jwtSecret: env.JWT_SECRET,
    jwtExpiresInSeconds: env.JWT_EXPIRES_IN,
    cookieSecure: env.COOKIE_SECURE ?? env.NODE_ENV === 'production',
  },
  redis: {
    url: env.REDIS_URL,
    urlCacheTtlSeconds: env.URL_CACHE_TTL,
    negativeCacheTtlSeconds: env.URL_NEGATIVE_CACHE_TTL,
  },
  rateLimit: {
    login: { max: env.RATE_LIMIT_LOGIN_MAX, windowSeconds: env.RATE_LIMIT_LOGIN_WINDOW },
    createUrl: { max: env.RATE_LIMIT_CREATE_URL_MAX, windowSeconds: env.RATE_LIMIT_CREATE_URL_WINDOW },
  },
  trustProxy: env.TRUST_PROXY,
});
