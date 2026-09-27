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
| 2 | PostgreSQL + Prisma schema and migrations | ⏳ |
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

Requirements: Node.js 20.12+.

```bash
cp .env.example .env
npm install
npm run dev        # starts with auto-reload on file changes
```

```bash
curl http://localhost:3000/health
```

## Scripts

| Command | Description |
| ------- | ----------- |
| `npm run dev` | Start with `node --watch` (auto-restart on changes) |
| `npm start` | Start normally (used in production) |
| `npm run lint` | Run ESLint |
| `npm test` | Run all tests |
| `npm run test:unit` | Unit tests only |
| `npm run test:integration` | Integration tests only |

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
worker/         Kafka analytics consumer (Phase 6)
tests/          unit/, integration/, load/ (k6)
docs/           HLD, LLD, API, DATABASE, DEVOPS
```
