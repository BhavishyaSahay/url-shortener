import { config } from '../config/env.js';
import { AUTH_COOKIE } from '../middleware/auth.middleware.js';
import * as authService from '../services/auth.service.js';
import { UnauthorizedError } from '../utils/errors.js';
import { TOKEN_LIFETIME_SECONDS, signToken } from '../utils/jwt.js';
import { loginSchema, registerSchema, validate } from '../utils/validation.js';

// httpOnly → JavaScript on the page can't read the token (protects against XSS)
// sameSite → the browser doesn't send it with cross-site POST/PATCH/DELETE (protects against CSRF)
// secure   → HTTPS only (off while the site runs on plain HTTP)
const cookieOptions = { httpOnly: true, sameSite: 'lax', secure: config.cookieSecure, path: '/' };

function setAuthCookie(res, userId) {
  res.cookie(AUTH_COOKIE, signToken(userId), { ...cookieOptions, maxAge: TOKEN_LIFETIME_SECONDS * 1000 });
}

export async function register(req, res) {
  const user = await authService.registerUser(validate(registerSchema, req.body));
  setAuthCookie(res, user.id); // logged in right after sign-up
  res.status(201).json({ user });
}

export async function login(req, res) {
  const user = await authService.loginUser(validate(loginSchema, req.body));
  setAuthCookie(res, user.id);
  res.json({ user });
}

export function logout(req, res) {
  res.clearCookie(AUTH_COOKIE, cookieOptions);
  res.status(204).end();
}

export async function me(req, res) {
  const user = await authService.getUser(req.user.id);
  if (!user) throw UnauthorizedError(); // valid token, but the account no longer exists
  res.json({ user });
}
