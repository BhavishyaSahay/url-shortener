import { beforeEach, describe, expect, it } from 'vitest';
import { createUser, prisma, resetTables } from '../helpers/db.js';

// These tests verify that the database itself enforces the rules. The app will
// validate input too, but the database is the last line of defense: under
// concurrency, or when a bug slips through, constraints are what keep data correct.

describe('database schema', () => {
  beforeEach(resetTables);

  it('creates a user with URLs and reads them back through the relation', async () => {
    const user = await createUser({ email: 'alice@example.com' });
    await prisma.url.create({
      data: { userId: user.id, shortCode: 'abc123', originalUrl: 'https://example.com/a' },
    });

    const found = await prisma.user.findUnique({
      where: { email: 'alice@example.com' },
      include: { urls: true },
    });

    expect(found.urls).toHaveLength(1);
    expect(found.urls[0]).toMatchObject({
      shortCode: 'abc123',
      isActive: true, // column defaults
      isCustomAlias: false,
      expiresAt: null,
    });
    expect(found.createdAt).toBeInstanceOf(Date);
  });

  it('rejects duplicate emails (unique constraint)', async () => {
    await createUser({ email: 'dup@example.com' });
    await expect(createUser({ email: 'dup@example.com' })).rejects.toMatchObject({ code: 'P2002' });
  });

  it('rejects duplicate short codes, so an alias can never shadow a generated code', async () => {
    const user = await createUser();
    await prisma.url.create({ data: { userId: user.id, shortCode: 'w7E2', originalUrl: 'https://a.com' } });

    await expect(
      prisma.url.create({
        data: { userId: user.id, shortCode: 'w7E2', originalUrl: 'https://b.com', isCustomAlias: true },
      }),
    ).rejects.toMatchObject({ code: 'P2002' });
  });

  it('treats short codes as case-sensitive (Base62 needs "a" and "A" to differ)', async () => {
    const user = await createUser();
    await prisma.url.create({ data: { userId: user.id, shortCode: 'aB9', originalUrl: 'https://a.com' } });
    await expect(
      prisma.url.create({ data: { userId: user.id, shortCode: 'ab9', originalUrl: 'https://b.com' } }),
    ).resolves.toBeDefined();
  });

  it('rejects a URL owned by a non-existent user (foreign key)', async () => {
    await expect(
      prisma.url.create({ data: { userId: 999_999, shortCode: 'orphan', originalUrl: 'https://a.com' } }),
    ).rejects.toMatchObject({ code: 'P2003' });
  });

  it('deletes a user\'s URLs when the user is deleted (ON DELETE CASCADE)', async () => {
    const user = await createUser();
    await prisma.url.createMany({
      data: [
        { userId: user.id, shortCode: 'one', originalUrl: 'https://a.com' },
        { userId: user.id, shortCode: 'two', originalUrl: 'https://b.com' },
      ],
    });

    await prisma.user.delete({ where: { id: user.id } });

    expect(await prisma.url.count()).toBe(0);
  });

  it('rejects short codes with characters outside Base62/-/_ (CHECK constraint)', async () => {
    const user = await createUser();
    for (const bad of ['has space', 'slash/path', 'emoji😀', '']) {
      await expect(
        prisma.url.create({ data: { userId: user.id, shortCode: bad, originalUrl: 'https://a.com' } }),
      ).rejects.toThrow(/urls_short_code_format_check/);
    }
  });

  it('rolls back every write in a transaction if one step fails', async () => {
    await createUser({ email: 'taken@example.com' });

    await expect(
      prisma.$transaction(async (tx) => {
        const u = await tx.user.create({ data: { email: 'new@example.com', passwordHash: 'x' } });
        await tx.url.create({ data: { userId: u.id, shortCode: 'txcode', originalUrl: 'https://a.com' } });
        // Fails on the unique email, so everything above must be undone.
        await tx.user.create({ data: { email: 'taken@example.com', passwordHash: 'x' } });
      }),
    ).rejects.toMatchObject({ code: 'P2002' });

    expect(await prisma.user.findUnique({ where: { email: 'new@example.com' } })).toBeNull();
    expect(await prisma.url.findUnique({ where: { shortCode: 'txcode' } })).toBeNull();
  });

  it('sets updatedAt automatically on update', async () => {
    const user = await createUser();
    const url = await prisma.url.create({ data: { userId: user.id, shortCode: 'upd', originalUrl: 'https://a.com' } });

    const updated = await prisma.url.update({ where: { id: url.id }, data: { isActive: false } });

    expect(updated.updatedAt.getTime()).toBeGreaterThan(url.updatedAt.getTime());
  });
});

describe('indexes used by the frequent queries', () => {
  // With only a handful of rows, Postgres would (correctly) choose a sequential
  // scan because it's cheaper. Disabling seq scans for this one transaction
  // shows which index the planner WOULD use once the table is large.
  async function explain(query) {
    return prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SET LOCAL enable_seqscan = off`;
      const rows = await tx.$queryRawUnsafe(`EXPLAIN ${query}`);
      return rows.map((r) => r['QUERY PLAN']).join('\n');
    });
  }

  it('redirect lookup by short_code uses the unique index', async () => {
    const plan = await explain(`SELECT original_url FROM urls WHERE short_code = 'aB92x'`);
    expect(plan).toContain('urls_short_code_key');
  });

  it('"my URLs" listing uses the (user_id, created_at DESC) index for filter AND sort', async () => {
    const plan = await explain(`SELECT * FROM urls WHERE user_id = 1 ORDER BY created_at DESC LIMIT 20`);
    expect(plan).toContain('urls_user_id_created_at_idx');
    expect(plan).not.toContain('Sort'); // rows come out of the index already ordered
  });

  it('login lookup by email uses the unique index', async () => {
    const plan = await explain(`SELECT * FROM users WHERE email = 'a@example.com'`);
    expect(plan).toContain('users_email_key');
  });
});
