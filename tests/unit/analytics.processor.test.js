import { describe, expect, it } from 'vitest';
import {
  classifyBrowser,
  countClicksByUrlAndDay,
  parseClickEvent,
  referrerHost,
} from '../../worker/analytics.processor.js';

const validEvent = {
  eventId: '0f8fad5b-d9cb-469f-a165-70867728950e',
  urlId: 1,
  shortCode: 'abc',
  timestamp: '2026-09-29T10:00:00.000Z',
  ipHash: 'deadbeef',
  userAgent: 'Mozilla/5.0',
  referrer: null,
};
const asMessage = (obj) => Buffer.from(JSON.stringify(obj));

describe('parseClickEvent', () => {
  it('accepts a valid event', () => {
    expect(parseClickEvent(asMessage(validEvent))).toEqual(validEvent);
  });

  it.each([
    ['not JSON', Buffer.from('{oops')],
    ['missing eventId', asMessage({ ...validEvent, eventId: undefined })],
    ['non-UUID eventId', asMessage({ ...validEvent, eventId: '123' })],
    ['string urlId', asMessage({ ...validEvent, urlId: '1' })],
    ['bad timestamp', asMessage({ ...validEvent, timestamp: 'yesterday' })],
    ['oversized user agent', asMessage({ ...validEvent, userAgent: 'x'.repeat(513) })],
    ['empty message', Buffer.from('')],
  ])('rejects a poison message: %s', (_, message) => {
    expect(parseClickEvent(message)).toBeNull();
  });
});

describe('classifyBrowser', () => {
  it.each([
    ['Mozilla/5.0 (Windows NT 10.0) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0 Safari/537.36', 'Chrome'],
    ['Mozilla/5.0 (Windows NT 10.0) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0 Safari/537.36 Edg/140.0', 'Edge'],
    ['Mozilla/5.0 (Macintosh) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15', 'Safari'],
    ['Mozilla/5.0 (Macintosh; rv:141.0) Gecko/20100101 Firefox/141.0', 'Firefox'],
    ['Mozilla/5.0 (iPhone) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/140.0 Mobile/15E148 Safari/604.1', 'Chrome'],
    ['Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0 Safari/537.36 OPR/120.0', 'Opera'],
    ['Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)', 'Bot'],
    ['curl/8.7.1', 'Bot'],
    ['python-requests/2.32', 'Bot'],
    ['SomethingElse/1.0', 'Other'],
    [null, 'Unknown'],
  ])('%s → %s', (ua, browser) => {
    expect(classifyBrowser(ua)).toBe(browser);
  });
});

describe('referrerHost', () => {
  it.each([
    ['https://www.twitter.com/some/post?x=1', 'twitter.com'],
    ['https://news.ycombinator.com/item?id=1', 'news.ycombinator.com'],
    ['http://localhost:5173/page', 'localhost'],
    [null, null],
    ['not a url', null],
  ])('%s → %s', (input, host) => {
    expect(referrerHost(input)).toBe(host);
  });
});

describe('countClicksByUrlAndDay', () => {
  it('groups by URL and UTC day, sorted for a consistent lock order', () => {
    const clicks = [
      { urlId: 2, clickedAt: new Date('2026-09-29T10:00:00Z') },
      { urlId: 1, clickedAt: new Date('2026-09-29T23:59:59Z') },
      { urlId: 1, clickedAt: new Date('2026-09-30T00:00:00Z') }, // next UTC day
      { urlId: 1, clickedAt: new Date('2026-09-29T01:00:00Z') },
    ];
    expect(countClicksByUrlAndDay(clicks)).toEqual([
      { urlId: 1, day: '2026-09-29', clicks: 2 },
      { urlId: 1, day: '2026-09-30', clicks: 1 },
      { urlId: 2, day: '2026-09-29', clicks: 1 },
    ]);
  });

  it('buckets by UTC even for timestamps written with an offset', () => {
    // 01:00 in India (+05:30) is 19:30 UTC on the PREVIOUS day.
    expect(countClicksByUrlAndDay([{ urlId: 1, clickedAt: '2026-09-30T01:00:00+05:30' }])[0].day).toBe('2026-09-29');
  });
});
