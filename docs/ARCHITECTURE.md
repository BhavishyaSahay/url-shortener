# Architecture

## Overview

```text
                 ┌─────────┐
  Browser ──────►│  Nginx  │  single entry point, load-balances between API containers
                 └────┬────┘
            ┌─────────┴─────────┐
            ▼                   ▼
      ┌──────────┐        ┌──────────┐
      │ API (1)  │        │ API (2)  │   Express. Stateless, so any container can serve any request
      └────┬─────┘        └────┬─────┘
           └─────────┬─────────┘
           ┌─────────┴──────────────────┐
           ▼                            ▼
     ┌────────────┐          ┌─────────────────────────────┐
     │ PostgreSQL │◄──┐      │ Redis                       │
     └────────────┘   │      │ cache · rate limits · queue │
                      │      └──────────────┬──────────────┘
                      │                     │ BRPOP "clicks"
                      │             ┌───────▼────────┐
                      └─────────────│ Analytics      │
                                    │ worker         │
                                    └────────────────┘
```

| Component | Job |
| --------- | --- |
| **Nginx** | Receives all traffic on port 80 and forwards it to the API containers in turn (round-robin) |
| **API** | Auth, URL management, redirects, rate limiting, analytics endpoints. Stateless: logins are JWTs and counters live in Redis, so it can run as several containers |
| **PostgreSQL** | The source of truth: users, URLs, clicks |
| **Redis** | URL cache, rate-limit counters, and the `clicks` queue |
| **Worker** | A separate process that saves clicks from the queue to PostgreSQL |

## Database

```text
users                         urls                                  click_events
─────────────────────         ──────────────────────────────        ────────────────────
id            PK              id              PK                    id          PK
email         UNIQUE          user_id         FK → users (cascade)  url_id      FK → urls (cascade)
password_hash                 short_code      UNIQUE                clicked_at
created_at                    original_url                          referrer
updated_at                    is_custom_alias                       user_agent
                              is_active
                              expires_at
                              created_at, updated_at
```

- **Unique constraints** prevent duplicate emails and short codes, even when two requests arrive
  at the same moment. The app catches the error and returns `409 Conflict`.
- **Foreign keys with `ON DELETE CASCADE`**: deleting a user deletes their URLs, and deleting a URL
  deletes its clicks.
- **Indexes, chosen for the frequent queries:**
  - `urls.short_code` (unique): every redirect looks up a code
  - `urls (user_id, created_at DESC)`: "my URLs, newest first"
  - `users.email` (unique): login
  - `click_events (url_id, clicked_at)`: analytics for one URL
- Migrations are SQL files in `prisma/migrations`, applied with `prisma migrate deploy`.

## Short codes (Base62)

A new URL gets its ID from PostgreSQL first, and the code is that ID written in Base62
(`0-9a-zA-Z`):

```text
id = nextval('urls_id_seq')  → 123456
code = base62(123456)        → "w7e"     (32·62² + 7·62 + 14)
```

- PostgreSQL's sequence never returns the same number twice, even for concurrent requests or
  multiple API containers, so **generated codes never collide**.
- Six characters cover over 56 billion IDs.
- A custom alias is stored in the same `short_code` column. If someone already chose `w7e` as an
  alias, the unique index rejects the generated code and the app retries with the next ID.
- Aliases must be 3–32 characters of letters, numbers, `-` or `_`, and can't be route names like
  `health`.

## Redirects and caching

`GET /:shortCode` uses **cache-aside**:

1. Look up `url:<code>` in Redis. On a **HIT**, use it.
2. On a **MISS**, read PostgreSQL and store the result in Redis with a **1-hour TTL**.
3. Check the link is active and not expired (on every request, so a cached link still stops working
   exactly when it expires). Inactive or expired links get `410 Gone`; unknown codes get `404`.
4. Respond `302` with the original URL. The `X-Cache` header says `HIT` or `MISS`.

- **Invalidation:** updating or deleting a URL deletes its cache key, so the next redirect reloads
  it from PostgreSQL.
- **302, not 301:** browsers cache 301 redirects permanently, so later clicks would skip the
  server. Then edits and deactivation wouldn't apply, and clicks wouldn't be counted.
- **If Redis is down:** every lookup becomes a miss. Redirects are slower but still correct.
  PostgreSQL is the source of truth.

## Rate limiting

**Fixed window** counters in Redis:

```text
key = ratelimit:<name>:<client>:<window number>
INCR key   (+ EXPIRE after the window)   → count > limit ? 429 + Retry-After
```

| Endpoint | Limit |
| -------- | ----- |
| `POST /api/v1/auth/login` | 10 per 15 minutes per IP address |
| `POST /api/v1/urls` | 30 per minute per user |

- `INCR` is atomic, and every API container shares the same Redis, so the limit holds across
  containers.
- **Trade-off:** a client can send a full allowance just before a window ends and another just
  after (a "boundary burst").
