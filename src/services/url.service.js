import { prisma } from '../config/database.js';
import { encode } from '../utils/base62.js';
import { ConflictError, NotFoundError, isRecordNotFound, isUniqueViolation } from '../utils/errors.js';
import { removeFromCache } from './redirect.service.js';

/**
 * Short codes come from the database ID:
 *   id   = nextval('urls_id_seq')   PostgreSQL never hands out the same number twice
 *   code = base62(id)               e.g. 123456 → "w7e"
 * So generated codes never clash with each other. They can clash with a custom
 * alias someone already chose (alias "w7e"); the unique index on short_code
 * catches that and we retry with the next ID.
 */
export async function createUrl({ userId, originalUrl, customAlias, expiresAt }) {
  const data = { userId, originalUrl, expiresAt };

  if (customAlias) {
    try {
      return await prisma.url.create({ data: { ...data, shortCode: customAlias, isCustomAlias: true } });
    } catch (err) {
      if (isUniqueViolation(err)) throw ConflictError(`The alias "${customAlias}" is already taken`);
      throw err;
    }
  }

  for (let attempt = 0; attempt < 5; attempt++) {
    const [{ id }] = await prisma.$queryRaw`SELECT nextval('urls_id_seq')::int AS id`;
    try {
      return await prisma.url.create({ data: { ...data, id, shortCode: encode(id) } });
    } catch (err) {
      if (!isUniqueViolation(err)) throw err; // clashed with an alias: try the next ID
    }
  }
  throw new Error('Could not generate a unique short code');
}

export async function listUrls({ userId, page, limit }) {
  const where = { userId };
  const [urls, total] = await Promise.all([
    prisma.url.findMany({ where, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], skip: (page - 1) * limit, take: limit }),
    prisma.url.count({ where }),
  ]);
  return { urls, total };
}

// Authorization: every query filters by id AND userId, so someone else's URL
// behaves exactly like a URL that doesn't exist (404).
export async function getUrl({ userId, id }) {
  const url = await prisma.url.findFirst({ where: { id, userId } });
  if (!url) throw NotFoundError('URL not found');
  return url;
}

export async function updateUrl({ userId, id, changes }) {
  let url;
  try {
    url = await prisma.url.update({ where: { id, userId }, data: changes });
  } catch (err) {
    if (isRecordNotFound(err)) throw NotFoundError('URL not found');
    throw err;
  }
  await removeFromCache(url.shortCode); // the next redirect loads the new version
  return url;
}

export async function deleteUrl({ userId, id }) {
  let url;
  try {
    url = await prisma.url.delete({ where: { id, userId } });
  } catch (err) {
    if (isRecordNotFound(err)) throw NotFoundError('URL not found');
    throw err;
  }
  await removeFromCache(url.shortCode);
}
