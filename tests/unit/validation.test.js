import { describe, expect, it } from 'vitest';
import { createUrlSchema, registerSchema, updateUrlSchema, validate } from '../../src/utils/validation.js';

const fields = (schema, body) => {
  try {
    validate(schema, body);
    return [];
  } catch (err) {
    return err.details.map((d) => d.field);
  }
};

describe('registerSchema', () => {
  it('lower-cases and trims the email', () => {
    expect(validate(registerSchema, { email: ' Alice@Example.COM ', password: 'longenough' }).email).toBe('alice@example.com');
  });

  it('rejects a bad email and a short password', () => {
    expect(fields(registerSchema, { email: 'nope', password: '123' })).toEqual(['email', 'password']);
  });
});

describe('createUrlSchema', () => {
  it('accepts http(s) URLs with an optional alias and future expiry', () => {
    const body = validate(createUrlSchema, { url: 'https://example.com/a', customAlias: 'my-link', expiresAt: '2099-01-01T00:00:00Z' });
    expect(body.expiresAt).toBeInstanceOf(Date);
  });

  it.each(['not a url', 'example.com', 'javascript:alert(1)', 'ftp://example.com'])('rejects url %j', (url) => {
    expect(fields(createUrlSchema, { url })).toEqual(['url']);
  });

  it.each(['ab', 'has space', 'health'])('rejects alias %j', (customAlias) => {
    expect(fields(createUrlSchema, { url: 'https://a.com', customAlias })).toEqual(['customAlias']);
  });

  it('rejects an expiry in the past', () => {
    expect(fields(createUrlSchema, { url: 'https://a.com', expiresAt: '2020-01-01T00:00:00Z' })).toEqual(['expiresAt']);
  });
});

describe('updateUrlSchema', () => {
  it('requires at least one field', () => {
    expect(fields(updateUrlSchema, {})).toHaveLength(1);
  });
});
