import { describe, expect, it } from 'vitest';
import { getUrlStatus, isExpired } from '../../src/utils/expiration.js';

const now = new Date('2026-06-15T12:00:00Z');

describe('expiration', () => {
  it('a link without expiresAt never expires', () => {
    expect(isExpired(null, now)).toBe(false);
  });

  it('is expired once expiresAt is reached', () => {
    expect(isExpired(new Date('2026-06-15T12:00:01Z'), now)).toBe(false);
    expect(isExpired(new Date('2026-06-15T12:00:00Z'), now)).toBe(true);
    expect(isExpired(new Date('2026-06-15T11:00:00Z'), now)).toBe(true);
  });

  it.each([
    [{ isActive: true, expiresAt: null }, 'active'],
    [{ isActive: true, expiresAt: '2026-06-15T11:00:00Z' }, 'expired'],
    [{ isActive: false, expiresAt: null }, 'inactive'],
  ])('getUrlStatus(%o) → %s', (url, status) => {
    expect(getUrlStatus(url, now)).toBe(status);
  });
});
