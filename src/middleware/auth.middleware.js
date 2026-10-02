import { UnauthorizedError } from '../utils/errors.js';
import { verifyToken } from '../utils/jwt.js';

export const AUTH_COOKIE = 'access_token';

// Rejects the request with 401 unless the auth cookie holds a valid JWT.
// No database lookup: checking the signature is enough (stateless).
export function requireAuth(req, res, next) {
  const userId = verifyToken(req.cookies?.[AUTH_COOKIE]);
  if (!userId) return next(UnauthorizedError());
  req.user = { id: userId };
  next();
}
