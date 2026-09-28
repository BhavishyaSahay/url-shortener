// Base62 encoding: write a number using 62 "digits" instead of 10.
//
//   index:  0-9 → '0'-'9'   10-35 → 'a'-'z'   36-61 → 'A'-'Z'
//
// Why 62? These characters are URL-safe without escaping, so the code can
// go straight into a path. Codes also stay short: k characters can represent
// 62^k values:
//   62^4 ≈ 14.8 million   62^6 ≈ 56.8 billion   62^7 ≈ 3.5 trillion
//
// Example: 123456 = 32·62² + 7·62 + 14  →  digits [32, 7, 14]  →  "w7e"
export const ALPHABET = '0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ';
const BASE = ALPHABET.length; // 62

// Reverse lookup table: character → digit value.
const CHAR_TO_VALUE = new Map([...ALPHABET].map((char, index) => [char, index]));

/** Encode a non-negative integer as a Base62 string. */
export function encode(num) {
  if (!Number.isSafeInteger(num) || num < 0) {
    throw new RangeError(`Base62 can only encode non-negative safe integers, got ${num}`);
  }
  if (num === 0) return ALPHABET[0];

  // Repeated division, like converting to binary by hand: each remainder is
  // the next digit, least-significant first, so we prepend.
  let result = '';
  while (num > 0) {
    result = ALPHABET[num % BASE] + result;
    num = Math.floor(num / BASE);
  }
  return result;
}

/** Decode a Base62 string back to the integer. The inverse of encode(). */
export function decode(str) {
  if (typeof str !== 'string' || str.length === 0) {
    throw new TypeError('Base62 decode expects a non-empty string');
  }
  let num = 0;
  for (const char of str) {
    const value = CHAR_TO_VALUE.get(char);
    if (value === undefined) throw new TypeError(`Invalid Base62 character "${char}"`);
    num = num * BASE + value;
  }
  if (!Number.isSafeInteger(num)) throw new RangeError('Decoded value exceeds the safe integer range');
  return num;
}
