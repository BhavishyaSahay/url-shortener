# URL Shortener

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
| 6 | Kafka click events + analytics worker | ⏳ |
| 7 | Docker, Docker Compose, Nginx | ⏳ |
| 8 | CI/CD with GitHub Actions | ⏳ |
| 9 | AWS EC2 deployment | ⏳ |
| 10 | Prometheus + Grafana monitoring | ⏳ |
| 11 | k6 load testing | ⏳ |

## Running locally

Requirements: Node.js 20.12+ and Docker.

```bash
cp .env.example .env
# set JWT_SECRET in .env (required, 32+ chars):
node -e "console.log(require('crypto').randomBytes(48).toString('base64'))"
npm install          # also generates the Prisma client (postinstall)
npm run db:up        # start PostgreSQL + Redis in Docker, wait until healthy
npm run db:migrate   # apply database migrations
npm run dev          # start the API with auto-reload
```

```bash
curl http://localhost:3000/health   # liveness: is the process up?
curl http://localhost:3000/ready    # readiness: PostgreSQL (critical) + Redis (optional)
```

Containers are published on non-default host ports to avoid clashing with locally installed
services: **PostgreSQL on 5433** and **Redis on 6380**. Change `POSTGRES_PORT`/`DATABASE_URL`
and `REDIS_PORT`/`REDIS_URL` in `.env` if needed.

## Scripts

| Command | Description |
| ------- | ----------- |
| `npm run dev` | Start with `node --watch` (auto-restart on changes) |
| `npm start` | Start normally (used in production) |
| `npm run lint` | Run ESLint |
| `npm test` | Run all tests |
| `npm run test:unit` | Unit tests only |
| `npm run test:integration` | Integration tests (need PostgreSQL + Redis running; use a separate `_test` DB and Redis DB 1) |
| `npm run db:up` | Start PostgreSQL + Redis (Docker) and wait for their health checks |
| `npm run db:migrate` | Create/apply migrations in development |
| `npm run db:deploy` | Apply pending migrations (CI/production) |
| `npm run db:studio` | Browse the database in Prisma Studio |

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
worker/         Kafka analytics consumer (Phase 6)
tests/          unit/, integration/, load/ (k6)
docs/           HLD, LLD, API, DATABASE, DEVOPS
```

## Documentation

- [docs/API.md](docs/API.md): endpoints with curl examples
- [docs/LLD.md](docs/LLD.md): low-level design (caching, rate limiting, Base62, collisions, concurrency, auth)
- [docs/DATABASE.md](docs/DATABASE.md): schema, indexes, constraints, pooling
