import { config } from '../config/env.js';
import { AUTH_COOKIE_NAME } from '../middleware/auth.middleware.js';
import * as authService from '../services/auth.service.js';
import { UnauthorizedError } from '../utils/errors.js';
import { signAccessToken } from '../utils/jwt.js';
import { loginSchema, registerSchema, validate } from '../utils/validation.js';

// Controllers are the HTTP layer: validate input, call a service, and shape the
// response. Business logic lives in services, which know nothing about Express.

// Cookie flags:
//   httpOnly  JavaScript on the page can't read the token, so an XSS bug can't steal it
//   secure    only sent over HTTPS (on in production)
//   sameSite  'lax': not sent on cross-site POST/PATCH/DELETE, the main CSRF defense
//   path '/'  sent to every route on this domain
const cookieOptions = () => ({
  httpOnly: true,
  secure: config.auth.cookieSecure,
  sameSite: 'lax',
  path: '/',
});

function setAuthCookie(res, userId) {
  res.cookie(AUTH_COOKIE_NAME, signAccessToken(userId), {
    ...cookieOptions(),
    maxAge: config.auth.jwtExpiresInSeconds * 1000, // cookie expires with the token
  });
}

export async function register(req, res) {
  const input = validate(registerSchema, req.body);
  const user = await authService.registerUser(input);

  setAuthCookie(res, user.id); // log the user in right after sign-up
  res.status(201).json({ user });
}

export async function login(req, res) {
  const input = validate(loginSchema, req.body);
  const user = await authService.authenticateUser(input);

  setAuthCookie(res, user.id);
  res.json({ user });
}

export function logout(req, res) {
  // clearCookie must use the same flags/path as when it was set, or the
  // browser treats it as a different cookie and keeps the old one.
  res.clearCookie(AUTH_COOKIE_NAME, cookieOptions());
  res.status(204).end();
}

export async function me(req, res) {
  const user = await authService.getUserById(req.user.id);
  // Valid token but the account no longer exists.
  if (!user) throw new UnauthorizedError();
  res.json({ user });
}
