import { describe, expect, it } from 'vitest';
import { getWindow } from '../../src/middleware/rateLimiter.middleware.js';

describe('fixed rate-limit windows', () => {
  const start = Date.UTC(2026, 0, 1, 12, 0, 0);

  it('requests in the same minute share a window', () => {
    expect(getWindow(start, 60).windowId).toBe(getWindow(start + 59_999, 60).windowId);
  });

  it('a new window starts exactly at the boundary', () => {
    expect(getWindow(start + 60_000, 60).windowId).toBe(getWindow(start, 60).windowId + 1);
  });

  it('reports the seconds left until the window resets (for Retry-After)', () => {
    expect(getWindow(start + 45_000, 60).secondsLeft).toBe(15);
  });
});
