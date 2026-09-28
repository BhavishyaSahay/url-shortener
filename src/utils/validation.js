import { z } from 'zod';
import { config } from '../config/env.js';
import { ValidationError } from './errors.js';

// Request validation schemas. Validating at the edge (in controllers) means
// services can trust their inputs, and clients get a 400 listing every
// problem at once instead of a confusing 500 from deep inside the code.

// Emails are trimmed and lower-cased so "Alice@X.com " and "alice@x.com"
// map to the same account (the DB unique index then does the rest).
const email = z.string().trim().toLowerCase().pipe(z.email('must be a valid email address').max(255));

const newPassword = z
  .string()
  .min(8, 'must be at least 8 characters')
  // An upper bound stops someone making the server hash a 1 MB "password".
  .max(128, 'must be at most 128 characters');

export const registerSchema = z.object({
  email,
  password: newPassword,
});

export const loginSchema = z.object({
  email,
  // Don't apply the "new password" rules at login: if the rules change
  // later, users with older passwords must still be able to log in.
  password: z.string().min(1, 'is required').max(128),
});

// ---------------------------------------------------------------------------
// URLs
// ---------------------------------------------------------------------------

const OWN_HOST = new URL(config.baseUrl).host;
const MAX_URL_LENGTH = 2048; // same limit as the original_url column

const longUrl = z
  .string()
  .trim()
  .min(1, 'is required')
  .max(MAX_URL_LENGTH, `must be at most ${MAX_URL_LENGTH} characters`)
  .superRefine((value, ctx) => {
    let parsed;
    try {
      parsed = new URL(value);
    } catch {
      ctx.addIssue({ code: 'custom', message: 'must be a valid absolute URL, e.g. https://example.com/page' });
      return;
    }
    // Only web links. Redirecting to "javascript:" or "data:" URLs would let
    // someone use our trusted domain to run scripts in a victim's browser.
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      ctx.addIssue({ code: 'custom', message: 'must start with http:// or https://' });
    } else if (parsed.host === OWN_HOST) {
      // Shortening our own short links creates redirect chains or loops.
      ctx.addIssue({ code: 'custom', message: 'cannot point to this URL shortener' });
    }
  });

// Aliases share the URL namespace with real routes: GET /health must not be
// claimable as a short link. (Aliases can't contain '.' or '/', so things like
// favicon.ico and robots.txt are already impossible.)
export const RESERVED_ALIASES = new Set([
  'api', 'health', 'ready', 'metrics', 'admin', 'login', 'logout', 'register', 'static', 'assets', 'docs',
]);

const customAlias = z
  .string()
  .trim()
  .min(3, 'must be at least 3 characters')
  .max(32, 'must be at most 32 characters')
  // Same character set as the database CHECK constraint on short_code.
  .regex(/^[A-Za-z0-9_-]+$/, 'may only contain letters, numbers, "-" and "_"')
  .refine((alias) => !RESERVED_ALIASES.has(alias.toLowerCase()), 'is reserved, please choose another');

// ISO 8601 with a timezone ("2026-12-31T00:00:00Z" or "...+05:30"). A time
// without a zone is ambiguous: midnight where? So we require one.
const futureDate = z.iso
  .datetime({ offset: true, error: 'must be an ISO 8601 date-time with timezone, e.g. 2026-12-31T00:00:00Z' })
  .transform((value) => new Date(value))
  .refine((date) => date.getTime() > Date.now(), 'must be in the future');

// strictObject: unknown fields are an error, not silently ignored. A typo like
// "custom_alias" should fail loudly instead of creating a link without the alias.
export const createUrlSchema = z.strictObject({
  url: longUrl,
  customAlias: customAlias.optional(),
  expiresAt: futureDate.optional(),
});

// The short code is deliberately NOT editable: changing it would break every
// place the old link was already shared.
export const updateUrlSchema = z
  .strictObject({
    url: longUrl.optional(),
    isActive: z.boolean().optional(),
    expiresAt: futureDate.nullable().optional(), // null = remove the expiry
  })
  .refine((body) => Object.keys(body).length > 0, 'provide at least one of: url, isActive, expiresAt');

export const urlIdParamsSchema = z.object({
  // Capped at the max of PostgreSQL INTEGER, so a huge ID is a 400 rather than a DB error.
  id: z.coerce.number().int().positive().max(2_147_483_647),
});

export const listUrlsQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
});

/**
 * Validate `input` against `schema`. Returns the parsed (normalized) data, or
 * throws a ValidationError whose details list each invalid field.
 */
export function validate(schema, input) {
  const result = schema.safeParse(input ?? {});
  if (!result.success) {
    const details = result.error.issues.map((issue) => ({
      field: issue.path.join('.') || '(body)',
      message: issue.message,
    }));
    throw new ValidationError('Request validation failed', details);
  }
  return result.data;
}
