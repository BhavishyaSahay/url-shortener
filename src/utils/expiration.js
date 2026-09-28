// Expiration logic, kept as pure functions (the current time is a parameter)
// so it's trivial to unit test and is shared by the URL API and the redirect.

/** A link with no expiry never expires. A link is expired from the instant expiresAt is reached. */
export function isExpired(expiresAt, now = new Date()) {
  if (!expiresAt) return false;
  return new Date(expiresAt).getTime() <= now.getTime();
}

/**
 * The single status clients see for a link:
 *   'inactive'  deactivated by its owner (takes priority)
 *   'expired'   past its expiresAt
 *   'active'    will redirect
 */
export function getUrlStatus({ isActive, expiresAt }, now = new Date()) {
  if (!isActive) return 'inactive';
  if (isExpired(expiresAt, now)) return 'expired';
  return 'active';
}

/** Can this link be followed right now? */
export const isRedirectable = (url, now = new Date()) => getUrlStatus(url, now) === 'active';
