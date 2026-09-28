# Low-Level Design

Implementation details and the reasoning behind them. Sections are added as each phase is
built. Still to come: caching and rate limiting (Phase 5), Kafka events (Phase 6).

- [Base62 short codes](#base62-short-codes)
- [Short-code generation and collision handling](#short-code-generation-and-collision-handling)
- [Concurrency: why duplicates are impossible](#concurrency-why-duplicates-are-impossible)
- [URL management and authorization](#url-management-and-authorization)
- [Authentication](#authentication)

## Base62 short codes

`src/utils/base62.js` writes a number in base 62 using the alphabet:

```text
0123456789 abcdefghijklmnopqrstuvwxyz ABCDEFGHIJKLMNOPQRSTUVWXYZ
 values 0-9        values 10-35               values 36-61
```

**Encoding** is repeated division by 62, the same way you'd convert decimal to binary by hand.
Each remainder is a digit, least significant first:

```text
123456 ÷ 62 = 1991  remainder 14  → 'e'
  1991 ÷ 62 =   32  remainder  7  → '7'
    32 ÷ 62 =    0  remainder 32  → 'w'
                                     read upwards: "w7e"
check: 32·62² + 7·62 + 14 = 123008 + 434 + 14 = 123456 ✓
```

(The project brief's example, `123456 → w7E2`, was illustrative. With this alphabet the real
encoding is `w7e`, and a unit test pins it.)

**Decoding** reverses it: `num = num * 62 + value(char)` for each character.

**Why Base62?**

- Every character is URL-safe (no `+`, `/`, `=` like Base64), so codes go straight into the path.
- Codes are short, because *k* characters give 62^k codes:

| Length | Codes | Reached at ID |
| ------ | ----- | ------------- |
| 1 | 62 | 0 – 61 |
| 3 | 238,328 | ≤ 238,327 |
| 4 | 14.8 million | ≤ 14,776,335 |
| 6 | 56.8 billion | covers the whole PostgreSQL `INTEGER` range (max `2147483647` → `2lkCB1`) |
| 7 | 3.5 trillion | the Bitly-scale range |

- **Case-sensitive:** `a` (10) and `A` (36) are different digits, so `aB9` ≠ `ab9`. PostgreSQL
  `VARCHAR` comparison is case-sensitive, so the unique index agrees.
- **Bijective:** each number has exactly one code and each code exactly one number. So unique
  IDs mean unique codes.

## Short-code generation and collision handling

`createUrl` in `src/services/url.service.js`:

```text
customAlias given?
 ├─ yes: INSERT (short_code = alias, is_custom_alias = true)
 │         └─ unique violation (P2002) ──────────────────────────────► 409 "alias already taken"
 │
 └─ no:  repeat up to 5 times:
           id   = SELECT nextval('urls_id_seq')      -- atomic, never repeats
           code = base62(id)
           INSERT (id, short_code = code, …)          -- one statement
             ├─ ok ──────────────────────────────────────────────────► 201
             └─ unique violation: code equals an existing custom alias
                  → log a warning, loop (next id), leaving a harmless gap in the IDs
```

**Why reserve the ID first with `nextval()`?** The code depends on the ID, but a normal
`INSERT` only gives you the ID *after* the row exists. The alternatives are worse:

| Approach | Problem |
| -------- | ------- |
| INSERT with a placeholder code, then UPDATE with base62(id) | Two writes, and a window where the row has a fake code (needs a transaction) |
| Random code, then "SELECT to check it's free", then INSERT | Check-then-act race, plus collisions grow as the table fills (birthday paradox) |
| Hash the long URL (MD5, …) and take 7 characters | Collisions possible and must be handled. Same URL from two users gives the same code |
| **`nextval()` → base62 → one INSERT** | **Chosen:** one write, no race, no collisions between generated codes |

**Where collisions can still happen.** Generated codes never collide with *each other*, because
IDs are unique. They can collide with a **custom alias**: if someone claimed alias `w7e`, then ID
123456 would also want `w7e`. Both kinds of code live in one `short_code` column with one unique
index (see [DATABASE.md](DATABASE.md)), so the database rejects the second insert and we retry
with the next ID. The integration test forces this: it sets the sequence, pre-claims the next
code as an alias, and checks the generator skips to the following ID.

**Reserved aliases.** Aliases share the root path with real routes (`/health`, `/ready`,
`/metrics`, `/api/…`), so they're blocked case-insensitively. Aliases can't contain `.` or `/`,
so `favicon.ico` and `robots.txt` are impossible anyway.

### Known trade-off: sequential codes are predictable

Because codes come from a counter, they are guessable: anyone can walk `/1`, `/2`, `/3` … and
discover every link, and early links are only one or two characters long. Links here aren't
secret (like Bitly links, they're meant to be shared), but it's a real consideration:

| Option | Effect | Cost |
| ------ | ------ | ---- |
| Keep as is | Simple and easy to reason about | Enumerable. The first 61 codes are 1 character |
| Start the sequence at 62³ (`ALTER SEQUENCE … RESTART 238328`) | Every code is ≥ 4 characters | Still sequential |
| Scramble the ID before encoding (a reversible permutation, e.g. multiply by a large prime mod 62⁶) | Codes look random, stay unique, same length | Slightly more code to explain |
| Random codes + unique index + retry on conflict | Not enumerable | Retries grow as the space fills. Loses the "no collisions" property |

## Concurrency: why duplicates are impossible

The rule is: **never "check, then write"; let one atomic database operation decide.**

| Scenario | What prevents the bug | Test |
| -------- | --------------------- | ---- |
| 25 simultaneous creates on 1–N API instances | `nextval()` hands each one a distinct ID (the sequence is shared state inside Postgres, not in Node memory) | 25 parallel requests → 25 distinct codes |
| 5 users claim alias `race` at the same moment | Unique index: exactly one INSERT wins, the rest get P2002 → 409 | `[201, 409, 409, 409, 409]` |
| Generated code equals an existing alias | Unique index + retry with the next ID | Forced collision test |
| Same email registered twice at once | Unique index on `users.email` | `[201, 409, 409, 409, 409]` |

Why a counter in Node (`let next = 1`) would be wrong: each API instance has its own memory, so
two instances would both hand out ID 7. And a restart would reset it. The database sequence is
the single source of truth that all instances share. Sequences are also **not transactional**:
a rolled-back or failed insert doesn't give its number back. That's why gaps appear, and why
the same number can never be handed out twice.

## URL management and authorization

Every single-URL query filters by **both** `id` and the caller's `userId`, in the same SQL
statement:

```js
prisma.url.update({ where: { id, userId }, data });   // UPDATE … WHERE id = $1 AND user_id = $2
prisma.url.delete({ where: { id, userId } });         // DELETE … WHERE id = $1 AND user_id = $2
prisma.url.findFirst({ where: { id, userId } });
```

- **Atomic:** no "load the row, compare `row.userId`, then save" sequence that another request
  could slip between. If the row doesn't exist *or* belongs to someone else, zero rows match,
  Prisma throws P2025, and we return **404**.
- **404, not 403, for someone else's URL.** A 403 would confirm that ID 57 exists. With 404, an
  attacker learns nothing by probing IDs.
- The **short code can't be edited** (`PATCH` is a `strictObject` without `shortCode`).
  Changing it would break every place the link was shared, and complicate cache invalidation.
- **`status`** (`active` / `inactive` / `expired`) is computed on read from `isActive` and
  `expiresAt` (`src/utils/expiration.js`). No background job has to flip a flag at the exact
  moment a link expires. Deactivation wins over expiry.
- **URL validation:** only `http`/`https`, because redirecting to `javascript:` would let our
  trusted domain run scripts in a victim's browser. No links to the shortener itself (loops).
  Max 2048 characters. `expiresAt` must be ISO 8601 **with a timezone** and in the future.
- **Pagination:** offset-based (`page`, `limit ≤ 100`), ordered by `created_at DESC, id DESC`.
  `id` breaks ties so pages are stable. Offset pagination gets slower on very deep pages; at
  scale, cursor pagination (`WHERE (created_at, id) < ($1, $2)`) fixes that.

## Authentication

### Code layout

```text
routes/auth.routes.js          URL → controller, Cache-Control: no-store
controllers/auth.controller.js validate body (zod), call service, set/clear cookie
services/auth.service.js       register / authenticate / getUserById (no Express objects)
middleware/auth.middleware.js  requireAuth: token → req.user = { id }
utils/password.js              Argon2id hash / verify
utils/jwt.js                   sign / verify access tokens
utils/validation.js            zod schemas + validate()
```

### Register flow

```text
POST /auth/register {email, password}
  │
  ├─ validate: trim + lowercase email, password 8–128 chars ──✗──► 400 + field details
  ├─ argon2id(password)  ~25 ms
  ├─ INSERT INTO users … ──── unique violation (P2002) ─────────► 409
  ├─ sign JWT {sub: userId, iss, iat, exp}
  └─ Set-Cookie: access_token=<jwt>; HttpOnly; SameSite=Lax ────► 201 {user}
```

**Duplicate emails have no "SELECT first" check.** "Check if taken, then insert" is a race: two
requests can both see "free" and both insert. We insert straight away and let the unique index
decide atomically. The integration test sends 5 simultaneous sign-ups for the same email and
asserts exactly one `201` and four `409`s.

### Login flow

```text
POST /auth/login {email, password}
  │
  ├─ SELECT … WHERE email = ?   (unique index)
  ├─ user not found ─► verify against a dummy hash (same ~25 ms) ─► 401 "Invalid email or password"
  ├─ argon2.verify(hash, password) ✗ ──────────────────────────────► 401 "Invalid email or password"
  └─ sign JWT, Set-Cookie ─────────────────────────────────────────► 200 {user}
```

**Preventing user enumeration.** An attacker shouldn't learn which emails have accounts.

- *Same message* for "unknown email" and "wrong password".
- *Same timing*: without the dummy hash, an unknown email would return in about 2 ms against
  about 27 ms for a wrong password, and that gap is measurable. Measured on this machine over 40
  interleaved requests: median **26.5 ms** (wrong password) against **25.9 ms** (unknown email).
- Registration still returns `409` for a taken email. Hiding that needs an email-verification
  flow ("if this address is new, we've sent you a link"), which is out of scope. Rate limiting
  (Phase 5) slows down bulk probing.

### Password hashing: Argon2id

| Property | Why it matters |
| -------- | -------------- |
| One-way | A database leak exposes hashes, not passwords |
| Random salt per hash | Same password gives different hashes, so precomputed rainbow tables are useless |
| Slow on purpose (~25 ms) | Invisible to one user, but an attacker gets about 40 guesses/s per core instead of billions |
| Memory-hard (19 MiB per hash) | GPUs and ASICs have lots of cores but little memory per core, so parallel cracking gets expensive |
| Self-describing (`$argon2id$v=19$m=19456,p=1,t=2$salt$hash`) | Parameters can be raised later and old hashes still verify |

**Argon2id vs bcrypt.** Both are acceptable. Argon2id is OWASP's first choice: it's memory-hard,
while bcrypt only uses 4 KB, and bcrypt silently ignores everything after 72 bytes of a
password. Parameters `m=19 MiB, t=2, p=1` are the OWASP minimum. Higher would be stronger, but
every login costs the server that much RAM and CPU. 50 simultaneous logins at 19 MiB is about
1 GB, which matters on a small EC2 instance. Rate limiting keeps login volume bounded.

### JWT access tokens

```text
eyJhbGciOiJIUzI1NiJ9 . eyJzdWIiOiI0MiIsImlzcyI6InVybC1zaG9ydGVuZXIiLCJleHAiOjE3OTA2NjExMTB9 . <signature>
      header                         payload (base64url, readable by anyone)                    HMAC-SHA256(header.payload, JWT_SECRET)
```

- **Payload:** `sub` (user ID), `iss`, `iat`, `exp`. No email and no roles: the payload is
  *encoded, not encrypted*, and anything in it goes stale until the token expires.
- **Signature (HS256):** proves the server issued the token and nobody changed it. Editing `sub`
  to impersonate another user invalidates the signature (a unit test checks this).
- **Verification pins `algorithms: ['HS256']`** and the issuer. Without that, a forged token
  claiming `"alg": "none"` could skip signature checking, a well-known class of JWT
  vulnerability.
- **`JWT_SECRET`** must be at least 32 random characters. Config validation refuses to start
  without one. Anyone with the secret can mint a token for any user, so it lives only in env
  vars or secret stores, never in git.
- **Stateless:** `requireAuth` verifies the signature and never queries the database. Any API
  instance can check any token with no shared session store, which is why JWTs suit horizontal
  scaling. `GET /me` does query the DB, so a deleted user gets `401`.

### Why an HTTP-only cookie (not localStorage)

| | HTTP-only cookie | `localStorage` + `Authorization` header |
| - | - | - |
| XSS (injected script) | Script **can't read** the token | Script reads and exfiltrates the token |
| CSRF (another site triggers a request) | Browser attaches the cookie, so it needs a defense (below) | Not affected: headers aren't sent automatically |
| Client code | Nothing to do, sent automatically | Must attach the header on every request |

Cookie flags:

- `HttpOnly`: not readable from JavaScript.
- `Secure`: HTTPS only. On when `NODE_ENV=production`; `COOKIE_SECURE=false` allows plain-HTTP
  testing before TLS is set up.
- `SameSite=Lax`: the browser won't attach the cookie to cross-site `POST`, `PATCH` or
  `DELETE` requests. That's the main **CSRF defense**, because every state-changing endpoint
  here uses one of those methods. `Lax` rather than `Strict` so a user clicking a link to the
  app from another site still arrives logged in.
- `Max-Age` equals the JWT lifetime, so the cookie and token expire together.

Together with JSON-only bodies (a cross-site HTML form can't send `application/json` without a
CORS preflight, which we don't allow), this is enough for this app. A cross-origin frontend
would need CORS with credentials, plus a CSRF token or `SameSite=None; Secure`.

The `Authorization: Bearer` header is also accepted, for curl, scripts and k6 load tests.
Bearer tokens are never sent automatically, so they aren't exposed to CSRF.

### Logout and its limitation

Logout clears the cookie. The JWT itself **stays valid until it expires**, because the server
keeps no session state to delete. If a token were stolen, the attacker could use it until
`exp`. Options, from simplest to most complete:

1. **Short expiry** (current: `JWT_EXPIRES_IN=1d`, configurable). This limits the damage window.
2. **Denylist in Redis:** on logout, store the token's ID with a TTL equal to its remaining
   lifetime, and have `requireAuth` reject listed IDs. This costs one Redis lookup per request.
   Redis arrives in Phase 5.
3. **Short access token (15 min) plus a refresh token** stored in the DB and rotated on use.
   This is the standard production pattern and more moving parts than this project needs now.

### Authorization vs authentication

- **Authentication** (`requireAuth`): *who are you?* Sets `req.user.id`, or returns 401.
- **Authorization** (Phase 4 services): *may you touch this URL?* Every URL query includes
  `WHERE id = ? AND user_id = ?`. Another user's URL returns **404, not 403**, so the API
  doesn't even confirm the URL exists.
