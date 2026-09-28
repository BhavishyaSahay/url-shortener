import { UnauthorizedError } from '../utils/errors.js';
import { verifyAccessToken } from '../utils/jwt.js';

export const AUTH_COOKIE_NAME = 'access_token';

// Browsers send the token automatically in the HTTP-only cookie. Non-browser
// clients (curl, k6 load tests, scripts) can send `Authorization: Bearer <token>`.
function extractToken(req) {
  const fromCookie = req.cookies?.[AUTH_COOKIE_NAME];
  if (fromCookie) return fromCookie;

  const header = req.get('authorization');
  if (header?.startsWith('Bearer ')) return header.slice('Bearer '.length).trim();

  return null;
}

/**
 * Authentication: rejects the request with 401 unless it carries a valid JWT,
 * then exposes the caller as `req.user = { id }`.
 *
 * This is stateless: verifying the signature needs no database query, which is
 * why JWTs scale well across multiple API instances. Authorization ("may THIS
 * user touch THIS URL?") is a separate check done in the services.
 */
export function requireAuth(req, res, next) {
  const userId = verifyAccessToken(extractToken(req));
  if (!userId) {
    return next(new UnauthorizedError());
  }
  req.user = { id: userId };
  next();
}
