import argon2 from 'argon2';

// Argon2id: a slow, salted, one-way hash (OWASP's recommended algorithm).
// A leaked database exposes only hashes, which are expensive to brute-force.
export const hashPassword = (password) => argon2.hash(password, { type: argon2.argon2id });

export async function verifyPassword(hash, password) {
  try {
    return await argon2.verify(hash, password);
  } catch {
    return false; // malformed hash
  }
}
