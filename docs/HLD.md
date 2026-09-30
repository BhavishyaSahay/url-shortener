# High-Level Design

A URL shortener in the style of a simplified Bitly: users create short links that redirect to long
URLs, and see analytics about who clicked them.

Details live in [LLD.md](LLD.md) (algorithms and trade-offs), [DATABASE.md](DATABASE.md) (schema
and indexes), [API.md](API.md) (endpoints) and [DEVOPS.md](DEVOPS.md) (containers, Nginx,
deployment).

## 1. Problem statement

Long URLs are awkward to share, and their owners can't tell whether anyone opened them. The
system must:

1. Turn a long URL into a short, unique code (`https://short.ly/aB92x`).
2. Redirect anyone who opens the short URL, quickly and reliably, at any scale of traffic.
3. Let the owner manage their links (custom alias, expiry, deactivate, delete).
4. Record clicks and show basic analytics, **without slowing down redirects**.

## 2. Requirements

### Functional

| # | Requirement | Where |
| - | ----------- | ----- |
| F1 | Register, log in, log out | `/api/v1/auth/*` |
| F2 | Create a short URL, optionally with a custom alias and expiry | `POST /api/v1/urls` |
| F3 | Redirect `GET /:shortCode` to the original URL | redirect route |
| F4 | List, view, update, deactivate and delete **own** URLs | `/api/v1/urls/:id` |
| F5 | Analytics per URL: total clicks, clicks per day, top referrers, browsers | `GET /api/v1/urls/:id/analytics` |

### Non-functional

| Property | Target and approach |
| -------- | ------------------- |
| **Read-heavy** | Links are clicked far more often than created (Bitly-style services see roughly 100:1). Optimize the redirect path first |
| Low redirect latency | Redis cache in front of PostgreSQL; analytics moved off the request path |
| Availability of redirects | Redirects survive Redis or Kafka outages (degraded, not down) |
| Correctness | No duplicate short codes, even under concurrency and across instances |
| Security | Hashed passwords, HTTP-only JWT cookies, owner-only access, rate limiting, input validation |
| Horizontal scalability | Stateless API instances. Shared state lives only in PostgreSQL, Redis and Kafka |
| Observability | Structured logs, health/readiness endpoints; metrics in Phase 10 |

Out of scope: custom domains, link previews, teams and roles, billing, a frontend UI.

## 3. Architecture

```text
                          ┌──────────────┐
                          │    Client    │  browser / curl / k6
                          └──────┬───────┘
                                 │ HTTP
                                 ▼
                          ┌──────────────┐
                          │    Nginx     │  reverse proxy, load balancing
                          └──────┬───────┘
                    ┌────────────┴────────────┐
                    ▼                         ▼
             ┌──────────────┐          ┌──────────────┐
             │ Express API  │   ...    │ Express API  │   stateless: any instance can
             │  instance 1  │          │  instance N  │   serve any request
             └──┬───┬───┬───┘          └──┬───┬───┬───┘
                │   │   └──── produce ────┼───┼───┴────────────┐
                │   └─────────────┬───────┼───┘                │
                ▼                 ▼       ▼                    ▼
         ┌────────────┐     ┌──────────┐                ┌────────────┐
         │ PostgreSQL │     │  Redis   │                │   Kafka    │ topic: url-clicks
         │  (source   │     │ (cache + │                │ (3 parts.) │
         │  of truth) │     │ rate lim)│                └─────┬──────┘
         └─────▲──────┘     └──────────┘                      │ consume
               │                                              ▼
               │                                     ┌──────────────────┐
               └──────────── write analytics ────────│ Analytics worker │  separate process
                                                     └──────────────────┘
```

This is deliberately **one modular API plus one worker**, not microservices. Auth, URL management,
redirects and analytics queries share one codebase and deployment. That's simpler to build, test,
deploy and reason about. The worker is separate because it has a different job (batch
consumption), a different scaling profile, and must not affect redirects if it fails.