- **If Redis is down, requests are allowed (fail open)** rather than blocking everyone.

## Analytics (background worker)

```text
redirect ──302──► user
    └── after responding: LPUSH clicks {urlId, clickedAt, referrer, userAgent}
                              │
worker: BRPOP clicks ─────────┘  →  INSERT INTO click_events
```

- **Why a queue:** writing to the database during the redirect would make every click wait for
  PostgreSQL. With a queue, the redirect does one fast Redis command, without waiting for it, and
  the worker does the database write separately.
- The API **pushes** to the left of a Redis list (`LPUSH`), and the worker **blocks** on the right
  (`BRPOP`, waiting up to 5 s for an item), so clicks are processed in order.
- The analytics endpoint answers with `GROUP BY` queries on `click_events`: total clicks, clicks
  per day (last 30 days), top 5 referrer sites, top 5 user agents. Only the URL's owner can see
  them.
- **Trade-off:** this is **at-most-once**. A click is lost if Redis is down when it's pushed, or if
  the worker crashes after taking it off the queue but before saving it. That's acceptable for
  analytics, but not for money. A queue with acknowledgements (Redis Streams, Kafka) would fix it.
- Redis is configured with `volatile-lru`: when memory is full it evicts only keys with a TTL
  (cache, counters), never the queue.

## Authentication

- Passwords are hashed with **Argon2id**: slow, salted, one-way.
- On register or login the API sets an **HTTP-only cookie** holding a **JWT** with the user's ID,
  signed with `JWT_SECRET` and valid for 1 day.
  - `HttpOnly`: JavaScript can't read it (protects against XSS).
  - `SameSite=Lax`: the browser doesn't send it with cross-site POST/PATCH/DELETE (protects
    against CSRF).
- Logout clears the cookie.
- **Authorization:** every URL query filters by `id` **and** `user_id`, so another user's URL
  returns `404`, exactly like one that doesn't exist.
- Login returns the same message for an unknown email and a wrong password.

## Docker and Nginx

- **One image** (`Dockerfile`, multi-stage) runs as the API (`node src/server.js`), the worker
  (`node worker/analytics.worker.js`) or the migration job (`npx prisma migrate deploy`).
- It runs as a non-root user.
- **Compose** starts PostgreSQL, Redis, the migration job (once), 2 API containers, the worker and
  Nginx. Containers find each other by service name (`postgres`, `redis`, `api`).
- **Startup order:** the API and worker start only after migrations have finished successfully.
  Nginx starts once the API's health check passes.
- **Nginx** forwards requests to the API containers in turn. `resolve` re-checks their addresses,
  so redeployed containers are found. The API trusts one proxy (`TRUST_PROXY=1`) so `req.ip` is
  the client's real IP.
- **Health checks:** `GET /health` (is the process up?) and `GET /ready` (is PostgreSQL
  reachable?).
- **Graceful shutdown:** on `SIGTERM` the API stops accepting requests, finishes the ones in
  progress, and closes its database and Redis connections.

## CI/CD

```text
push / pull request ──► CI: lint + unit & integration tests (real PostgreSQL + Redis) + docker build
                              │ green, on main
                              ▼
                        CD: build image → push ghcr.io/<user>/url-shortener:<commit sha>
                              │
                              ▼
                        SSH to EC2 → docker compose pull → docker compose up -d --wait
```

- Images are tagged with the **commit SHA**, so it's always clear which code is running.
- The server never builds anything; it pulls the tested image.
- GitHub Actions secrets hold the SSH key and the server's host key. App secrets (`JWT_SECRET`,
  `POSTGRES_PASSWORD`) live only in the server's `.env` file.

## Deployment

One AWS EC2 instance (Amazon Linux 2023, x86) running `docker-compose.prod.yml`:

- **Security group:** port 80 open; port 22 for SSH with keys only. PostgreSQL and Redis aren't
  reachable from outside.
- **Server setup:** Docker + the Compose plugin, a `deploy` user that the pipeline logs in as,
  `/opt/url-shortener/.env` with the secrets, and 2 GB of swap (it's a small instance).
- **Repository settings:**
  - repository variables `EC2_HOST`, `EC2_USER`, `DEPLOY_ENABLED=true`
  - environment `production` with the secrets `EC2_SSH_KEY` and `EC2_SSH_KNOWN_HOSTS`
- The site runs on plain HTTP (`COOKIE_SECURE=false`). Adding HTTPS needs a domain and a
  certificate (e.g. Let's Encrypt).

## Known limitations

- **Analytics can lose clicks** (at-most-once), as explained above.
- **A deploy restarts both API containers at once**, causing a few seconds of downtime.
- **Everything runs on one server**, a single point of failure. Next steps would be managed
  PostgreSQL/Redis (RDS, ElastiCache) and several app servers behind a load balancer.
- **Short codes are sequential**, so they're guessable. A random-looking scheme would fix that.
