# Low-Level Design

Implementation details and the reasoning behind them. For the big picture see [HLD.md](HLD.md).

- [Click events: Redis Streams and the analytics worker](#click-events-redis-streams-and-the-analytics-worker)
- [Redirect and caching (Redis)](#redirect-and-caching-redis)
- [Rate limiting](#rate-limiting)
- [Base62 short codes](#base62-short-codes)
- [Short-code generation and collision handling](#short-code-generation-and-collision-handling)
- [Concurrency: why duplicates are impossible](#concurrency-why-duplicates-are-impossible)
- [URL management and authorization](#url-management-and-authorization)
- [Authentication](#authentication)

## Click events: Redis Streams and the analytics worker

### Why Redis Streams (and not Kafka)

Phase 6 first used **Apache Kafka**. It worked and was tested end to end, but it was replaced to fit
the deployment target, a 1 GB AWS t3.micro:

| Measured (production stack, idle) | With Kafka | With Redis Streams |
| --------------------------------- | ---------- | ------------------ |
| Kafka broker (JVM) | 436 MiB | (none) |
| Whole stack | **~695 MiB** | **~260 MiB** |

Kafka alone used about two-thirds of the memory and would not fit on a 1 GB server next to
PostgreSQL, Node and the OS. Redis was already running (cache and rate limits), and **Redis
Streams** provides the same building blocks: an append-only log, consumer groups,
acknowledgements, redelivery of unacknowledged entries, and taking over a dead consumer's work.
The architecture (producer → queue → worker → PostgreSQL) and the idempotent processing are
unchanged.

| Concept | Kafka | Redis Streams (used) |
| ------- | ----- | -------------------- |
| Log | topic `url-clicks`, partitions on disk | stream key `url-clicks` (entries in memory, persisted by AOF) |
| Write | `producer.send` | `XADD url-clicks MAXLEN ~ N * event <json>` |
| Consumer group | yes, partitions assigned per consumer | yes, entries handed out one by one |
| "Processed" | commit offset | `XACK` |
| Not processed yet | offset not committed → redelivered | entry stays in the **pending entries list (PEL)** → retried |
| Dead consumer | group rebalance after the session timeout | `XAUTOCLAIM` of entries idle > 60 s |
| Retention | time/size on disk | `MAXLEN ~` cap (entries are also deleted once processed) |
| Ordering | per partition (per key) | whole stream (per consumer, entries arrive in order) |
| Scale ceiling | very high (distributed, replicated) | one Redis node's memory and CPU |

**Trade-offs accepted:** Kafka is the better tool at real scale: disk-based retention for days,
replication across brokers, replay for backfills, much higher throughput. For this project's
volume and a single small server, Redis Streams provides the same guarantees we actually rely on
at a fraction of the memory. If the system outgrew one Redis, moving back to Kafka changes only
the producer call and the consumer loop.

### The event

Published by the API after every successful `GET` redirect (not `HEAD`):

```json
{
  "eventId": "0f8fad5b-d9cb-469f-a165-70867728950e",
  "urlId": 6,
  "shortCode": "aB92x",
  "timestamp": "2026-09-29T17:38:44.207Z",
  "ipHash": "3b1f0c…(32 hex chars)",
  "userAgent": "Mozilla/5.0 … Chrome/140.0 …",
  "referrer": "https://www.twitter.com/post/1"
}
```

| Field | Why |
| ----- | --- |
| `eventId` | A UUID per click. The worker's **deduplication key** (see idempotency) |
| `urlId` + `shortCode` | Which link. The worker checks both still match a row, and skips events for deleted links |
| `ipHash` | `HMAC-SHA256(ip)` with a key derived from `JWT_SECRET`. **The raw IP never leaves the API.** A plain SHA-256 of an IPv4 address can be reversed by hashing all ~4 billion addresses; a keyed HMAC can't be without the secret |
| `userAgent`, `referrer` | Truncated to 512 and 2048 chars. The worker derives `browser` and the referrer **host** only |

It's stored in the stream as one field, `event`, containing the JSON. Redis assigns each entry an
ID like `1727700000000-0` (milliseconds-sequence), always increasing.

### Producer: fire-and-forget

```js
res.redirect(302, url.originalUrl);        // 1. the user gets their response
void publishClickEvent(buildClickEvent()); // 2. then XADD, NOT awaited
```

- The redirect never waits for Redis, and a Redis error can never turn into a failed redirect
  (`publishClickEvent` never throws).
- **Redis not ready → drop** the event immediately (the same fail-fast client as the cache).
- **Backpressure:** at most 1000 writes in flight; beyond that, new events are dropped, so memory
  can't grow without bound.
- **`MAXLEN ~ 100000`** caps the stream. If the worker is down for a long time, the oldest unread
  entries are trimmed instead of filling Redis's memory. `~` lets Redis trim in whole internal
  blocks (cheap) rather than to exactly N.
- **Guarantee: at-most-once.** Events during a Redis outage are lost, by design: analytics are
  best-effort and redirects are not. The *transactional outbox* pattern is the upgrade if events
  must never be lost.

### Redis configured for a queue, not just a cache

Holding a queue in Redis changes two settings that were fine for a pure cache:

| Setting | Before (cache only) | Now | Why |
| ------- | ------------------- | --- | --- |
| Eviction | `allkeys-lru` | **`volatile-lru`** | With `allkeys-lru`, a full Redis could evict **the stream itself**, silently losing the whole queue. `volatile-lru` only evicts keys that have a TTL. Cache entries and rate-limit counters all do; the stream doesn't, so it's never evicted |
| Persistence | off | **AOF, `appendfsync everysec`** + a data volume | Queued clicks survive a Redis restart. Verified: 3 clicks queued while the worker was stopped were still there after `docker compose restart redis`, and all were counted when the worker returned. At most ~1 s of writes can be lost in a crash |

If memory fills up with only the stream left, `XADD` fails and the producer drops events. That's
bounded by `MAXLEN`, and processed entries are deleted, so in normal operation the stream is
nearly empty.

### Consumer: the worker loop

```text
on start: XGROUP CREATE url-clicks analytics-worker 0 MKSTREAM   (idempotent)

loop:
  every 30 s:  XAUTOCLAIM … min-idle 60 s     take over entries stuck on a DEAD consumer
  1. XREADGROUP … STREAMS url-clicks 0        my own pending entries first
                                              (a failed batch, a crash before XACK, or just claimed)
  2. if none: XREADGROUP … BLOCK 2000 … >     new entries, waiting up to 2 s for one to arrive
  3. delivered more than 5 times?  →  copy to url-clicks:dead-letter, XACK (stop retrying)
  4. parse + validate (zod). Malformed → log, and acknowledge with the rest
  5. storeClickEvents(batch)                  ONE transaction (unchanged from the Kafka version)
  6. MULTI  XACK + XDEL  EXEC                 only after the DB commit
  on error: log, back off (1 s, 2 s, 4 s … max 30 s); the entries stay pending and are retried
```

- **A separate Redis connection.** `XREADGROUP … BLOCK` holds its connection until data arrives,
  so the worker uses its own client (`createBlockingRedisClient`). That client has no command
  timeout, and commands wait for a reconnect rather than failing. The API's client has a 500 ms
  fail-fast timeout that would abort every blocking read.
- **Consumer name** = hostname + PID (in Docker the hostname is the container ID), so every worker
  instance is a distinct consumer.
- **Start ID `0`:** a newly created group processes everything already in the stream (like Kafka's
  `fromBeginning`). After that the group remembers what it has delivered.
- **`XDEL` after `XACK`:** with one consumer group, a processed entry is never needed again.
  Deleting it keeps the stream (and Redis memory) tiny in normal operation, so `MAXLEN` only
  matters while the worker is down.

**Delivery semantics.** An entry is delivered, processed, and only then acknowledged:

| Order | If the worker crashes between the two steps | Guarantee |
| ----- | ------------------------------------------- | --------- |
| Acknowledge, then process | Entry never processed | at-most-once (loses data) |
| **Process, then acknowledge** (used) | Entry processed again later | **at-least-once** (duplicates possible) |

At-least-once plus **idempotent processing** gives exactly-once *effects*:

- `click_events.event_id` is `UNIQUE`, so a redelivered event hits `ON CONFLICT DO NOTHING`.
- The daily rollup is incremented only from the rows that insert **returned** (the new ones).
- Raw insert and rollup are in **one transaction**, so they can't disagree.

**Failure handling, all tested** (`tests/integration/clickStream.e2e.test.js`):

| Situation | What happens | Test |
| --------- | ------------ | ---- |
| Worker down | Entries wait in the stream. Redirects are unaffected | 3 clicks buffered, then processed when the worker starts |
| Same event delivered twice | Second insert skipped | Counted once |
| Malformed entry (poison message) | Logged, acknowledged, skipped. Entries behind it aren't blocked | Bad JSON entry, then a real click: counted, nothing left pending |
| Worker crashes after reading, before `XACK` | Entry stays pending on the dead consumer; another worker claims it with `XAUTOCLAIM` after it has been idle 60 s | A fake "crashed-worker" holds an entry; a new worker claims and processes it |
| Batch keeps failing (e.g. one event breaks the transaction) | Retried with backoff; after 5 deliveries moved to `url-clicks:dead-letter` and acknowledged, so the queue isn't blocked forever | A `store` that always throws: entry ends in the dead-letter stream, nothing pending |
| PostgreSQL down | Batches fail, entries stay pending, retried with backoff until it returns | (backoff path of the same loop) |
| Redis down | The worker's commands wait for the reconnect; the producer drops events | |

**A poison message found while porting:** the event schema accepted any positive `urlId`, but the
column is a 32-bit `INTEGER`. An event with `urlId: 9999999999` would have made **every** batch
containing it fail, forever. The schema now caps `urlId` at 2,147,483,647, and the dead-letter
stream is the safety net for anything validation still misses.

**Concurrency without partitions.** Kafka sent all clicks for one link to the same partition, and
therefore the same worker. A Redis consumer group hands entries to any consumer, so two workers
*can* update the same link's daily counter at the same time. That's still safe:
`INSERT … ON CONFLICT DO UPDATE SET clicks = clicks + n` takes a row lock, so concurrent
increments serialize instead of overwriting each other, and upserts run in a fixed
`(url_id, day)` order so two transactions can't deadlock.

### Worker lifecycle

| Situation | Behaviour |
| --------- | --------- |
| Startup | Health endpoint up, then wait for PostgreSQL (retry), then create the group if missing (waits for Redis), then consume |
| SIGTERM | Stop the loop. The current blocking read returns within 2 s and the batch in progress finishes and is acknowledged. Close Redis and the DB pool. Anything unacknowledged stays pending for next time |
| Process dies | Docker's restart policy starts a new one. Its pending entries are claimed by whichever worker runs `XAUTOCLAIM` |

## Redirect and caching (Redis)

### Redirect flow: `GET /:shortCode`

```text
GET /aB92x
  │
  ├─ matches ^[A-Za-z0-9_-]{1,32}$ ? ── no ──────────────────────────────────► 404 (no Redis/DB work)
  │
  ├─ Redis GET url:aB92x
  │     ├─ HIT  {id, originalUrl, isActive, expiresAt} ───────────────┐
  │     ├─ HIT  {missing: true}  (negative cache) ────────────────────┤
  │     ├─ MISS ─► PostgreSQL SELECT … WHERE short_code = 'aB92x'     │
  │     │            └─► Redis SET url:aB92x <json> EX <ttl> ─────────┤
  │     └─ BYPASS (Redis down) ─► PostgreSQL, don't cache ────────────┤
  │                                                                   ▼
  ├─ not found ──────────────────────────────────────────────────────────────► 404
  ├─ isActive = false ───────────────────────────────────────────────────────► 410 Gone
  ├─ expiresAt ≤ now ────────────────────────────────────────────────────────► 410 Gone
  └─ 302 Found, Location: <originalUrl>, X-Cache: HIT|MISS|BYPASS, Cache-Control: private, no-store
```

### Cache-aside (lazy loading)

The **application** owns the cache logic. Redis never talks to PostgreSQL:

1. **Read:** try Redis. On a miss, read PostgreSQL, then write the result into Redis.
2. **Write** (create/update/delete): write PostgreSQL, then **delete** the Redis key. The next
   read repopulates it.

Why this pattern:

- Only links that are actually clicked use memory. A link created and never visited is never
  cached.
- If Redis loses everything (restart, eviction, outage), the only effect is extra misses.
  **PostgreSQL stays the source of truth.**
- Alternatives: *write-through* (update the cache on every write) fills memory with never-read
  links and needs two writes to stay consistent. *Read-through* needs a cache that can load from
  the DB itself, which Redis can't.

**Why delete on write instead of overwriting the cached value?** One code path fills the cache
(the redirect), so there's a single place that decides what a cache entry looks like. Deleting
is also idempotent and safe to retry.

### What is cached

| Key | Value | TTL |
| --- | ----- | --- |
| `url:<shortCode>` | `{"id":4,"originalUrl":"https://…","isActive":true,"expiresAt":null}` | `URL_CACHE_TTL` (1 h) |
| `url:<shortCode>` | `{"missing":true}`: code doesn't exist | `URL_NEGATIVE_CACHE_TTL` (60 s) |

- **The decision fields, not just the URL.** `expiresAt` is re-checked on every hit, so a cached
  link stops working at the exact second it expires, whatever the cache TTL. (A test fakes the
  clock to prove this.) `id` is carried along for the Phase 6 click events.
- **TTL (time to live):** Redis deletes the key automatically after N seconds. The TTL is the
  safety net for every consistency problem below: whatever goes wrong, a stale entry lives at
  most one TTL. Shorter TTL means fresher data but more DB reads; 1 hour suits links, which
  rarely change.
- **Negative caching** protects PostgreSQL from repeated lookups of codes that don't exist (bots
  scanning `/aaaa`, `/aaab` …; this is called *cache penetration*). It uses a short TTL, and
  creating a link deletes the key, so a newly created alias works immediately. There's a test
  for that too.
- **Memory:** Redis runs with `maxmemory 128mb` and `allkeys-lru`. When full it evicts the
  least-recently-used keys instead of rejecting writes, which is exactly right for a cache.
  Persistence is off: there's nothing worth saving.

### Consistency: the known race

Cache-aside with delete-on-write has one classic race:

```text
Reader                                 Writer
GET url:x → MISS
SELECT … → old row
                                       UPDATE row
                                       DEL url:x
SET url:x = old row   ← stale entry written AFTER the delete
```

The stale entry survives until its TTL. It needs a miss and an update to interleave within
milliseconds, and the damage is bounded by the TTL, so it's accepted here. Stricter fixes exist
(delayed double-delete, versioned values) but aren't worth the complexity for link edits. One
more case: deleting a user cascades to their URLs in the database without touching Redis. There
is no delete-account endpoint yet; if one is added, it must invalidate each of that user's codes.

### Failure handling: Redis is optional

| Situation | Behaviour |
| --------- | --------- |
| Redis down at startup | API starts anyway (`connectRedis()` never throws). ioredis reconnects in the background |
| Redis goes down while running | `status !== 'ready'`, so every cache call returns `BYPASS` immediately and reads go to PostgreSQL. `enableOfflineQueue: false` means commands fail instantly instead of queueing |
| Redis slow / hanging | `commandTimeout: 500` ms, then treated as a miss |
| Redis comes back | ioredis reconnects (backoff up to 5 s). The cache refills on demand |
| `/ready` | `200 {"status":"degraded"}`, **not** 503. Taking every instance out of the load balancer because the *cache* is down would turn "slower" into "down" |
| Logs | One warning when Redis becomes unavailable, then at most one every 30 s |

Measured on this machine (single `curl`, not a benchmark): a redirect with Redis stopped took
about 13 ms. Real throughput and latency numbers come from the Phase 11 k6 load tests.

### Why 302 and not 301

| | 301 Moved Permanently | 302 Found (used) |
| - | - | - |
| Browser behaviour | Caches the redirect, possibly forever, and goes straight to the destination next time | Asks our server every time |
| Deactivate / edit a link | Doesn't reach users who already visited | Takes effect immediately |
| Analytics (Phase 6) | Repeat clicks never reach us | Every click is counted |
| Load on our server | Lower | Higher, which is why the cache matters |

`Cache-Control: private, no-store` keeps proxies and browsers from caching the redirect.

## Rate limiting

### Algorithm: fixed window counter

```text
window = floor(now / windowLength)            e.g. 15-minute blocks
key    = rl:<limiter>:<client>:<window>       e.g. rl:login:ip:203.0.113.7:1932117

MULTI
  INCR   key          → 1, 2, 3 …
  EXPIRE key <window>   so old counters delete themselves
EXEC

count > max ?  → 429 Too Many Requests + Retry-After: <seconds until window ends>
```

- **INCR is atomic.** Two simultaneous requests can never both read 9 and both write 10. A test
  fires 60 concurrent URL creations against a limit of 50 and gets exactly 50 × 201 and 10 × 429.
- **MULTI/EXEC** runs INCR and EXPIRE as a unit, so a counter is never left without an expiry.
- **Redis, not process memory:** with two API instances, per-process counters would allow
  2 × max. Redis is shared by every instance.
- **Headers:** `RateLimit-Limit`, `RateLimit-Remaining`, `RateLimit-Reset`, and `Retry-After` on
  429.

### Limits

| Endpoint | Counted per | Default | Why |
| -------- | ----------- | ------- | --- |
| `POST /auth/login` | client **IP** | 10 / 15 min | One machine trying many accounts (credential stuffing) |
| `POST /auth/login` | **email** (SHA-256 hashed in the key) | 10 / 15 min | Many machines guessing one account's password |
| `POST /urls` | **user ID** | 30 / min | Spam and abuse of link creation |

All values are configurable via `RATE_LIMIT_*` env vars. Once limited, even the **correct**
password gets 429, so an attacker can't use the limiter to confirm a guess.

### Trade-offs of the algorithm

| Algorithm | How | Pros | Cons |
| --------- | --- | ---- | ---- |
| **Fixed window** (used) | One counter per time block | Simplest; 1 key and 2 commands per request; easy to explain | **Boundary burst:** max requests at 11:59:59 plus max at 12:00:00 is 2× max in two seconds |
| Sliding window log | Sorted set of every request's timestamp | Exact | Memory grows with request count |
| Sliding window counter | Weighted mix of current and previous window | Smooths the boundary, still cheap | Approximate; a bit more logic |
| Token bucket | Tokens refill at a steady rate, each request spends one | Allows short bursts but enforces an average rate | Needs a Lua script for atomic refill-and-take |

For login protection the boundary burst is acceptable: 20 guesses instead of 10 around one
boundary doesn't change the security picture. If URL creation ever needed smooth limits, a
token bucket in a small Lua script would be the next step.

### Failure mode: fail open

If Redis is down, the limiter **allows** the request (and logs a warning). The alternative, fail
closed, would lock every user out of login during a cache outage. The trade-off is weaker
brute-force protection during the outage. An in-memory per-instance fallback limiter would be
a reasonable middle ground later.

### Client IP behind a proxy

Behind Nginx, every request arrives from Nginx's IP, so all users would share one rate-limit
counter. `TRUST_PROXY=1` tells Express to take `req.ip` from the last hop in `X-Forwarded-For`.
It must equal the real number of proxies: trusting the header without a proxy lets any client
forge its IP and dodge the limit.

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
