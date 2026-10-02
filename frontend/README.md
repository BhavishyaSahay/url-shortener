# Frontend

React app for the URL shortener: sign up, shorten links (optional custom alias and expiry),
manage them, and see click analytics.

**Stack:** React 19 · React Router · Vite · plain CSS · JavaScript (no TypeScript)

## Pages

| Path | Page |
| ---- | ---- |
| `/app/login`, `/app/register` | Log in / sign up |
| `/app/` | Shorten a link + your links (paginated, copy button, status) |
| `/app/links/:id` | Edit the destination or expiry, deactivate, delete, and analytics (clicks per day, top referrers, browsers) |

## How it fits with the backend

- The app lives under **`/app/`**, because every other path (`/w7e`, `/my-alias`) is a short link.
- API calls use relative paths (`/api/v1/...`), so they go to the **same origin** as the page and the
  browser sends the HTTP-only login cookie automatically. No CORS needed.
- In production, the `Dockerfile` builds this folder and Express serves the result
  (see [docs/ARCHITECTURE.md](../docs/ARCHITECTURE.md#frontend)).

## Run locally

Start the backend first (from the repository root): `docker compose up -d --build --wait`.

```bash
npm install
npm run dev        # http://localhost:5173/app/, forwards /api to the backend on port 8080
npm run lint       # oxlint
npm run build      # production build into dist/
```

## Structure

```
src/
  main.jsx              entry point, router (basename /app)
  App.jsx               header, routes, login check
  api.js                fetch wrapper for every backend call
  dates.js              datetime-local input ↔ ISO date helpers
  pages/                AuthForm, Dashboard, LinkDetails
  components/           ClicksChart, CopyButton, ErrorMessage, StatusBadge
```
