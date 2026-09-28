import { describe, expect, it } from 'vitest';
import { ALPHABET, decode, encode } from '../../src/utils/base62.js';

describe('Base62', () => {
  it('uses the 0-9, a-z, A-Z alphabet in that order', () => {
    expect(ALPHABET).toHaveLength(62);
    expect(new Set(ALPHABET).size).toBe(62);
    expect(ALPHABET.slice(0, 11)).toBe('0123456789a');
    expect(ALPHABET.slice(-1)).toBe('Z');
  });

  it.each([
    [0, '0'],
    [9, '9'],
    [10, 'a'],
    [35, 'z'],
    [36, 'A'],
    [61, 'Z'],
    [62, '10'], // like 10 in decimal: "one 62, zero units"
    [3843, 'ZZ'], // 62² − 1, the largest 2-char code
    [3844, '100'],
    [123456, 'w7e'], // 32·62² + 7·62 + 14
    [2_147_483_647, '2lkCB1'], // max PostgreSQL INTEGER → still only 6 chars
  ])('encode(%i) = %s', (num, code) => {
    expect(encode(num)).toBe(code);
    expect(decode(code)).toBe(num);
  });

  it('round-trips random integers and only emits alphabet characters', () => {
    for (let i = 0; i < 1000; i++) {
      const n = Math.floor(Math.random() * Number.MAX_SAFE_INTEGER);
      const code = encode(n);
      expect(code).toMatch(/^[0-9a-zA-Z]+$/);
      expect(decode(code)).toBe(n);
    }
  });

  it('gives every number a distinct code (bijective), so unique IDs mean unique codes', () => {
    const codes = new Set();
    for (let n = 0; n < 50_000; n++) codes.add(encode(n));
    expect(codes.size).toBe(50_000);
  });

  it('is case-sensitive: "a" and "A" are different numbers', () => {
    expect(decode('a')).not.toBe(decode('A'));
  });

  it.each([-1, 1.5, NaN, Infinity, '5', null, 2 ** 53])('encode rejects %s', (bad) => {
    expect(() => encode(bad)).toThrow();
  });

  it.each(['', 'abc-', 'hello world', 'é'])('decode rejects %j', (bad) => {
    expect(() => decode(bad)).toThrow();
  });
});
