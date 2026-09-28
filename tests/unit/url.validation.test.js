import { describe, expect, it } from 'vitest';
import { ValidationError } from '../../src/utils/errors.js';
import { createUrlSchema, listUrlsQuerySchema, updateUrlSchema, validate } from '../../src/utils/validation.js';

const nextYear = `${new Date().getUTCFullYear() + 1}-12-31T00:00:00Z`;

function fieldErrors(schema, body) {
  try {
    validate(schema, body);
    return [];
  } catch (err) {
    expect(err).toBeInstanceOf(ValidationError);
    return err.details;
  }
}

describe('createUrlSchema: url', () => {
  it.each([
    'https://example.com',
    'http://example.com/some/long/path?q=1&x=y#frag',
    'https://sub.example.co.uk:8443/path',
    'https://192.168.1.10/internal',
  ])('accepts %s', (url) => {
    expect(validate(createUrlSchema, { url }).url).toBe(url);
  });

  it('trims surrounding whitespace', () => {
    expect(validate(createUrlSchema, { url: '  https://example.com  ' }).url).toBe('https://example.com');
  });

  it.each([
    ['not a url', 'valid absolute URL'],
    ['example.com', 'valid absolute URL'], // no scheme
    ['/relative/path', 'valid absolute URL'],
    ['javascript:alert(1)', 'http:// or https://'],
    ['data:text/html,<script>alert(1)</script>', 'http:// or https://'],
    ['ftp://example.com/file', 'http:// or https://'],
    ['file:///etc/passwd', 'http:// or https://'],
    ['http://localhost:3000/abc', 'this URL shortener'], // our own APP_BASE_URL → redirect loop
    ['', 'is required'],
  ])('rejects %j', (url, message) => {
    const errors = fieldErrors(createUrlSchema, { url });
    expect(errors[0].field).toBe('url');
    expect(errors[0].message).toContain(message);
  });

  it('rejects URLs longer than 2048 characters', () => {
    const errors = fieldErrors(createUrlSchema, { url: `https://example.com/${'a'.repeat(2048)}` });
    expect(errors[0].message).toContain('2048');
  });
});

describe('createUrlSchema: customAlias', () => {
  it.each(['my-link', 'My_Link_2026', 'abc', 'a'.repeat(32)])('accepts %j', (customAlias) => {
    expect(validate(createUrlSchema, { url: 'https://a.com', customAlias }).customAlias).toBe(customAlias);
  });

  it.each([
    ['ab', 'at least 3'],
    ['a'.repeat(33), 'at most 32'],
    ['has space', 'letters, numbers'],
    ['slash/es', 'letters, numbers'],
    ['dot.dot', 'letters, numbers'],
    ['emoji😀', 'letters, numbers'],
    ['health', 'reserved'],
    ['API', 'reserved'], // reserved check is case-insensitive
  ])('rejects %j', (customAlias, message) => {
    const errors = fieldErrors(createUrlSchema, { url: 'https://a.com', customAlias });
    expect(errors[0].field).toBe('customAlias');
    expect(errors[0].message).toContain(message);
  });
});

describe('createUrlSchema: expiresAt', () => {
  it('accepts a future ISO date-time and converts it to a Date', () => {
    const { expiresAt } = validate(createUrlSchema, { url: 'https://a.com', expiresAt: nextYear });
    expect(expiresAt).toBeInstanceOf(Date);
    expect(expiresAt.toISOString()).toBe(nextYear.replace('Z', '.000Z'));
  });

  it('accepts timezone offsets', () => {
    const { expiresAt } = validate(createUrlSchema, { url: 'https://a.com', expiresAt: nextYear.replace('Z', '+05:30') });
    expect(expiresAt).toBeInstanceOf(Date);
  });

  it.each([
    ['2020-01-01T00:00:00Z', 'future'],
    ['2099-12-31', 'ISO 8601'], // date only
    ['2099-12-31T00:00:00', 'ISO 8601'], // no timezone: ambiguous
    ['next tuesday', 'ISO 8601'],
  ])('rejects %j', (expiresAt, message) => {
    const errors = fieldErrors(createUrlSchema, { url: 'https://a.com', expiresAt });
    expect(errors[0].field).toBe('expiresAt');
    expect(errors[0].message).toContain(message);
  });
});

describe('createUrlSchema: unknown fields', () => {
  it('rejects them instead of silently ignoring a typo', () => {
    const errors = fieldErrors(createUrlSchema, { url: 'https://a.com', custom_alias: 'oops' });
    expect(errors[0].message).toMatch(/unrecognized key/i);
  });
});

describe('updateUrlSchema', () => {
  it('accepts partial updates', () => {
    expect(validate(updateUrlSchema, { isActive: false })).toEqual({ isActive: false });
  });

  it('accepts expiresAt: null to remove the expiry', () => {
    expect(validate(updateUrlSchema, { expiresAt: null })).toEqual({ expiresAt: null });
  });

  it('rejects an empty body', () => {
    expect(fieldErrors(updateUrlSchema, {})[0].message).toContain('at least one of');
  });

  it('does not allow changing the short code or alias', () => {
    expect(fieldErrors(updateUrlSchema, { shortCode: 'new' })[0].message).toMatch(/unrecognized key/i);
    expect(fieldErrors(updateUrlSchema, { customAlias: 'new' })[0].message).toMatch(/unrecognized key/i);
  });

  it('rejects a non-boolean isActive', () => {
    expect(fieldErrors(updateUrlSchema, { isActive: 'false' })[0].field).toBe('isActive');
  });
});

describe('listUrlsQuerySchema', () => {
  it('defaults to page 1, 20 per page, and coerces query strings to numbers', () => {
    expect(validate(listUrlsQuerySchema, {})).toEqual({ page: 1, limit: 20 });
    expect(validate(listUrlsQuerySchema, { page: '3', limit: '50' })).toEqual({ page: 3, limit: 50 });
  });

  it.each([{ page: '0' }, { limit: '101' }, { limit: '-5' }, { page: 'abc' }])('rejects %o', (query) => {
    expect(() => validate(listUrlsQuerySchema, query)).toThrow(ValidationError);
  });
});
