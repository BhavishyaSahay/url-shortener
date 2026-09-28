import { describe, expect, it } from 'vitest';
import { ValidationError } from '../../src/utils/errors.js';
import { loginSchema, registerSchema, validate } from '../../src/utils/validation.js';

describe('registerSchema', () => {
  it('trims and lower-cases the email', () => {
    const data = validate(registerSchema, { email: '  Alice@Example.COM ', password: 'longenough' });
    expect(data.email).toBe('alice@example.com');
  });

  it('drops unknown fields (e.g. a client trying to set "id" or "passwordHash")', () => {
    const data = validate(registerSchema, { email: 'a@b.co', password: 'longenough', passwordHash: 'x', id: 1 });
    expect(data).toEqual({ email: 'a@b.co', password: 'longenough' });
  });

  it.each([
    [{ email: 'not-an-email', password: 'longenough' }, 'email'],
    [{ email: 'a@b.co', password: 'short' }, 'password'],
    [{ email: 'a@b.co', password: 'x'.repeat(129) }, 'password'],
    [{ email: 'a@b.co' }, 'password'],
    [{ password: 'longenough' }, 'email'],
  ])('rejects %j (bad %s)', (body, field) => {
    try {
      validate(registerSchema, body);
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(ValidationError);
      expect(err.details.map((d) => d.field)).toContain(field);
    }
  });

  it('reports every invalid field at once', () => {
    expect(() => validate(registerSchema, { email: 'bad', password: '1' })).toThrow(
      expect.objectContaining({ details: expect.arrayContaining([expect.objectContaining({ field: 'email' }), expect.objectContaining({ field: 'password' })]) }),
    );
  });

  it('handles a missing body', () => {
    expect(() => validate(registerSchema, undefined)).toThrow(ValidationError);
  });
});

describe('loginSchema', () => {
  it('does not apply new-password rules, so old short passwords can still log in', () => {
    expect(validate(loginSchema, { email: 'a@b.co', password: 'short' }).password).toBe('short');
  });

  it('requires a non-empty password', () => {
    expect(() => validate(loginSchema, { email: 'a@b.co', password: '' })).toThrow(ValidationError);
  });
});
