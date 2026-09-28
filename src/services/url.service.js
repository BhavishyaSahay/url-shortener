import { prisma } from '../config/database.js';
import { encode } from '../utils/base62.js';
import { ConflictError, NotFoundError, isRecordNotFoundError, isUniqueConstraintError } from '../utils/errors.js';
import { logger } from '../utils/logger.js';

// How many times to retry if a generated code is already taken by a custom
// alias. Each retry uses a fresh sequence number, so repeated collisions are
// vanishingly unlikely; the cap only guards against an infinite loop.
const MAX_GENERATION_ATTEMPTS = 5;

/**
 * Reserve the next URL ID from PostgreSQL's sequence.
 *
 * nextval() is atomic and never hands out the same number twice, even to
 * concurrent transactions on different API instances, and even if a
 * transaction later rolls back. That's what makes ID-based codes
 * collision-free between generated codes, with no locks and no "check if the
 * code exists" query.
 */
async function reserveNextUrlId() {
  const [{ id }] = await prisma.$queryRaw`SELECT nextval('urls_id_seq')::int AS id`;
  return id;
}

/**
 * Create a short URL.
 *
 * Custom alias: insert it as the short code; the UNIQUE index rejects duplicates → 409.
 *
 * Generated code:
 *   1. id   = nextval('urls_id_seq')      e.g. 123456
 *   2. code = base62(id)                  e.g. "w7e"
 *   3. INSERT (id, short_code) in ONE statement: no second UPDATE and no
 *      window where a row exists without a code.
 * The only possible collision is with a custom alias someone already chose
 * that happens to equal base62(id), e.g. alias "w7e". The unique index catches
 * it, and we retry with the next id (leaving a harmless gap in the IDs).
 */
export async function createUrl({ userId, originalUrl, customAlias, expiresAt }) {
  const data = { userId, originalUrl, expiresAt: expiresAt ?? null };

  if (customAlias) {
    try {
      return await prisma.url.create({ data: { ...data, shortCode: customAlias, isCustomAlias: true } });
    } catch (err) {
      if (isUniqueConstraintError(err)) throw new ConflictError(`The alias "${customAlias}" is already taken`);
      throw err;
    }
  }

  for (let attempt = 1; attempt <= MAX_GENERATION_ATTEMPTS; attempt++) {
    const id = await reserveNextUrlId();
    const shortCode = encode(id);
    try {
      return await prisma.url.create({ data: { ...data, id, shortCode } });
    } catch (err) {
      if (!isUniqueConstraintError(err)) throw err;
      logger.warn({ id, shortCode, attempt }, 'Generated short code collided with a custom alias, retrying');
    }
  }
  throw new Error(`Could not generate a unique short code after ${MAX_GENERATION_ATTEMPTS} attempts`);
}

/**
 * The caller's URLs, newest first, with offset pagination. The query is
 * served by the (user_id, created_at DESC) index. id DESC breaks ties so the
 * order is stable when two links share a timestamp.
 */
export async function listUrls({ userId, page, limit }) {
  const where = { userId };
  const [urls, total] = await Promise.all([
    prisma.url.findMany({
      where,
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      skip: (page - 1) * limit,
      take: limit,
    }),
    prisma.url.count({ where }),
  ]);
  return { urls, total };
}

// ---------------------------------------------------------------------------
// Authorization: every single-URL operation filters by BOTH id AND userId,
// in the same SQL statement (WHERE id = $1 AND user_id = $2). Someone else's
// URL is indistinguishable from a missing one: both return 404, so the API
// doesn't even confirm that the ID exists.
// ---------------------------------------------------------------------------

export async function getUrl({ userId, id }) {
  const url = await prisma.url.findFirst({ where: { id, userId } });
  if (!url) throw new NotFoundError('URL not found');
  return url;
}

export async function updateUrl({ userId, id, changes }) {
  try {
    // One atomic UPDATE … WHERE id = ? AND user_id = ?; no separate
    // "load, check owner, save" steps that another request could interleave with.
    return await prisma.url.update({ where: { id, userId }, data: changes });
    // Phase 5: also invalidate the Redis cache entry for this short code.
  } catch (err) {
    if (isRecordNotFoundError(err)) throw new NotFoundError('URL not found');
    throw err;
  }
}

export async function deleteUrl({ userId, id }) {
  try {
    await prisma.url.delete({ where: { id, userId } });
    // Phase 5: also invalidate the Redis cache entry for this short code.
  } catch (err) {
    if (isRecordNotFoundError(err)) throw new NotFoundError('URL not found');
    throw err;
  }
}
