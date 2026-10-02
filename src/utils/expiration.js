// A link with no expiry never expires; otherwise it expires at expiresAt.
export function isExpired(expiresAt, now = new Date()) {
  if (!expiresAt) return false;
  return new Date(expiresAt) <= now;
}

// 'inactive' (deactivated by its owner) | 'expired' | 'active' (redirects)
export function getUrlStatus({ isActive, expiresAt }, now = new Date()) {
  if (!isActive) return 'inactive';
  if (isExpired(expiresAt, now)) return 'expired';
  return 'active';
}
