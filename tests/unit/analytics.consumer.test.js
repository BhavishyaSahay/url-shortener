import { describe, expect, it } from 'vitest';
import { parseStreamEntries } from '../../worker/analytics.consumer.js';

const event = {
  eventId: '0f8fad5b-d9cb-469f-a165-70867728950e',
  urlId: 1,
  shortCode: 'abc',
  timestamp: '2026-10-01T10:00:00.000Z',
  ipHash: null,
  userAgent: null,
  referrer: null,
};

describe('parseStreamEntries', () => {
  it('turns XREADGROUP entries into { id, event }', () => {
    const entries = [['1727700000000-0', ['event', JSON.stringify(event)]]];
    expect(parseStreamEntries(entries)).toEqual([{ id: '1727700000000-0', event }]);
  });

  it('marks malformed entries (poison messages) with event: null, keeping their IDs so they can be acknowledged', () => {
    const entries = [
      ['1-0', ['event', '{not json']],
      ['2-0', ['event', JSON.stringify({ ...event, urlId: 'one' })]],
      ['3-0', ['event', JSON.stringify({ ...event, urlId: 9_999_999_999 })]], // beyond PostgreSQL INTEGER
      ['4-0', ['other', 'field']],
      ['5-0', null], // pending entry whose data was already trimmed from the stream
    ];
    expect(parseStreamEntries(entries)).toEqual([
      { id: '1-0', event: null },
      { id: '2-0', event: null },
      { id: '3-0', event: null },
      { id: '4-0', event: null },
      { id: '5-0', event: null },
    ]);
  });

  it('ignores null entries (returned by older Redis versions for deleted entries)', () => {
    expect(parseStreamEntries([null, ['1-0', ['event', JSON.stringify(event)]]])).toHaveLength(1);
  });
});
