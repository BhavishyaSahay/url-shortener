# Database Design

PostgreSQL is the **source of truth** for users and URLs. Redis (Phase 5) is only a cache in
front of it: if Redis loses everything, no data is lost.

Schema: [`prisma/schema.prisma`](../prisma/schema.prisma) · Migrations: [`prisma/migrations/`](../prisma/migrations/)

## Entity-relationship diagram

```text
┌──────────────────────────────┐          ┌──────────────────────────────────┐
│ users                        │          │ urls                             │
├──────────────────────────────┤          ├──────────────────────────────────┤
│ id            SERIAL      PK │ 1      N │ id              SERIAL        PK │
│ email         VARCHAR(255) U │──────────│ user_id         INTEGER  FK → users.id
│ password_hash VARCHAR(255)   │          │ short_code      VARCHAR(32)    U │
│ created_at    TIMESTAMPTZ    │          │ original_url    VARCHAR(2048)    │
│ updated_at    TIMESTAMPTZ    │          │ is_custom_alias BOOLEAN          │
└──────────────────────────────┘          │ is_active       BOOLEAN          │
                                          │ expires_at      TIMESTAMPTZ NULL │
                                          │ created_at      TIMESTAMPTZ      │
                                          │ updated_at      TIMESTAMPTZ      │
                                          └──────────────────────────────────┘
PK = primary key   U = unique   FK = foreign key (ON DELETE CASCADE)
```

Analytics tables (Phase 6, migration `add_click_analytics`), written only by the worker:

```text
┌──────────────────────────────────┐        ┌─────────────────────────────────┐
│ click_events                     │        │ url_daily_stats                 │
├──────────────────────────────────┤        ├─────────────────────────────────┤
│ id            BIGSERIAL       PK │        │ url_id  INTEGER  PK, FK → urls  │
│ event_id      UUID             U │        │ day     DATE     PK             │
│ url_id        INTEGER  FK → urls │        │ clicks  INTEGER                 │
│ clicked_at    TIMESTAMPTZ        │        └─────────────────────────────────┘
│ ip_hash       VARCHAR(64)        │   both: ON DELETE CASCADE from urls
│ user_agent    VARCHAR(512)       │
│ browser       VARCHAR(32)        │   index: click_events (url_id, clicked_at)
│ referrer_host VARCHAR(255)       │
└──────────────────────────────────┘
```

- **`click_events`**: one row per click, the detailed record behind referrers, browsers and
  unique visitors.
  - `BIGSERIAL`, because clicks outnumber URLs by orders of magnitude.
  - `event_id UNIQUE` makes the worker idempotent under Kafka's at-least-once delivery.
  - Only an HMAC of the IP and the referrer *host* are stored (data minimization).
- **`url_daily_stats`**: a pre-aggregated rollup with a composite PK `(url_id, day)`. The
  "clicks per day" chart reads about 30 tiny rows instead of counting millions of events. The
  worker upserts it with `INSERT … ON CONFLICT (url_id, day) DO UPDATE SET clicks = clicks + n`
  in the same transaction as the raw insert.
- **Raw plus rollup, not just one:** raw rows keep flexibility for new breakdowns, and rollups
  keep the most common query cheap. Days are UTC.

## Constraints

| Constraint | Table | What it guarantees |
| ---------- | ----- | ------------------ |
| `users_pkey`, `urls_pkey` | both | Every row has a unique, non-null ID |
| `users_email_key` (UNIQUE) | users | One account per email, even if two sign-ups race |
| `urls_short_code_key` (UNIQUE) | urls | A short code points to exactly one URL |
| `urls_user_id_fkey` (FK, `ON DELETE CASCADE`) | urls | Every URL has an owner. Deleting a user deletes their URLs |
| `urls_short_code_format_check` (CHECK) | urls | Short codes only contain `0-9 a-z A-Z - _` |
| `NOT NULL` + defaults | both | `is_active = true`, `is_custom_alias = false`, timestamps set automatically |