## 4. Components

| Component | Responsibility | State? |
| --------- | -------------- | ------ |
| **Nginx** | Single entry point, reverse proxy + round-robin load balancing across API instances (re-resolved via Docker DNS), forwards client IP headers, request limits | No |
| **Express API** | Auth, URL CRUD, redirects, rate limiting, analytics queries, publishing click events | **No**: sessions are JWTs, counters live in Redis |
| **PostgreSQL** | Users, URLs, click events, daily rollups. **Source of truth** | Yes |
| **Redis** | Cache `shortCode → URL`, rate-limit counters. Losing it loses nothing permanent | Ephemeral |
| **Kafka** | Durable buffer of click events between the API and the worker | Yes (retained log) |
| **Analytics worker** | Consumes click events in batches and writes raw events and daily rollups idempotently | No |

Code layering inside the API: **routes → controllers** (HTTP, validation) **→ services** (business
logic) **→ Prisma / Redis / Kafka clients** (`src/config/`).

## 5. Key flows

### 5.1 URL creation

```text
POST /api/v1/urls {url, customAlias?, expiresAt?}      (cookie: access_token)
 → requireAuth (verify JWT)             → 401 if missing or invalid
 → rate limit (Redis, per user)         → 429 if exceeded
 → validate (http/https, alias rules, future expiry)   → 400
 → alias?  INSERT short_code = alias                   → 409 if taken (unique index)
   else:   id = nextval(seq); code = base62(id); INSERT (id, code); retry on alias collision
 → DEL url:<code> in Redis (clear any cached "not found")
 → 201 {url: {shortUrl, …}}
```

### 5.2 Redirect (the hot path)

```text
GET /aB92x
 → Redis GET url:aB92x
     HIT  → decision fields from the cache (sub-millisecond)
     MISS → PostgreSQL by unique index → SET in Redis with TTL
 → not found 404 · deactivated or expired 410
 → 302 Location: <originalUrl>          ← response sent here
 → publish click event to Kafka          (after the response, never awaited)
```

### 5.3 Analytics

```text
API (after 302) ──produce──► Kafka url-clicks (key = shortCode)
                                  │ at-least-once delivery
                                  ▼
Worker: poll batch → validate → ONE transaction:
          INSERT click_events ON CONFLICT (event_id) DO NOTHING   (dedupe)
          UPSERT url_daily_stats (+n per url/day)                 (rollup)
        → commit Kafka offsets only after the transaction succeeds

GET /api/v1/urls/:id/analytics (owner only)
 → totals and clicks per day from url_daily_stats (small)
 → referrers, browsers and unique visitors from click_events (indexed by url_id, clicked_at)
```

Analytics are **eventually consistent**: a click appears once the worker has processed it
(sub-second in testing), not at the instant of the redirect.

## 6. Data stores

### PostgreSQL: the source of truth

Tables `users`, `urls`, `click_events`, `url_daily_stats`. Unique constraints do the correctness
work (email, short code, event ID), and indexes follow the real queries. See
[DATABASE.md](DATABASE.md).

### Redis: cache and counters

- **Cache-aside:** only clicked links are cached (1 h TTL). "Not found" is cached for 60 s.
  Writes delete the key.
- **Rate limiting:** fixed-window counters (`INCR` + `EXPIRE`), shared by all API instances.
- No persistence and LRU eviction: it's allowed to forget everything.

### Kafka: why a message queue for clicks?

Writing a click row inside the redirect would put a database **write** on the hottest read path.
Every click would wait for PostgreSQL, and a slow or down analytics database would slow down or
break redirects. With Kafka:

- The redirect does an in-memory hand-off to the producer and returns. The user never waits for
  analytics.
- **Decoupling:** the worker can be slow, restarted, redeployed or down, and Kafka retains the
  events until it catches up. (Tested: clicks made while the worker was stopped were all counted
  once it started.)
