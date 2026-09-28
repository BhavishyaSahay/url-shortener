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
| 3 | Authentication (JWT in HTTP-only cookies) | ⏳ |
| 4 | URL shortening (Base62, custom aliases, expiry) | ⏳ |
| 5 | Redirects, Redis cache-aside, rate limiting | ⏳ |
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
npm install          # also generates the Prisma client (postinstall)
npm run db:up        # start PostgreSQL in Docker and wait until it's healthy
npm run db:migrate   # apply database migrations
npm run dev          # start the API with auto-reload
```

```bash
curl http://localhost:3000/health   # liveness: is the process up?
curl http://localhost:3000/ready    # readiness: can it reach PostgreSQL?
```

PostgreSQL is published on host port **5433** (not 5432) to avoid clashing with a locally
installed Postgres. Change `POSTGRES_PORT` and `DATABASE_URL` in `.env` if needed.

## Scripts

| Command | Description |
| ------- | ----------- |
| `npm run dev` | Start with `node --watch` (auto-restart on changes) |
| `npm start` | Start normally (used in production) |
| `npm run lint` | Run ESLint |
| `npm test` | Run all tests |
| `npm run test:unit` | Unit tests only |
| `npm run test:integration` | Integration tests (need PostgreSQL running; use a separate `_test` DB) |
| `npm run db:up` | Start PostgreSQL (Docker) and wait for its health check |
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

See [docs/DATABASE.md](docs/DATABASE.md) for the schema, index and pooling design.
