import { describe, expect, it } from 'vitest';
import { getUrlStatus, isExpired, isRedirectable } from '../../src/utils/expiration.js';

const now = new Date('2026-06-15T12:00:00Z');
const past = new Date('2026-06-15T11:59:59Z');
const future = new Date('2026-06-15T12:00:01Z');

describe('isExpired', () => {
  it('treats a missing expiry as "never expires"', () => {
    expect(isExpired(null, now)).toBe(false);
    expect(isExpired(undefined, now)).toBe(false);
  });

  it('is false before expiresAt and true after it', () => {
    expect(isExpired(future, now)).toBe(false);
    expect(isExpired(past, now)).toBe(true);
  });

  it('is expired at exactly expiresAt (the boundary is inclusive)', () => {
    expect(isExpired(now, new Date(now))).toBe(true);
  });

  it('compares instants, not wall-clock strings: timezones do not matter', () => {
    // 17:29 in India (+05:30) is 11:59 UTC → already past `now` (12:00 UTC)
    expect(isExpired('2026-06-15T17:29:00+05:30', now)).toBe(true);
    expect(isExpired('2026-06-15T17:31:00+05:30', now)).toBe(false);
  });
});

describe('getUrlStatus', () => {
  it.each([
    [{ isActive: true, expiresAt: null }, 'active'],
    [{ isActive: true, expiresAt: future }, 'active'],
    [{ isActive: true, expiresAt: past }, 'expired'],
    [{ isActive: false, expiresAt: null }, 'inactive'],
    [{ isActive: false, expiresAt: past }, 'inactive'], // owner's choice wins
  ])('%o → %s', (url, status) => {
    expect(getUrlStatus(url, now)).toBe(status);
    expect(isRedirectable(url, now)).toBe(status === 'active');
  });
});