- **Batching:** the worker writes many clicks per transaction, which is much cheaper than one
  write per click.
- **Scaling:** partitions let several worker instances share the load.

Why Kafka rather than a Redis list or RabbitMQ? Kafka is a *durable, replayable log*. Consumers
track their own offsets, events can be re-read for backfills, and partitions give ordered
per-key processing plus parallelism. For this project's volume a simpler queue would work too;
Kafka was chosen to learn the event-streaming model, and the design would carry over to real
scale.

## 7. Scaling

| Layer | How it scales | Limit / next step |
| ----- | ------------- | ----------------- |
| API | Run N identical instances behind Nginx (`docker compose up --scale api=N`; verified with 3, even 10/10/10 split). No sticky sessions: JWTs, Redis counters and DB sequences are shared | CPU per instance; the DB connection budget (N × pool size) |
| Redirect reads | Mostly served by Redis. PostgreSQL only sees misses | Redis memory → LRU; later Redis replicas or cluster |
| URL writes | One `nextval()` + one `INSERT`. The sequence is safe across instances | A single primary DB; fine for this scale |
| Analytics ingest | Add worker instances to the same consumer group, up to the number of partitions (3) | Add partitions; batch size |
| Analytics reads | Daily rollups keep "clicks per day" small | Partition `click_events` by time; move analytics to a column store at huge scale |
| PostgreSQL | Vertical scaling, connection pooling, indexes | Read replicas for redirect misses and analytics; PgBouncer |

Back-of-envelope storage (estimates, not measurements): a `urls` row is about 300 bytes plus
index, so 10 million links is roughly 5 GB. A `click_events` row is about 250 bytes, so 100
million clicks is roughly 25–30 GB. The raw table is what grows; retention policies or
time-partitioning would be the first fix.

## 8. Failure handling

| Failure | Effect | Behaviour |
| ------- | ------ | --------- |
| **PostgreSQL down** | Critical | API waits for it at startup (retry with backoff). While running, `/ready` returns 503, so load balancers stop routing. Cached redirects still work from Redis |
| **Redis down** | Degraded | Every cache and rate-limit call fails fast (no offline queue), reads go to PostgreSQL, rate limiting **fails open**. `/ready` returns 200 `"degraded"`. Auto-reconnects |
| **Kafka down** | Degraded | Redirects unaffected (measured 1–3 ms during an outage). Click events are **dropped** (bounded: at most 1000 in flight). `/ready` returns 200 `"degraded"`. The producer recovers automatically |
| **Worker down / crashed** | Delayed analytics | Kafka retains events. A crashed consumer exits the process, and the supervisor restarts it from the last committed offset |
| **Duplicate Kafka delivery** | None | `event_id` unique plus rollup only from newly inserted rows: processing is idempotent |
| **Malformed event** | None | Validated with zod; poison messages are logged and skipped, not retried forever |
| **API instance killed** | Requests in flight | Graceful shutdown on SIGTERM: `/ready` returns 503, then drain, then close DB, Redis and Kafka |
| **Traffic spike or brute force** | | Redis rate limits on login and creation; Nginx limits (Phase 7) |

**Health vs readiness.** `/health` only says "this process is alive" and never checks
dependencies, so a DB outage doesn't make an orchestrator restart healthy API containers.
`/ready` checks dependencies and separates **critical** (PostgreSQL → 503) from **non-critical**
(Redis, Kafka → 200 degraded). Failing readiness because the cache is down would take every
instance out of rotation at once.

### Delivery guarantees, stated honestly

- **API → Kafka: at-most-once.** If Kafka is down, events are dropped rather than slowing
  redirects. For analytics that's an acceptable trade. For events that must never be lost, the
  fix is a *transactional outbox*: write the event to PostgreSQL in the same transaction, and
  relay it to Kafka separately.
- **Kafka → worker → DB: at-least-once delivery with idempotent writes**, which gives
  effectively exactly-once results in the database.