**Why enforce rules in the database when the app validates too?** Application checks such as "is
this alias free?" followed by an insert are a *check-then-act* race: two requests can both see
the alias as free, then both insert. Only a database constraint is atomic. The app catches the
unique-violation error (Prisma code `P2002`) and returns `409 Conflict`. The CHECK constraint is
defense in depth: even a bug that skips validation can't store a code that would break a URL.

## Design decisions

### One `short_code` column for generated codes and custom aliases

The original plan listed a separate `customAlias` column. I store both kinds of code in
`short_code` and record which kind it is in `is_custom_alias`:

- **One namespace, one unique index.** With two columns, alias `"abc"` and generated code
  `"abc"` could both exist, and there is no single-column constraint to stop it. With one column
  the database makes that collision impossible.
- **The redirect is one indexed lookup:** `WHERE short_code = ?`, rather than
  `WHERE short_code = ? OR custom_alias = ?`.
- `is_custom_alias` still tells the UI and analytics which links were user-chosen.

### `short_code` is case-sensitive

Base62 uses both `a` and `A`, so `aB9` and `ab9` must be different codes. PostgreSQL's default
`VARCHAR` comparison is case-sensitive. Emails are the opposite: the app lower-cases them before
saving, so `Alice@x.com` and `alice@x.com` can't create two accounts.

### `SERIAL` (32-bit) IDs

