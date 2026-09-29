import { describe, expect, it } from 'vitest';
import { fillDailySeries, startOfUtcDay } from '../../src/services/analytics.service.js';

describe('startOfUtcDay', () => {
  it('returns midnight UTC, optionally some days earlier', () => {
    const now = new Date('2026-09-29T17:38:47Z');
    expect(startOfUtcDay(now).toISOString()).toBe('2026-09-29T00:00:00.000Z');
    expect(startOfUtcDay(now, 6).toISOString()).toBe('2026-09-23T00:00:00.000Z');
  });
});

describe('fillDailySeries', () => {
  it('fills days without clicks with explicit zeros', () => {
    const from = new Date('2026-09-27T00:00:00Z');
    const rows = [
      { day: new Date('2026-09-27T00:00:00Z'), clicks: 4 },
      { day: new Date('2026-09-29T00:00:00Z'), clicks: 1 },
    ];
    expect(fillDailySeries(rows, from, 3)).toEqual([
      { date: '2026-09-27', clicks: 4 },
      { date: '2026-09-28', clicks: 0 },
      { date: '2026-09-29', clicks: 1 },
    ]);
  });

  it('returns all zeros for a link with no clicks', () => {
    const series = fillDailySeries([], new Date('2026-09-01T00:00:00Z'), 30);
    expect(series).toHaveLength(30);
    expect(series.every((d) => d.clicks === 0)).toBe(true);
    expect(series.at(-1).date).toBe('2026-09-30');
  });
});
