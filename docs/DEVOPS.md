# DevOps

How the system is built, run, deployed and operated. This document grows with each phase:
Docker, Compose and Nginx (Phase 7) and CI/CD (Phase 8) are covered; AWS (Phase 9) and
monitoring (Phase 10) are added as they're built.

- [1. Container architecture](#1-container-architecture)
- [2. Docker images](#2-docker-images)
- [3. Docker Compose (development)](#3-docker-compose-development)
- [4. Networking](#4-networking)
- [5. Nginx](#5-nginx)
- [6. Health checks and startup order](#6-health-checks-and-startup-order)
- [7. Graceful shutdown and restarts](#7-graceful-shutdown-and-restarts)
- [8. Production Compose](#8-production-compose)
- [9. Environment variables and secrets](#9-environment-variables-and-secrets)
- [10. Logging](#10-logging)
- [11. Bugs found by containerizing](#11-bugs-found-by-containerizing)
- [12. Troubleshooting](#12-troubleshooting)
- [13. CI pipeline](#13-ci-pipeline)
- [14. CD pipeline](#14-cd-pipeline)
- [15. Docker image workflow](#15-docker-image-workflow)
- [16. Deploying and rolling back](#16-deploying-and-rolling-back)
- [17. GitHub setup](#17-github-setup)

## 1. Container architecture

```text
 host :8080 (dev) / :80 (prod)
        │
┌───────▼─────── frontend network ─────────────────┐
│   nginx ──────────► api (replica 1)              │
│         └─────────► api (replica 2)              │
└──────────────────────────┬───────────────────────┘
┌──────────────────────────▼──── backend network ──────────────────────────┐
│   api ──► postgres:5432     api ──► redis:6379 (cache, limits, XADD)     │
│   worker ──► redis:6379 (XREADGROUP)    worker ──► postgres:5432         │
│   migrate ──► postgres:5432   (runs once, exits 0)                       │
└──────────────────────────────────────────────────────────────────────────┘
```

| Container | Image | Role | Host port (dev) |
| --------- | ----- | ---- | --------------- |
| nginx | `nginx:1.28-alpine` | Reverse proxy, load balancer, only entry point | **8080** |
| api ×2 | `url-shortener-api` (ours) | Express API | none |
| worker | `url-shortener-worker` (ours) | Redis Stream consumer → PostgreSQL | none |
| migrate | `url-shortener-migrate` (ours) | `prisma migrate deploy`, then exits | none |
| postgres | `postgres:17-alpine` | Database | 127.0.0.1:5433 (dev tools only) |
| redis | `redis:7.4-alpine` | Cache, rate limits, click-event stream (AOF-persisted) | 127.0.0.1:6380 (dev tools only) |

**Why containers?** The same image runs on a laptop, in CI and on EC2, with the same Node version,
OS libraries and native modules (argon2), so "works on my machine" problems go away. Starting the
whole system is one command. Each process is isolated (filesystem, network, users) and can be
limited (memory, CPU).

**Image vs container:** an *image* is an immutable template: files plus metadata, built once and
versioned by tag. A *container* is a running instance of an image, with its own writable layer,
network identity and process. Two `api` containers run from the same image.

## 2. Docker images

`docker/api.Dockerfile` and `docker/worker.Dockerfile` use **multi-stage builds**:

```text
deps        node:24-alpine + openssl + ALL dependencies (npm ci) + prisma generate
  │
  ├──► migrate    deps + Prisma CLI → CMD prisma migrate deploy        (1.1 GB, runs once)
  │
prod-deps   fresh `npm ci --omit=dev --omit=optional` + generated client from deps
  │
runtime     clean node:24-alpine + prod node_modules + src/        ← the image that runs (382 MB)
```

Each `FROM` starts a new stage, and only the last stage (or a chosen `--target`) becomes the
image. Compilers, dev dependencies, the Prisma CLI and build caches stay in the discarded stages.

| Practice | Where | Why |
| -------- | ----- | --- |
| Multi-stage build | both Dockerfiles | Small runtime image without build tools |
| Dependencies copied before source | `COPY package*.json` then `npm ci` then `COPY src` | Docker caches layers: code changes don't re-run `npm ci` |
| `npm ci` (not `npm install`) | deps stage | Exactly the lockfile's versions: reproducible builds |
| Non-root user | `USER node` (uid 1000) | A compromised process doesn't have root inside the container |
| Code owned by root, read-only to the app | `COPY` without `--chown` | The app can't modify its own code (verified: `touch /app/src/x` → Permission denied) |
| Exec-form `CMD ["node", …]` | runtime | Node is the main process and receives SIGTERM directly. `npm start` doesn't reliably forward signals |
| `HEALTHCHECK` | both | Docker knows when the process is actually serving, not just running |
| `.dockerignore` | repo root | `.env`, `.git`, `node_modules`, tests and docs never enter the build context, so secrets can't leak into an image |
| Pinned base image major version | `node:24-alpine`, `postgres:17-alpine`… | Predictable upgrades |

**Image size: 712 MB → 382 MB, measured.** The first build pruned dev dependencies with
`npm prune --omit=dev`, but the image still contained the Prisma CLI and Prisma Studio (about
250 MB of packages). In `package-lock.json` they're marked **`devOptional`**: a devDependency of
ours *and* an optional peer of `@prisma/client`. npm only leaves those out when **both** `dev`
and `optional` are omitted. The fix is a fresh `npm ci --omit=dev --omit=optional` in its own
stage, copying in just the generated Prisma client. `node_modules` went from 349 MB to 106 MB,
and the rest of the image is the Node base image (about 237 MB).

```bash
docker build -f docker/api.Dockerfile -t url-shortener-api .
docker build -f docker/api.Dockerfile --target migrate -t url-shortener-migrate .
docker build -f docker/worker.Dockerfile -t url-shortener-worker .
```

## 3. Docker Compose (development)

```bash
docker compose up -d --build --wait     # build, start, wait until every health check passes
docker compose ps                       # status and health
docker compose logs -f api worker       # follow logs (both API replicas interleaved)
docker compose up -d --build api        # rebuild + restart just the API after a code change
docker compose up -d --scale api=3      # three API instances (nginx picks them up automatically)
docker compose restart worker           # restart one service
docker compose down                     # stop + remove containers; volumes (data) are kept
docker compose down -v                  # ...and delete the data volumes too
```

Open **http://localhost:8080**. From a cold start (images built), the whole stack is healthy in
about 30 s.

Two development workflows:

1. **Everything in Docker** (above): closest to production. Code changes need
   `docker compose up -d --build api`.
2. **Infrastructure in Docker, app on the host** for fast edit-reload:
   `docker compose up -d --wait postgres redis`, then `npm run dev` and `npm run worker:dev`.
   The host-mapped ports (5433, 6380) exist for this, and for the integration tests.

**Volumes:** `postgres-data` and `redis-data` are *named volumes*. Data lives outside the
container, so recreating containers (new image, changed config) keeps it. Redis needs one because
it holds the click-event queue: its append-only file (AOF) lives there.

**YAML anchors** (`x-logging: &default-logging`, `<<: *app-env`) avoid repeating the same
settings in every service.

## 4. Networking

Compose creates two user-defined bridge networks:

| Network | Members | Purpose |
| ------- | ------- | ------- |
| `frontend` | nginx, api | Only what faces clients |
| `backend` | api, worker, migrate, postgres, redis | Data stores. Nginx is not on it |

- **Service discovery by name.** Docker runs an embedded DNS server (127.0.0.11) on every
  user-defined network. `postgres`, `redis` and `api` resolve to the containers' current
  IPs. Scaling `api` to 2 replicas makes `api` resolve to 2 IPs.
- **Why never hardcode container IPs:** they're assigned when a container is created and change
  whenever it's recreated (new image, restart after a crash, scaling). A name is stable.
- **Container port vs host port:** inside the network, Postgres is `postgres:5432`. `5433` exists
  only as a host mapping for tools on your Mac. The app's container config always uses
  `postgres:5432`.
- **Segmentation (verified):** nginx can't even *resolve* `postgres` (`nc: bad address
  'postgres'`), and the API isn't reachable from the host (`localhost:3000` gives no connection).
  All traffic goes through nginx.
- **Trade-off:** the backend network is flat, so every backend container can reach every other
  one. Finer segmentation (a network per dependency) is possible but adds complexity
  without much gain on a single host.

## 5. Nginx

Config: [`nginx/nginx.conf`](../nginx/nginx.conf), mounted read-only into the container.

| Feature | Config | Why |
| ------- | ------ | --- |
| Reverse proxy | `proxy_pass http://api` | One public entry point. The API containers stay private |
| Load balancing | `upstream api { server api:3000 resolve; }` | Round-robin across replicas. Measured: 3 replicas got exactly 10/10/10 of 30 requests |
| Dynamic DNS | `resolver 127.0.0.11 valid=10s` + `resolve` | New or restarted API containers are picked up without reloading nginx. Without `resolve`, nginx resolves `api` once at startup and keeps using stale IPs |
| Keep-alive to Node | `keepalive 32`, HTTP/1.1, `Connection ""` | Reuses TCP connections instead of a new handshake per request |
| Forwarding headers | `X-Forwarded-For`, `X-Real-IP`, `X-Forwarded-Proto`, `Host` | The API sees the real client, not nginx |
| Request ID | `X-Request-Id $request_id` | The same ID in nginx's and the API's logs (verified) |
| Request limits | `client_max_body_size 16k`, header/body/send timeouts 10 s | Rejects huge bodies and slow-loris clients before they reach Node |
| Coarse rate limit | 20 req/s per IP, burst 40, max 20 connections per IP → 429 | Outer shield. Fine-grained per-endpoint limits are in the API (Redis) |
| Failover | `proxy_next_upstream error timeout http_502 http_503` | If an instance is down or restarting, try another. Nginx never retries POST/PATCH, so a URL can't be created twice |
| Structured access log | `log_format json` → stdout | Same JSON style as the app logs |
| No version banner | `server_tokens off` | Don't advertise the nginx version |

### Real client IP: nginx + `TRUST_PROXY`

```text
client 203.0.113.7 ──► nginx: X-Forwarded-For: <anything the client sent>, 203.0.113.7
                                                              └── appended by nginx ($remote_addr)
                   ──► Express with TRUST_PROXY=1: req.ip = the LAST entry = 203.0.113.7
```

Express trusts exactly one hop, the one nginx appended, so a client-supplied `X-Forwarded-For`
can't spoof the IP. Verified: the login rate limiter keyed on the client's IP rather than nginx's
container IP, and a request with `X-Forwarded-For: 1.2.3.4` was still limited.

> **Load testing note (Phase 11):** the nginx limit of 20 req/s per IP will throttle a k6 test run
> from a single machine. That's intended in production, so load tests need to account for it.

## 6. Health checks and startup order

| Service | Health check | Meaning |
| ------- | ------------ | ------- |
| postgres | `pg_isready` | Accepting connections |
| redis | `redis-cli ping` | Answers commands |
| api | `wget /health` (Dockerfile `HEALTHCHECK`) | Node process serving HTTP (liveness, not dependencies) |
| worker | `wget :9101/health` | Worker process alive |
| nginx | `wget /nginx-health` | Nginx serving |

`depends_on` with **conditions** gives a correct startup order instead of "start everything at once
and hope":

```text
postgres (healthy) ──► migrate (completed successfully) ──► api (healthy) ──► nginx
                                                        └──► worker
redis (healthy) ─────────────────────────────────────────────┘ (worker only)
```

- `service_healthy` waits for the health check, not just the process start. A Postgres container
  is "running" several seconds before it accepts connections.
- `service_completed_successfully` means the API and worker never run against an unmigrated
  schema. If a migration fails, they don't start at all.
- The API only needs Redis **started** (it degrades without it). The worker needs Redis
  **healthy**, because the stream is its whole job.
- Defense in depth: the API *also* retries its DB connection at startup (Phase 2), so
  orchestrators without `depends_on` (ECS, Kubernetes) behave correctly too.

Migrations run as a **separate one-shot container**, not inside the API's startup. With two
replicas, both would otherwise try to migrate at the same moment.

## 7. Graceful shutdown and restarts

```text
docker stop / compose down / new deploy
   │ SIGTERM ──► tini (init: true, PID 1) ──► node
   │              node: /ready → 503, server.close(), wait for in-flight requests,
   │                    close Postgres and Redis, exit 0
   │ ... up to stop_grace_period (15 s) ...
   └ SIGKILL if still running
```

- **`init: true`** runs a tiny init process (tini) as PID 1. It forwards signals to Node and reaps
  zombie processes. PID 1 in Linux has special signal semantics that Node isn't designed for.
- **`SHUTDOWN_TIMEOUT_MS=10000` < `stop_grace_period: 15s`**: the app's own force-exit fires
  before Docker's SIGKILL, so shutdown is always logged.
- **Measured:** stopping one API replica while 40 requests were in flight gave 40/40 successful
  responses (nginx routed to the other replica). The stopped instance shut down in 15 ms and exited
  with code 0.
- **Restart policy `unless-stopped`:** crashed containers restart automatically. Manually stopped
  ones stay stopped. Measured: killing the worker's node process gave restart count 0 → 1, and it
  was consuming again within seconds. This is the supervisor that the worker's "let it crash"
  design (Phase 6) relies on.

## 8. Production Compose

[`docker-compose.prod.yml`](../docker-compose.prod.yml) is a standalone file for a single server
(EC2, Phase 9). It was verified locally: full stack healthy in 29 s, register/create/redirect/
analytics working on port 80.

| Aspect | Development | Production |
| ------ | ----------- | ---------- |
| Images | `build:` locally | `image: ${IMAGE_PREFIX}-api:${IMAGE_TAG}`, **pulled** from the registry. The server never builds |
| Secrets | local defaults | `${VAR:?}`: compose **refuses to start** if `JWT_SECRET`, `POSTGRES_PASSWORD`, `APP_BASE_URL` or `IMAGE_PREFIX` is missing |
| Data store ports | 127.0.0.1-mapped for tools | **None** published. Only nginx `:80` (and `:443` later) |
| Backend network | normal | `internal: true`: no internet egress (verified: worker → example.com is blocked) |
| Resource limits | none | per-container memory/CPU limits sized for a **1 GB t3.micro** (below) |
| Postgres / Redis tuning | defaults | `shared_buffers=64MB`, `max_connections=50`; Redis `maxmemory 64mb` |
| Logs | rotate 3 × 10 MB | rotate 5 × 10 MB |
| API cookies | `COOKIE_SECURE=false` | `true` by default (set false until HTTPS exists) |

**Memory limits and measured idle usage** (local run of the production stack):

| Container | Limit | Idle usage |
| --------- | ----- | ---------- |
| postgres | 256 MB | 65 MiB |
| api × 2 | 192 MB each | 60 MiB each |
| worker | 160 MB | 57 MiB |
| redis | 128 MB | 10 MiB |
| nginx | 32 MB | 9 MiB |
| **Total** | **~960 MB** | **~260 MiB** |

With the OS (~150–250 MB) and the Docker daemon (~60 MB), a t3.micro sits around 500 MB of its
1 GB at idle, plus swap as a safety net. The first version of this stack ran Apache Kafka, whose
JVM alone used 436 MiB (the total was ~695 MiB), which wouldn't fit. That's why click events now
go through a Redis Stream (see [LLD.md](LLD.md)). Idle numbers aren't load numbers; usage under
load gets measured in Phase 11.

```bash
# on the server, next to a .env created from .env.production.example (chmod 600)
docker compose -f docker-compose.prod.yml pull
docker compose -f docker-compose.prod.yml up -d --wait
```

## 9. Environment variables and secrets

All configuration comes from environment variables, validated at startup
([`src/config/env.js`](../src/config/env.js)). Invalid or missing values stop the process with a
clear message.

| Variable | Default | Used by | Notes |
| -------- | ------- | ------- | ----- |
| `NODE_ENV` | development | all | `production` in containers |
| `SERVICE_NAME` | url-shortener-api | all | Appears in every log line |
| `PORT` | 3000 | api | |
| `APP_BASE_URL` | http://localhost:3000 | api | Used to build `shortUrl` |
| `LOG_LEVEL` | info | all | |
| `SHUTDOWN_TIMEOUT_MS` | 10000 | api, worker | Must be below the orchestrator's grace period |
| `DATABASE_URL` | **required** | api, worker, migrate | **Secret** (contains the password) |
| `DB_POOL_MAX` | 10 | api, worker | |
| `JWT_SECRET` | **required by the API** | api | **Secret.** ≥ 32 chars. The worker doesn't get it |
| `JWT_EXPIRES_IN` | 1d | api | `3600`, `30s`, `15m`, `12h`, `7d` |
| `COOKIE_SECURE` | true in production | api | Needs HTTPS |
| `REDIS_URL` | redis://localhost:6380/0 | api, worker | |
| `URL_CACHE_TTL` / `URL_NEGATIVE_CACHE_TTL` | 1h / 60s | api | |
| `RATE_LIMIT_*` | 10 per 15m (login), 30 per 1m (create) | api | |
| `TRUST_PROXY` | 0 | api | 1 behind nginx |
| `CLICKS_STREAM`, `CLICKS_CONSUMER_GROUP` | url-clicks, analytics-worker | api, worker | The Redis Stream and consumer group |
| `CLICKS_STREAM_MAXLEN` | 100000 | api | Approximate cap while the worker is behind |
| `WORKER_HEALTH_PORT` | 9101 | worker | |

**Secrets:**

- Never committed. `.env`, `.env.*` and key files are git-ignored. Only the templates
  (`.env.example`, `.env.production.example`) are tracked.
- Never baked into images. `.dockerignore` excludes `.env`, and the Dockerfiles contain no secrets.
  The build-time `DATABASE_URL` is a placeholder only.
- Never logged. pino redacts cookies, authorization headers and password fields.
- **Least privilege:** each container receives only what it needs. The worker has no JWT secret.
- In production (Phase 9): a `.env` file on the server with `chmod 600`, or AWS SSM Parameter
  Store. In CI/CD (Phase 8): GitHub Actions secrets.

## 10. Logging

- **Structured JSON to stdout/stderr** from every container: the app (pino) and nginx (JSON
  `log_format`). Containers shouldn't write log files; Docker captures stdout.
- **Rotation:** the `json-file` driver with `max-size`/`max-file`, so logs can't fill the disk
  (a classic cause of server outages).
- **Correlation:** nginx generates `$request_id` and passes it as `X-Request-Id`. The API logs it
  as `req.id` and returns it to the client:

  ```text
  nginx: {"request_id":"481179c3…","status":401,"upstream":"172.20.0.3:3000",…}
  api:   {"req":{"id":"481179c3…","method":"GET","url":"/api/v1/auth/me"},…}
  ```

- `service` distinguishes sources (`url-shortener-api`, `analytics-worker`, `nginx`).
  `docker compose logs -f api` interleaves both replicas.

## 11. Bugs found by containerizing

Running the real images with production-like configuration found three problems that the local
setup and the test suite had hidden:

1. **Every duration default was broken.** In Zod 4, `.default()` returns its value as-is,
   without running the transform, so an unset `JWT_EXPIRES_IN` became the string `'1d'`, and
   register failed with `option maxAge is invalid` (500). Locally `.env` set every value
   explicitly, so the defaults never ran. Fix: `.prefault()`, which parses the default like a
   real value. Regression test: `tests/unit/env.test.js`.
2. **A bare number of seconds (`JWT_EXPIRES_IN=3600`) parsed as `NaN`.** The regex's optional
   unit group matches `''`, not `undefined`, so a destructuring default never applied. Found by
   the new config test.
3. **The image was twice as big as it needed to be** (712 → 382 MB); see section 2.

## 12. Troubleshooting

| Symptom | Check |
| ------- | ----- |
| A container keeps restarting | `docker compose logs <service>`, `docker inspect -f '{{.RestartCount}}' <container>` |
| `api` stuck "starting" | `docker compose logs migrate` (a failed migration blocks the API), `docker compose ps` |
| 502 from nginx | No healthy API instance: `docker compose ps api`, `docker compose logs api` |
| `JWT_SECRET must be set` on `up` | Create `.env` from `.env.example` |
| Port already allocated | Something on the host uses 8080/5433/6380: change `NGINX_PORT`, `POSTGRES_PORT` or `REDIS_PORT` in `.env` |
| Inside a container | `docker compose exec api sh` (Alpine: `wget`, `nc` available) |

## 13. CI pipeline

[`.github/workflows/ci.yml`](../.github/workflows/ci.yml) runs on **every pull request and every
push to `main`**. Three jobs run in parallel, and all three must pass:

| Job | Steps | Time budget |
| --- | ----- | ----------- |
| **Lint, audit & unit tests** | `npm ci`, ESLint, `npm audit` (production deps, fails on high/critical), unit tests | 10 min |
| **Integration tests** | Real **PostgreSQL and Redis** as service containers; `prisma migrate deploy`; integration tests; **schema drift check** | 15 min |
| **Docker build & smoke test** | Build the api/worker/migrate images exactly as production; start the full Compose stack; run `scripts/smoke-test.sh` through Nginx | 20 min |

Details worth knowing:

- **`npm ci`, not `npm install`**, installs exactly the lockfile and fails if `package.json` and
  `package-lock.json` disagree.
- **Service containers** use the same host ports as local development (5433, 6380), so the
  test configuration is identical on a laptop and in CI.
- **Schema drift check:** after the migrations run, `prisma migrate diff --exit-code` compares the
  database with `schema.prisma`. Tested locally: exit 0 when in sync, **exit 2** when a column was
  added to the schema without a migration, which fails CI before the missing migration can reach
  production.
- **Why a Docker smoke test in CI:** unit and integration tests run the *code*; the smoke test runs
  the *images*: config defaults, native modules, networking, migrations, Redis Stream → worker. The
  Phase 7 Zod-default bug passed 274 tests and would only have been caught here.
- **Audit gate:** `npm audit --omit=dev --omit=optional --audit-level=high` checks what actually
  ships in the image (0 vulnerabilities at the time of writing). Advisories in dev-only tooling
  (the Prisma CLI) don't block merges; Dependabot surfaces them instead.
- **Concurrency:** a new push to a PR cancels the outdated run. Runs on `main` are never cancelled.
- **Least privilege:** `permissions: contents: read`, and no secrets, so it's safe for PRs from forks.
- **Caching:** npm cache via `setup-node`; Docker layers via the GitHub Actions cache (`type=gha`),
  shared with CD.

Run the same checks locally:

```bash
npm ci && npm run lint && npm audit --omit=dev --omit=optional --audit-level=high
npm run test:unit
docker compose up -d --wait postgres redis && npm run test:integration
docker compose up -d --build --wait && scripts/smoke-test.sh http://localhost:8080
```

## 14. CD pipeline

[`.github/workflows/cd.yml`](../.github/workflows/cd.yml):

```text
push to main ──► CI ──✗──► stop: nothing is published or deployed
                    │ ✓  (workflow_run: completed, success, event = push)
                    ▼
publish ── build the images from the exact commit CI tested (head_sha)
        └─ push to ghcr.io/<owner>/url-shortener-{api,worker,migrate}:<git-sha> and :latest
                    │
                    ▼
deploy  ── (only if repository variable DEPLOY_ENABLED = true)
        ├─ GitHub environment "production": secrets, deployment history, optional approval
        ├─ SSH (pinned host key) → copy docker-compose.prod.yml, nginx.conf, deploy.sh
        ├─ docker login ghcr.io on the server with this run's short-lived token
        ├─ deploy.sh <sha>: pull → migrate → recreate → health check → auto-rollback
        ├─ docker logout
        └─ read-only smoke test against the public URL
```

| Decision | Why |
| -------- | --- |
| Triggered by **CI's completion** (`workflow_run`), not a second `push` trigger | Tests run once. CD can't start unless CI passed. The commit is pinned to exactly the one CI tested |
| Images tagged with the **git SHA** (plus `latest`) | An immutable, traceable version: "what's running?" has an exact answer, and rollback means redeploying an older SHA |
| **Build once, deploy the same artifact** | The server pulls the image CI/CD built; it never builds. What was tested is what runs |
| GitHub Container Registry | Free for public repos, authenticated with the built-in `GITHUB_TOKEN`: no extra credentials |
| `concurrency: cd-production`, no cancel | Deployments run one at a time and are never killed halfway |
| Registry login with the **run's token, piped over stdin** | No long-lived registry credential on the server. The token expires when the run ends and never appears on a command line |
| **Pinned SSH host key** (`EC2_SSH_KNOWN_HOSTS`) | Blindly accepting host keys (`StrictHostKeyChecking=no`) would let an impostor server receive the deployment |
| `DEPLOY_ENABLED` gate | CD builds and publishes images before the EC2 server exists (Phase 9) |

**Why run tests before building the production image?** Because a failing change should stop as
early and cheaply as possible, and an image that exists in the registry is one command away from
production. Only commits that passed every check ever become deployable artifacts.

**Why a container registry?** It's the hand-off point between "build" and "run": CI/CD pushes
versioned images, and any server pulls exactly the version it's told to. Without a registry the
server would have to build from source, which is slow, non-reproducible, and needs build tools
on production machines.

## 15. Docker image workflow

```text
developer ──git push──► GitHub ──► CI builds + tests images (not pushed)
                                    │ green, on main
                                    ▼
                               CD builds again (mostly from the shared layer cache)
                                    │ push
                                    ▼
          ghcr.io/<owner>/url-shortener-api:4f2c9e1…   (+ :latest)
          ghcr.io/<owner>/url-shortener-worker:4f2c9e1…
          ghcr.io/<owner>/url-shortener-migrate:4f2c9e1…
                                    │ pull (IMAGE_TAG=4f2c9e1…)
                                    ▼
                           EC2: docker compose -f docker-compose.prod.yml up -d --wait
```

- Images are built for `linux/amd64` (EC2 t3 instances). An ARM (Graviton, t4g) server would need
  `linux/arm64` added to `platforms`.
- OCI labels (`org.opencontainers.image.source`, `.revision`) link each image to the repository
  and commit.
- `deploy.sh` prunes unused images older than 7 days on the server, so the disk doesn't fill up
  while recent versions stay available for rollback.

## 16. Deploying and rolling back

[`infrastructure/aws/deploy.sh`](../infrastructure/aws/deploy.sh) runs on the server:

1. `docker compose pull` the images for the new tag
2. `docker compose up -d --wait --wait-timeout 180`: the migrate container runs first (API and
   worker depend on it completing), then containers are recreated and their health checks awaited
3. `GET /ready` must return 200
4. success: record the tag in `.deployed-tag`; failure: **redeploy the previous tag** and exit 1,
   so the CD job goes red

**Tested locally** with a local registry standing in for GHCR:

| Step | Result |
| ---- | ------ |
| `deploy.sh v1` (good release, images pulled from the registry) | Healthy in 35 s, state `v1`, full smoke test passed |
| `deploy.sh v2` (API crashes on startup) | Health checks failed after 6 s, **rolled back to v1** in 13 s, exit code 1, state still `v1`, app healthy |

**Manual rollback:** Actions → CD → *Run workflow* → `image_tag` = the SHA to go back to. The
publish job is skipped, and deploy redeploys that existing image.

**Known limitations** (acceptable for a single-server student project, and good interview
material):

- **Brief downtime per deploy.** `docker compose up` replaces both API replicas at once. In the
  rollback test there were about 19 s without a healthy API. Fixes: a rolling update (start new
  containers, wait for health, then remove old ones; e.g. the `docker rollout` plugin), or a
  platform with rolling deployments (ECS, Kubernetes) behind a load balancer.
- **Rollback reverts code, not the database.** Migrations must be **backward compatible**
  (expand/contract): add a nullable column, deploy code that uses it, and only drop the old column
  in a later release. Then the previous version still runs against the new schema.
- Deploys run from GitHub-hosted runners over SSH, so port 22 must be reachable from GitHub's IP
  ranges (see Phase 9 for how to limit this).

## 17. GitHub setup

**Secrets and variables** (Settings → Secrets and variables → Actions; the environment is
created under Settings → Environments → `production`):

| Name | Kind | Needed for | Value |
| ---- | ---- | ---------- | ----- |
| `GITHUB_TOKEN` | automatic | CI, publish | Built in, no setup |
| `DEPLOY_ENABLED` | variable | deploy | `true` once the server exists (Phase 9) |
| `EC2_HOST` | variable | deploy | Server public IP or DNS name |
| `EC2_USER` | variable | deploy | e.g. `ec2-user` |
| `APP_BASE_URL` | variable | deploy | e.g. `http://<server-ip>` |
| `EC2_SSH_KEY` | **secret** (production env) | deploy | Private key of a deploy-only SSH key pair |
| `EC2_SSH_KNOWN_HOSTS` | **secret** (production env) | deploy | Output of `ssh-keyscan <server>` |

Application secrets (`JWT_SECRET`, `POSTGRES_PASSWORD`) are **not** stored in GitHub. They live
only in `/opt/url-shortener/.env` on the server (chmod 600).

**Branch protection** (recommended): require the three CI checks to pass before merging into
`main`, so `main` is always deployable. Settings → Branches → add a rule for `main` → *Require
status checks*: `Lint, audit & unit tests`, `Integration tests`, `Docker build & smoke test`.

**Dependabot** ([`.github/dependabot.yml`](../.github/dependabot.yml)) opens weekly PRs for npm
packages (minor and patch grouped into one PR), Docker base images and GitHub Actions. Each PR
runs through CI like any other change.
