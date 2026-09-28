import jwt from 'jsonwebtoken';
import { config } from '../config/env.js';

// JSON Web Token = base64url(header).base64url(payload).signature
// The payload is only encoded, NOT encrypted: anyone can read it, so it holds
// just the user ID. The HMAC-SHA256 signature (made with JWT_SECRET) is what
// stops a client from editing the payload, e.g. changing "sub" to another user's ID.
const ALGORITHM = 'HS256';
const ISSUER = 'url-shortener';

export function signAccessToken(userId) {
  return jwt.sign({}, config.auth.jwtSecret, {
    algorithm: ALGORITHM,
    subject: String(userId), // "sub" claim: who this token is about
    issuer: ISSUER,
    expiresIn: config.auth.jwtExpiresInSeconds, // "exp" claim, checked by verify()
  });
}

/**
 * Returns the user ID from a valid token, or null if the token is missing,
 * tampered with, expired, or signed differently.
 */
export function verifyAccessToken(token) {
  if (!token) return null;
  try {
    const payload = jwt.verify(token, config.auth.jwtSecret, {
      // Pin the algorithm. Otherwise a forged token could claim "alg": "none"
      // or another algorithm and try to skip signature verification.
      algorithms: [ALGORITHM],
      issuer: ISSUER,
    });
    const userId = Number(payload.sub);
    return Number.isSafeInteger(userId) && userId > 0 ? userId : null;
  } catch {
    return null;
  }
}
