import jwt from 'jsonwebtoken';
import { config } from '../config/env.js';

export const TOKEN_LIFETIME_SECONDS = 24 * 60 * 60; // 1 day

// The token's payload is readable by anyone, so it holds only the user ID.
// The signature (HMAC-SHA256 with JWT_SECRET) stops anyone from changing it.
export function signToken(userId) {
  return jwt.sign({}, config.jwtSecret, {
    algorithm: 'HS256',
    subject: String(userId),
    expiresIn: TOKEN_LIFETIME_SECONDS,
  });
}

/** Returns the user ID, or null if the token is missing, invalid or expired. */
export function verifyToken(token) {
  try {
    // Pinning the algorithm blocks forged tokens that claim "alg": "none".
    const payload = jwt.verify(token, config.jwtSecret, { algorithms: ['HS256'] });
    return Number(payload.sub);
  } catch {
    return null;
  }
}
