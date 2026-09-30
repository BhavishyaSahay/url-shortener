import { describe, expect, it } from 'vitest';
import { envSchema } from '../../src/config/env.js';

// Only the required variable; everything else falls back to its default.
const minimalEnv = { DATABASE_URL: 'postgresql://u:p@db:5432/app' };

describe('environment config', () => {
  it('turns duration DEFAULTS into seconds, not strings (regression: Zod .default skips transforms)', () => {
    const env = envSchema.parse(minimalEnv);
    expect(env.JWT_EXPIRES_IN).toBe(86_400); // '1d'
    expect(env.URL_CACHE_TTL).toBe(3_600); // '1h'
    expect(env.URL_NEGATIVE_CACHE_TTL).toBe(60); // '60s'
    expect(env.RATE_LIMIT_LOGIN_WINDOW).toBe(900); // '15m'
    expect(env.RATE_LIMIT_CREATE_URL_WINDOW).toBe(60); // '1m'
  });

  it.each([
    ['30s', 30],
    ['15m', 900],
    ['12h', 43_200],
    ['7d', 604_800],
    ['3600', 3_600],
  ])('parses JWT_EXPIRES_IN=%s as %i seconds', (value, seconds) => {
    expect(envSchema.parse({ ...minimalEnv, JWT_EXPIRES_IN: value }).JWT_EXPIRES_IN).toBe(seconds);
  });

  it('rejects malformed durations and non-postgres database URLs', () => {
    expect(() => envSchema.parse({ ...minimalEnv, JWT_EXPIRES_IN: 'one day' })).toThrow();
    expect(() => envSchema.parse({ DATABASE_URL: 'mysql://u:p@db/app' })).toThrow();
  });

  it('splits KAFKA_BROKERS into a list and parses booleans properly', () => {
    const env = envSchema.parse({ ...minimalEnv, KAFKA_BROKERS: 'k1:9092, k2:9092', COOKIE_SECURE: 'false' });
    expect(env.KAFKA_BROKERS).toEqual(['k1:9092', 'k2:9092']);
    expect(env.COOKIE_SECURE).toBe(false); // z.coerce.boolean('false') would have been true
  });
});
