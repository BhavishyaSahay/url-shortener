# URL Shortener

[![CI](https://github.com/BhavishyaSahay/url-shortener/actions/workflows/ci.yml/badge.svg)](https://github.com/BhavishyaSahay/url-shortener/actions/workflows/ci.yml)
[![CD](https://github.com/BhavishyaSahay/url-shortener/actions/workflows/cd.yml/badge.svg)](https://github.com/BhavishyaSahay/url-shortener/actions/workflows/cd.yml)

A simplified Bitly: create short links (with optional custom aliases and expiry dates), share
them, and see who clicked.

**Stack:** React (Vite) · Node.js · Express · PostgreSQL + Prisma · Redis · Docker · Nginx · GitHub Actions · AWS EC2

## Features

- React frontend: sign up, shorten links, manage them, and see a chart of clicks per day
- Register, log in, log out (Argon2 password hashing, JWT in an HTTP-only cookie)
- Create short URLs: generated Base62 codes or custom aliases, optional expiry
- List, update, deactivate and delete your own URLs
- Fast redirects with a Redis cache
- Click analytics (total, per day, top referrers, top user agents) processed by a background worker
- Rate limiting on login and URL creation
- Docker Compose setup with Nginx in front of two API containers
- CI (lint, tests, Docker build) and CD (image to GitHub Container Registry, deploy to EC2)

## Architecture

```text
Browser ──► Nginx ──► Express API (×2) ──► PostgreSQL
                          │  (also serves the React app at /app)
                          │
                          ├──► Redis: URL cache + rate limits
                          └──► Redis list "clicks" ──► Analytics worker ──► PostgreSQL
```

Details: [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) · Endpoints: [docs/API.md](docs/API.md)

## Run it locally

Requirements: Docker Desktop.

```bash
cp .env.example .env
# put a random value in JWT_SECRET (32+ characters):
node -e "console.log(require('crypto').randomBytes(48).toString('base64'))"
docker compose up -d --build --wait
```

Open **http://localhost:8080** (it redirects to the app at `/app/`), or use the API directly:

```bash
curl http://localhost:8080/health
curl -c cookies.txt -X POST http://localhost:8080/api/v1/auth/register \
  -H 'Content-Type: application/json' -d '{"email":"me@example.com","password":"password123"}'
curl -b cookies.txt -X POST http://localhost:8080/api/v1/urls \
  -H 'Content-Type: application/json' -d '{"url":"https://example.com/some/long/page"}'
```

### Developing without rebuilding images

```bash
npm install
npm run db:up        # only PostgreSQL and Redis in Docker
npm run db:migrate   # apply migrations
npm run dev          # API on http://localhost:3000 (restarts on changes)
npm run worker       # analytics worker (second terminal)
```

Frontend with live reload (third terminal):

```bash
cd frontend
npm install
npm run dev          # http://localhost:5173/app/ (API calls go to the backend on 8080)
```

`npm run dev` in `frontend/` expects the backend on port 8080 (`docker compose up`). To use the
`npm run dev` backend on port 3000 instead: `API_URL=http://localhost:3000 npm run dev`.

## Tests

```bash
npm run db:up   # tests need PostgreSQL and Redis (they use a separate test database)
npm test        # unit + integration tests
npm run lint
cd frontend && npm run lint && npm run build   # frontend checks
```

## Deployment

Every push to `main` runs CI; if it passes, CD builds the Docker image, pushes it to GitHub
Container Registry and deploys it to an AWS EC2 server over SSH (`docker compose pull && up`).
See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md#deployment).

## Project structure

```text
frontend/       React app (Vite): pages, components, API client
src/
  config/       env validation, Prisma (PostgreSQL), Redis
  routes/       URL → controller
  controllers/  read the request, call a service, send the response
  services/     business logic: auth, URLs, redirect + cache, click queue, analytics
  middleware/   auth, rate limiting, errors
  utils/        Base62, validation, JWT, passwords, errors, logger
worker/         analytics worker (Redis queue → PostgreSQL)
prisma/         database schema and migrations
tests/          unit and integration tests
nginx/          reverse proxy config
.github/        CI and CD workflows
```
