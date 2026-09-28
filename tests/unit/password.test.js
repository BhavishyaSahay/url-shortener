import { describe, expect, it } from 'vitest';
import { hashPassword, verifyAgainstDummyHash, verifyPassword } from '../../src/utils/password.js';

describe('password hashing (Argon2id)', () => {
  it('produces an Argon2id hash with the configured parameters, not the plaintext', async () => {
    const hash = await hashPassword('correct horse battery');
    expect(hash).toMatch(/^\$argon2id\$v=19\$m=19456,p=1,t=2\$/);
    expect(hash).not.toContain('correct horse battery');
  });

  it('salts every hash: same password, different hashes', async () => {
    const [a, b] = await Promise.all([hashPassword('same-password'), hashPassword('same-password')]);
    expect(a).not.toBe(b);
  });

  it('verifies the right password and rejects the wrong one', async () => {
    const hash = await hashPassword('s3cret-pass');
    expect(await verifyPassword(hash, 's3cret-pass')).toBe(true);
    expect(await verifyPassword(hash, 's3cret-Pass')).toBe(false);
  });

  it('returns false (instead of throwing) for a malformed stored hash', async () => {
    expect(await verifyPassword('not-a-hash', 'anything')).toBe(false);
  });

  it('dummy verification always fails', async () => {
    expect(await verifyAgainstDummyHash('dummy-password-for-timing-safety')).toBe(false);
  });
});
