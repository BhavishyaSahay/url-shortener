import { z } from 'zod';
import { ValidationError } from './errors.js';

// Request validation. Controllers validate input before calling services, so
// clients get a 400 listing every problem instead of a confusing 500.

const email = z.string().trim().toLowerCase().pipe(z.email('must be a valid email'));

export const registerSchema = z.object({
  email,
  password: z.string().min(8, 'must be at least 8 characters').max(128),
});

export const loginSchema = z.object({
  email,
  password: z.string().min(1, 'is required'),
});

// Only web links: redirecting to "javascript:" URLs would let our domain run
// scripts in a visitor's browser.
const longUrl = z
  .string()
  .trim()
  .max(2048)
  .refine((value) => {
    try {
      return ['http:', 'https:'].includes(new URL(value).protocol);
    } catch {
      return false;
    }
  }, 'must be a valid http:// or https:// URL');

// Aliases can't be names of real routes like /health.
const RESERVED = new Set(['api', 'health', 'ready']);
const customAlias = z
  .string()
  .regex(/^[A-Za-z0-9_-]{3,32}$/, 'must be 3-32 letters, numbers, "-" or "_"')
  .refine((alias) => !RESERVED.has(alias.toLowerCase()), 'is reserved');

const futureDate = z.iso
  .datetime({ offset: true })
  .transform((value) => new Date(value))
  .refine((date) => date > new Date(), 'must be in the future');

export const createUrlSchema = z.object({
  url: longUrl,
  customAlias: customAlias.optional(),
  expiresAt: futureDate.optional(),
});

export const updateUrlSchema = z
  .object({
    url: longUrl.optional(),
    isActive: z.boolean().optional(),
    expiresAt: futureDate.nullable().optional(), // null removes the expiry
  })
  .refine((body) => Object.keys(body).length > 0, 'provide url, isActive or expiresAt');

export const idParamsSchema = z.object({
  id: z.coerce.number().int().positive().max(2_147_483_647),
});

export const paginationSchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
});

/** Parse `input` with `schema`, or throw a 400 listing each invalid field. */
export function validate(schema, input) {
  const result = schema.safeParse(input ?? {});
  if (!result.success) {
    const details = result.error.issues.map((i) => ({ field: i.path.join('.') || '(body)', message: i.message }));
    throw ValidationError('Request validation failed', details);
  }
  return result.data;
}
