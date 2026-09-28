# Low-Level Design

Implementation details and the reasoning behind them. Sections are added as each phase is
built: Base62 and collision handling (Phase 4), caching and rate limiting (Phase 5), and Kafka
events (Phase 6).

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
