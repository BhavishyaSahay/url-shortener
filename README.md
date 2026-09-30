# URL Shortener

[![CI](https://github.com/BhavishyaSahay/url-shortener/actions/workflows/ci.yml/badge.svg)](https://github.com/BhavishyaSahay/url-shortener/actions/workflows/ci.yml)
[![CD](https://github.com/BhavishyaSahay/url-shortener/actions/workflows/cd.yml/badge.svg)](https://github.com/BhavishyaSahay/url-shortener/actions/workflows/cd.yml)

A scalable URL shortener (a simplified Bitly) built as a final-year CS project to show backend
engineering and the basics of deploying, monitoring and operating a service.

**Stack:** Node.js (ES Modules) · Express 5 · PostgreSQL + Prisma · Redis · Kafka · Docker ·
Nginx · GitHub Actions · AWS EC2 · Prometheus + Grafana · Vitest + Supertest · k6

## Status

The project is built in phases, and each one is verified before the next starts.

| Phase | Scope | Status |
| ----- | ----- | ------ |
| 1 | Express backend, config, `/health`, error handling, logging | ✅ Done |
| 2 | PostgreSQL + Prisma schema, migrations, indexes, `/ready` | ✅ Done |
| 3 | Authentication: Argon2id, JWT in HTTP-only cookies | ✅ Done |
| 4 | URL shortening: Base62, custom aliases, expiry, CRUD with ownership checks | ✅ Done |
| 5 | Redirects, Redis cache-aside, negative caching, fixed-window rate limiting | ✅ Done |
| 6 | Kafka click events, analytics worker (idempotent, batched), analytics API | ✅ Done |
| 7 | Docker (multi-stage, non-root), Compose (dev + prod), Nginx load balancing | ✅ Done |
| 8 | CI (lint, audit, unit, integration, Docker smoke test), CD (GHCR images, SSH deploy, auto-rollback) | ✅ Done |
| 9 | AWS EC2 deployment | ⏳ |
| 10 | Prometheus + Grafana monitoring | ⏳ |
| 11 | k6 load testing | ⏳ |

## Running locally

### Option A: everything in Docker (recommended)

Requirements: Docker Desktop.

```bash
cp .env.example .env
# set JWT_SECRET in .env (required, 32+ chars):
node -e "console.log(require('crypto').randomBytes(48).toString('base64'))"
docker compose up -d --build --wait
```

Open **http://localhost:8080** (Nginx → 2 API instances). That starts PostgreSQL, Redis, Kafka,
the migrations, 2 API replicas, the analytics worker and Nginx.

```bash
curl http://localhost:8080/health   # liveness: is the process up?
curl http://localhost:8080/ready    # readiness: PostgreSQL (critical), Redis and Kafka (optional)
docker compose ps                   # health of every container
docker compose down                 # stop (data is kept; add -v to delete it)
```

### Option B: app on the host, infrastructure in Docker (fast edit-reload)

Requirements: Node.js 20.12+ and Docker.

```bash
cp .env.example .env                                # and set JWT_SECRET as above
npm install                                         # also generates the Prisma client
docker compose up -d --wait postgres redis kafka    # just the infrastructure
npm run db:migrate                                  # apply database migrations
npm run dev                                         # terminal 1: API on http://localhost:3000
npm run worker:dev                                  # terminal 2: analytics worker
```

Infrastructure ports on the host avoid clashing with locally installed services:
**PostgreSQL 5433**, **Redis 6380**, **Kafka 9092**, **Nginx 8080**. Change them in `.env` if needed.

## Scripts

| Command | Description |
| ------- | ----------- |
| `npm run dev` | Start with `node --watch` (auto-restart on changes) |
| `npm start` | Start normally (used in production) |
| `npm run lint` | Run ESLint |
| `npm test` | Run all tests |
| `npm run test:unit` | Unit tests only |
| `npm run test:integration` | Integration tests (need the Docker services running; use a `_test` DB, Redis DB 1 and a per-run Kafka topic) |
| `npm run worker` | Start the analytics worker (`worker:dev` for auto-reload) |
| `npm run db:up` | Start PostgreSQL, Redis and Kafka (Docker) and wait for their health checks |
| `npm run db:migrate` | Create/apply migrations in development |
| `npm run db:deploy` | Apply pending migrations (CI/production) |
| `npm run db:studio` | Browse the database in Prisma Studio |
| `npm run docker:up` | Build and start the whole stack in Docker, wait until healthy |
| `npm run docker:down` | Stop the Docker stack (data kept) |
| `npm run docker:logs` | Follow API, worker and Nginx logs |

## Project structure

```text
src/
  config/       environment config (validated at startup)
  controllers/  HTTP layer: parse the request, call a service, send the response
  services/     business logic, with no Express objects
  routes/       URL → controller mapping, API versioning (/api/v1)
  middleware/   auth, rate limiting, error handling
  utils/        logger, error classes, Base62, validation
  app.js        builds the Express app (used by server and tests)
  server.js     starts the HTTP server and handles graceful shutdown
prisma/         schema.prisma + SQL migrations
worker/         analytics worker: Kafka consumer → PostgreSQL (separate process)
docker/         multi-stage Dockerfiles (api, worker)
.github/        CI and CD workflows, Dependabot
scripts/        smoke test (used by CI and CD)
infrastructure/ deployment script run on the server
nginx/          reverse proxy / load balancer config
tests/          unit/, integration/, load/ (k6)
docs/           HLD, LLD, API, DATABASE, DEVOPS
```

## Documentation

- [docs/HLD.md](docs/HLD.md): high-level design (architecture, flows, scaling, failure handling)
- [docs/API.md](docs/API.md): endpoints with curl examples
- [docs/LLD.md](docs/LLD.md): low-level design (Kafka, caching, rate limiting, Base62, concurrency, auth)
- [docs/DATABASE.md](docs/DATABASE.md): schema, indexes, constraints, pooling
- [docs/DEVOPS.md](docs/DEVOPS.md): Docker, Compose, Nginx, CI/CD pipelines, deploys and rollbacks, secrets
