import jwt from 'jsonwebtoken';
import { describe, expect, it } from 'vitest';
import { signAccessToken, verifyAccessToken } from '../../src/utils/jwt.js';

const SECRET = process.env.JWT_SECRET;
const b64url = (obj) => Buffer.from(JSON.stringify(obj)).toString('base64url');

describe('JWT access tokens', () => {
  it('round-trips the user ID', () => {
    const token = signAccessToken(42);
    expect(verifyAccessToken(token)).toBe(42);
  });

  it('puts only the user ID and standard claims in the (readable!) payload', () => {
    const payload = jwt.decode(signAccessToken(7));
    expect(Object.keys(payload).sort()).toEqual(['exp', 'iat', 'iss', 'sub']);
    expect(payload.sub).toBe('7');
    expect(payload.exp - payload.iat).toBe(86_400); // JWT_EXPIRES_IN=1d default
  });

  it('rejects a token whose payload was edited (e.g. to impersonate user 1)', () => {
    const [header, , signature] = signAccessToken(42).split('.');
    const forgedPayload = b64url({ sub: '1', iss: 'url-shortener', exp: Math.floor(Date.now() / 1000) + 3600 });
    expect(verifyAccessToken(`${header}.${forgedPayload}.${signature}`)).toBeNull();
  });

  it('rejects an expired token', () => {
    const expired = jwt.sign({}, SECRET, { subject: '42', issuer: 'url-shortener', expiresIn: -10 });
    expect(verifyAccessToken(expired)).toBeNull();
  });

  it('rejects a token signed with a different secret', () => {
    const wrongKey = jwt.sign({}, 'some-other-secret-that-is-long-enough!!', { subject: '42', issuer: 'url-shortener' });
    expect(verifyAccessToken(wrongKey)).toBeNull();
  });

  it('rejects an unsigned "alg: none" token', () => {
    const unsigned = `${b64url({ alg: 'none', typ: 'JWT' })}.${b64url({ sub: '42', iss: 'url-shortener' })}.`;
    expect(verifyAccessToken(unsigned)).toBeNull();
  });

  it('rejects a token from a different issuer', () => {
    const foreign = jwt.sign({}, SECRET, { subject: '42', issuer: 'someone-else' });
    expect(verifyAccessToken(foreign)).toBeNull();
  });

  it.each([undefined, null, '', 'not-a-jwt', 'a.b.c'])('returns null for garbage input %j', (input) => {
    expect(verifyAccessToken(input)).toBeNull();
  });
});