`INTEGER` allows about 2.1 billion URLs, which is 6 Base62 characters at most. That's plenty for
this project and avoids JavaScript `BigInt` handling (`JSON.stringify` can't serialise BigInt).
At real Bitly scale I would use `BIGINT`: a one-line schema change plus a migration.

### `TIMESTAMPTZ` for all times

`TIMESTAMPTZ` stores an absolute instant (UTC internally). Expiry checks like
`expires_at > now()` are correct whatever timezone the server, container or client is in. Plain
`TIMESTAMP` is a wall-clock time with no zone, which is a classic source of bugs.

### `VARCHAR(2048)` for `original_url`

Browsers and most servers handle URLs of about 2,000 characters in practice. The limit stops
someone storing megabytes in a single row. The app validates the same limit and returns a proper
400 error first.

### `snake_case` in SQL, `camelCase` in JavaScript

Prisma's `@map`/`@@map` gives idiomatic names on both sides: `users.password_hash` in SQL and
`user.passwordHash` in code.

## Indexes: designed around the frequent queries

Every index speeds up reads but slows down every `INSERT`/`UPDATE` (the index must be updated
too) and uses disk. So I only created indexes for queries the app will actually run:

| Query | Frequency | Index |
| ----- | --------- | ----- |
| Redirect: `SELECT … FROM urls WHERE short_code = $1` | **Very high**: every click (on a Redis miss) | `urls_short_code_key` (unique B-tree) |
| Dashboard: `… WHERE user_id = $1 ORDER BY created_at DESC LIMIT 20` | Medium: every dashboard load | `urls_user_id_created_at_idx` on `(user_id, created_at DESC)` |
| Login: `SELECT … FROM users WHERE email = $1` | Medium | `users_email_key` (unique B-tree) |
| Analytics breakdowns: `… FROM click_events WHERE url_id = $1 AND clicked_at >= $2 GROUP BY …` | Low (owner dashboard) | `click_events_url_id_clicked_at_idx` |
| Clicks per day: `… FROM url_daily_stats WHERE url_id = $1 AND day >= $2` | Low | Primary key `(url_id, day)` |
| Worker dedupe: `INSERT … ON CONFLICT (event_id)` | Every click (batched) | `click_events_event_id_key` |
| By ID: `WHERE id = $1` (get/update/delete a URL) | Medium | Primary key |

Notes:

- **Unique constraints create indexes automatically.** No separate index is needed on `email`
  or `short_code`.
- **PostgreSQL does not index foreign keys automatically** (MySQL does). Without an index on
  `urls.user_id`, deleting a user (`ON DELETE CASCADE`) or listing their URLs scans the whole
  table. The composite index starts with `user_id`, so it covers the FK too.
- **Why composite `(user_id, created_at DESC)` and not just `(user_id)`:** the index stores each
  user's rows already sorted newest-first. Postgres reads the first 20 entries and stops. There's
  no separate sort step, and no need to read all of a user's URLs.
- **Not indexed (yet):** `expires_at` and `is_active`. They're always checked on a row already
  found by `short_code`, so they don't need their own index. If we add a background job that
  deletes expired links, a partial index such as `WHERE expires_at IS NOT NULL` would be
  justified then.

`tests/integration/database.test.js` verifies with `EXPLAIN` that the planner uses each of these
indexes.

## Transactions

A transaction groups several statements so they either **all** succeed or **all** roll back
(the A in ACID). Prisma offers:

```js
await prisma.$transaction(async (tx) => {
  const user = await tx.user.create({ data: { ... } });
  await tx.url.create({ data: { userId: user.id, ... } });
  // any error thrown here rolls back BOTH inserts
});
```

A single statement is already atomic, so most operations here (create one URL, delete one URL)
don't need an explicit transaction. The integration tests include a rollback test to show the
behaviour. Later phases use transactions where multi-step writes must be consistent, such as the
analytics worker writing aggregated click counts.

## Connection pooling

```text
 Express request ─┐
 Express request ─┼──► pg.Pool (max = DB_POOL_MAX, default 10) ──► PostgreSQL
 Express request ─┘       reuses open connections;
                          extra queries queue instead of opening more
```

- Opening a PostgreSQL connection is expensive: TCP, authentication, and a new server process
  per connection. The pool keeps connections open and reuses them.
- **Prisma 7 driver adapter:** Prisma runs queries through `@prisma/adapter-pg` on a node-postgres
  `Pool` that we create in `src/config/database.js`. That lets us set `max`, `idleTimeoutMillis`
  and `connectionTimeoutMillis`, and read `pool.totalCount` / `idleCount` / `waitingCount` for
  metrics (Phase 10).
- **Sizing:** Postgres allows 100 connections by default. With 2 API instances × 10 plus a
  worker × 5, we use 25, leaving room for migrations, `psql` and monitoring. More connections is
  not faster: past roughly 2–4× CPU cores, Postgres spends time context-switching. If we ever
  need hundreds of app instances, the fix is PgBouncer, not a bigger pool.
- `pool.on('error')` handles idle connections that die, for example when Postgres restarts. The
  process stays up and the pool reconnects on the next query.

## Startup, readiness and shutdown

- **Startup:** `connectDatabase()` retries `SELECT 1` with exponential backoff (0.5 s, 1 s, 2 s …
  capped at 10 s, 10 attempts). The HTTP server only starts listening after it succeeds, so the
  API never accepts traffic it can't serve. If the database never comes up, the process exits
  with code 1 and Docker's restart policy tries again.
- **`GET /ready`** runs `SELECT 1` with a 2 s timeout and returns 503 when the database is down,
  so a load balancer stops routing to that instance. `GET /health` never touches the database.
- **Shutdown:** in-flight requests finish first, then `prisma.$disconnect()` and `pool.end()`
  close every connection cleanly, so Postgres doesn't log aborted connections.

## Migrations workflow

| Command | When |
| ------- | ---- |
| `npm run db:migrate -- --name add_x` | Development: diff `schema.prisma` against the DB, write a new SQL migration, apply it |
| `npx prisma migrate dev --create-only --name x` | Generate the SQL but don't apply it, so you can edit it (used to add the CHECK constraint) |
| `npm run db:deploy` | CI / production: apply pending migrations only. It never generates or drops anything |
| `npm run db:studio` | Browse data in a web UI |

Migrations are plain SQL files committed to git. That makes schema changes reviewable in pull
requests, and every environment (laptop, CI, EC2) reaches the same schema by replaying the same
files in order. Prisma records applied migrations in the `_prisma_migrations` table.

**Test database:** integration tests use a separate `url_shortener_test` database. Before the
suite, `migrate deploy` brings it up to date, and each test truncates the tables for a clean
slate. A guard refuses to run against any database whose name doesn't end in `_test`.
