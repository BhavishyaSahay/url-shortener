import { describe, expect, it } from 'vitest';
import { getFixedWindow } from '../../src/middleware/rateLimiter.middleware.js';

describe('getFixedWindow', () => {
  const minute = 60;

  it('puts every moment of the same minute in the same window', () => {
    const start = Date.UTC(2026, 0, 1, 12, 0, 0);
    const a = getFixedWindow(start, minute);
    const b = getFixedWindow(start + 59_999, minute);
    expect(a.windowId).toBe(b.windowId);
  });

  it('moves to a new window exactly at the boundary', () => {
    const start = Date.UTC(2026, 0, 1, 12, 0, 0);
    expect(getFixedWindow(start + 60_000, minute).windowId).toBe(getFixedWindow(start, minute).windowId + 1);
  });

  it('reports seconds until the window resets (for Retry-After)', () => {
    const start = Date.UTC(2026, 0, 1, 12, 0, 0);
    expect(getFixedWindow(start, minute).resetSeconds).toBe(60);
    expect(getFixedWindow(start + 45_000, minute).resetSeconds).toBe(15);
    expect(getFixedWindow(start + 59_500, minute).resetSeconds).toBe(1); // rounded up, never 0
  });

  it('shows the fixed-window weakness: a burst straddling the boundary', () => {
    // 1 ms apart, but in different windows. A client can spend its whole
    // allowance at 11:59:59.999 and again at 12:00:00.000 → 2x max in 2 ms.
    const boundary = Date.UTC(2026, 0, 1, 12, 0, 0);
    expect(getFixedWindow(boundary - 1, minute).windowId).not.toBe(getFixedWindow(boundary, minute).windowId);
  });
});
