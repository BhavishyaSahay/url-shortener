import { z } from 'zod';
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
