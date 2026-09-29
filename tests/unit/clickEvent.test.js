import { describe, expect, it } from 'vitest';
import { buildClickEvent, publishClickEvent } from '../../src/services/clickEvent.service.js';

const url = { id: 42 };
const base = { url, shortCode: 'aB92x', ip: '203.0.113.7', userAgent: 'Mozilla/5.0', referrer: 'https://twitter.com/x' };

describe('buildClickEvent', () => {
  it('builds the event published to Kafka', () => {
    const now = new Date('2026-09-29T10:00:00Z');
    const event = buildClickEvent({ ...base, now });

    expect(event).toEqual({
      eventId: expect.stringMatching(/^[0-9a-f-]{36}$/),
      urlId: 42,
      shortCode: 'aB92x',
      timestamp: '2026-09-29T10:00:00.000Z',
      ipHash: expect.stringMatching(/^[0-9a-f]{32}$/),
      userAgent: 'Mozilla/5.0',
      referrer: 'https://twitter.com/x',
    });
  });

  it('gives every click its own eventId (used to drop duplicate deliveries)', () => {
    expect(buildClickEvent(base).eventId).not.toBe(buildClickEvent(base).eventId);
  });

  it('never includes the raw IP, only a keyed hash of it', () => {
    const event = buildClickEvent(base);
    expect(JSON.stringify(event)).not.toContain('203.0.113.7');
  });

  it('hashes the same IP the same way (so unique visitors can be counted) and different IPs differently', () => {
    const a = buildClickEvent(base).ipHash;
    const b = buildClickEvent(base).ipHash;
    const c = buildClickEvent({ ...base, ip: '203.0.113.8' }).ipHash;
    expect(a).toBe(b);
    expect(a).not.toBe(c);
  });

  it('truncates oversized headers and turns missing ones into null', () => {
    const event = buildClickEvent({ ...base, userAgent: 'x'.repeat(2000), referrer: undefined, ip: undefined });
    expect(event.userAgent).toHaveLength(512);
    expect(event.referrer).toBeNull();
    expect(event.ipHash).toBeNull();
  });
});

describe('publishClickEvent without a Kafka connection', () => {
  it('drops the event immediately instead of waiting or throwing', async () => {
    const started = performance.now();
    await expect(publishClickEvent(buildClickEvent(base))).resolves.toBe(false);
    expect(performance.now() - started).toBeLessThan(20);
  });
});
