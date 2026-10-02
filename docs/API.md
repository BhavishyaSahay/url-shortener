# API

Base URL: `http://localhost:8080` (Docker) or `http://localhost:3000` (`npm run dev`).
JSON in and out. Endpoints marked 🔒 need the `access_token` cookie, which register or login set.

Errors always look like `{ "error": { "code": "...", "message": "...", "details": [...] } }`:

| Status | Meaning |
| ------ | ------- |
| 400 | Invalid input (`details` lists the fields) |
| 401 | Not logged in, or wrong email/password |
| 404 | Not found (or not yours) |
| 409 | Email or alias already taken |
| 410 | Link deactivated or expired |
| 429 | Rate limited (see the `Retry-After` header) |

## Health

| Method | Path | Response |
| ------ | ---- | -------- |
| GET | `/health` | `200 {"status":"ok"}`: the process is running |
| GET | `/ready` | `200 {"status":"ready","checks":{"database":"up","redis":"up"}}`, or `503` if PostgreSQL is down |

## Auth

| Method | Path | Body | Response |
| ------ | ---- | ---- | -------- |
| POST | `/api/v1/auth/register` | `{"email","password"}` (8+ chars) | `201 {"user"}` + cookie |
| POST | `/api/v1/auth/login` | `{"email","password"}` | `200 {"user"}` + cookie. Limit: 10 per 15 min per IP |
| POST | `/api/v1/auth/logout` | | `204`, clears the cookie |
| GET 🔒 | `/api/v1/auth/me` | | `200 {"user": {"id","email","createdAt"}}` |

```bash
curl -c cookies.txt -X POST http://localhost:8080/api/v1/auth/register \
  -H 'Content-Type: application/json' -d '{"email":"me@example.com","password":"password123"}'
```

## URLs 🔒

| Method | Path | Body / query | Response |
| ------ | ---- | ------------ | -------- |
| POST | `/api/v1/urls` | `{"url", "customAlias"?, "expiresAt"?}` | `201 {"url"}`. Limit: 30 per minute |
| GET | `/api/v1/urls` | `?page=1&limit=20` | `200 {"urls": [...], "pagination"}`, newest first |
| GET | `/api/v1/urls/:id` | | `200 {"url"}` |
| PATCH | `/api/v1/urls/:id` | any of `{"url", "isActive", "expiresAt"}` (`null` removes the expiry) | `200 {"url"}` |
| DELETE | `/api/v1/urls/:id` | | `204` |
| GET | `/api/v1/urls/:id/analytics` | | `200` (below) |

Rules: `url` must be `http://` or `https://`. `customAlias` is 3–32 characters of letters,
numbers, `-` or `_`. `expiresAt` is an ISO date in the future, e.g. `2026-12-31T00:00:00Z`.

```bash
curl -b cookies.txt -X POST http://localhost:8080/api/v1/urls \
  -H 'Content-Type: application/json' \
  -d '{"url":"https://example.com/some/long/page","customAlias":"my-link","expiresAt":"2026-12-31T00:00:00Z"}'
```

```json
{
  "url": {
    "id": 1,
    "shortCode": "my-link",
    "shortUrl": "http://localhost:8080/my-link",
    "originalUrl": "https://example.com/some/long/page",
    "isCustomAlias": true,
    "isActive": true,
    "expiresAt": "2026-12-31T00:00:00.000Z",
    "status": "active",
    "createdAt": "2026-10-02T12:00:00.000Z"
  }
}
```

`status` is `active`, `inactive` (deactivated) or `expired`.

### Analytics

```json
{
  "urlId": 1,
  "shortCode": "my-link",
  "totalClicks": 3,
  "clicksByDay": [{ "date": "2026-10-02", "clicks": 3 }],
  "topReferrers": [{ "referrer": "twitter.com", "clicks": 2 }, { "referrer": "direct", "clicks": 1 }],
  "userAgents": [{ "userAgent": "Mozilla/5.0 …", "clicks": 3 }]
}
```

Clicks are saved by the background worker, so they appear a moment after the redirect.

## Redirect

| Method | Path | Response |
| ------ | ---- | -------- |
| GET | `/:shortCode` | `302` to the original URL (`X-Cache: HIT` or `MISS`), `404` unknown, `410` deactivated or expired |
