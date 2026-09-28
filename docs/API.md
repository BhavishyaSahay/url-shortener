# API Reference

Base URL (local): `http://localhost:3000`. All API routes are versioned under `/api/v1`.
Request and response bodies are JSON (`Content-Type: application/json`).

## Conventions

### Authentication

Log in or register to receive an **HTTP-only cookie** named `access_token` holding a JWT.
Browsers send it automatically. Non-browser clients can send the same token as a header instead:

```http
Authorization: Bearer <token>
```

Endpoints marked 🔒 return `401` without a valid token.

### Errors

Every error has the same shape:

```json
{
  "error": {
    "code": "VALIDATION_ERROR",
    "message": "Request validation failed",
    "details": [{ "field": "email", "message": "must be a valid email address" }],
    "requestId": "8f14e45f-ceea-4f8a-9d1b-3a2c0b7e1c55"
  }
}
```

| Status | `code` | When |
| ------ | ------ | ---- |
| 400 | `VALIDATION_ERROR` | Invalid body. `details` lists every bad field |
| 400 | `INVALID_JSON` | Body isn't valid JSON |
| 401 | `UNAUTHORIZED` | Missing/invalid/expired token, or wrong login credentials |
| 403 | `FORBIDDEN` | Authenticated but not allowed |
| 404 | `NOT_FOUND` | Route or resource doesn't exist |
| 409 | `CONFLICT` | Unique value already taken (email, alias) |
| 413 | `PAYLOAD_TOO_LARGE` | Body over 10 KB |
| 429 | `RATE_LIMITED` | Too many requests. See the `Retry-After` header |
| 500 | `INTERNAL_ERROR` | Bug. Report the `requestId` |

Every response carries an `X-Request-Id` header. Clients (or Nginx) may send their own and it
will be reused, which makes it possible to trace one request through all the logs.

---

## Operations

### `GET /health`: liveness

Is the process up? Never checks dependencies.

```bash
curl http://localhost:3000/health
```

```json
{ "status": "ok", "uptimeSeconds": 42, "timestamp": "2026-09-28T05:00:00.000Z" }
```

### `GET /ready`: readiness

Can this instance serve traffic? Checks PostgreSQL (Redis and Kafka are added in later phases).

| Status | Body |
| ------ | ---- |
| 200 | `{ "status": "ready", "checks": { "database": "up" } }` |
| 503 | `{ "status": "not_ready", "checks": { "database": "down" } }` |
| 503 | `{ "status": "shutting_down" }` during graceful shutdown |

---

## Auth

Auth responses are sent with `Cache-Control: no-store`.

### `POST /api/v1/auth/register`

Create an account and log in.

| Field | Rules |
| ----- | ----- |
| `email` | Valid email, max 255 chars. Trimmed and lower-cased |
| `password` | 8–128 characters |

```bash
curl -i -c cookies.txt -X POST http://localhost:3000/api/v1/auth/register \
  -H 'Content-Type: application/json' \
  -d '{"email":"alice@example.com","password":"correct-horse-battery"}'
```

**201 Created**

```http
Set-Cookie: access_token=eyJhbGciOi...; Max-Age=86400; Path=/; HttpOnly; SameSite=Lax
```

```json
{ "user": { "id": 1, "email": "alice@example.com", "createdAt": "2026-09-28T05:51:50.515Z" } }
```

Errors: `400` invalid input · `409` email already registered.

### `POST /api/v1/auth/login`

```bash
curl -i -c cookies.txt -X POST http://localhost:3000/api/v1/auth/login \
  -H 'Content-Type: application/json' \
  -d '{"email":"alice@example.com","password":"correct-horse-battery"}'
```

**200 OK**: sets the `access_token` cookie. Body: `{ "user": { ... } }`.

Errors: `400` missing fields · `401` `"Invalid email or password"`. The message is the same for
an unknown email and a wrong password, on purpose. Rate limiting is added in Phase 5.

### `POST /api/v1/auth/logout`

Clears the cookie. Safe to call when not logged in.

```bash
curl -i -b cookies.txt -X POST http://localhost:3000/api/v1/auth/logout
```

**204 No Content**

### `GET /api/v1/auth/me` 🔒

```bash
curl -b cookies.txt http://localhost:3000/api/v1/auth/me
# or
curl -H "Authorization: Bearer <token>" http://localhost:3000/api/v1/auth/me
```

**200 OK**

```json
{ "user": { "id": 1, "email": "alice@example.com", "createdAt": "2026-09-28T05:51:50.515Z" } }
```

Errors: `401` no token, invalid or expired token, or the account no longer exists.

---

## URLs 🔒

All URL endpoints require authentication and only ever operate on the caller's own URLs.
Another user's URL returns `404`, exactly like a nonexistent one.

### The URL object

```json
{
  "id": 1,
  "shortCode": "1",
  "shortUrl": "http://localhost:3000/1",
  "originalUrl": "https://example.com/products/this-is-a-very-long-url",
  "isCustomAlias": false,
  "isActive": true,
  "expiresAt": null,
  "status": "active",
  "createdAt": "2026-09-28T18:07:23.742Z",
  "updatedAt": "2026-09-28T18:07:23.742Z"
}
```

`status` is computed: `inactive` if `isActive` is false, else `expired` if `expiresAt` has
passed, else `active`. Only `active` links redirect.

### `POST /api/v1/urls`

| Field | Required | Rules |
| ----- | -------- | ----- |
| `url` | yes | Absolute `http://` or `https://` URL, max 2048 chars, not a link to this shortener |
| `customAlias` | no | 3–32 chars of `A-Z a-z 0-9 - _`, case-sensitive, not reserved (`api`, `health`, `ready`, `metrics`, …) |
| `expiresAt` | no | ISO 8601 date-time **with timezone**, in the future, e.g. `2026-12-31T00:00:00Z` |

Unknown fields are rejected (`400`), so a typo like `custom_alias` fails loudly.

```bash
curl -b cookies.txt -X POST http://localhost:3000/api/v1/urls \
  -H 'Content-Type: application/json' \
  -d '{"url":"https://example.com/some/long/url"}'

curl -b cookies.txt -X POST http://localhost:3000/api/v1/urls \
  -H 'Content-Type: application/json' \
  -d '{"url":"https://example.com","customAlias":"my-link","expiresAt":"2026-12-31T00:00:00Z"}'
```

**201 Created**, with a `Location: /api/v1/urls/{id}` header. Body: `{ "url": { ... } }`.

Errors: `400` validation (see `details`) · `401` · `409` alias already taken (by anyone).

### `GET /api/v1/urls`

Your URLs, newest first.

| Query | Default | Rules |
| ----- | ------- | ----- |
| `page` | 1 | ≥ 1 |
| `limit` | 20 | 1–100 |

```bash
curl -b cookies.txt 'http://localhost:3000/api/v1/urls?page=1&limit=20'
```

```json
{
  "urls": [{ "id": 2, "shortCode": "my-link", "...": "..." }],
  "pagination": { "page": 1, "limit": 20, "total": 2, "totalPages": 1 }
}
```

### `GET /api/v1/urls/:id`

```bash
curl -b cookies.txt http://localhost:3000/api/v1/urls/1
```

**200** `{ "url": { ... } }` · `400` non-numeric ID · `404` not found or not yours.

### `PATCH /api/v1/urls/:id`

Send any subset of:

| Field | Meaning |
| ----- | ------- |
| `url` | New destination (same rules as create) |
| `isActive` | `false` deactivates (stops redirecting), `true` reactivates |
| `expiresAt` | New future expiry, or `null` to remove it |

The short code / alias can't be changed, because that would break links already shared.

```bash
curl -b cookies.txt -X PATCH http://localhost:3000/api/v1/urls/1 \
  -H 'Content-Type: application/json' -d '{"isActive":false}'
```

**200** `{ "url": { ... } }` · `400` empty body / unknown field / invalid value · `404`.

### `DELETE /api/v1/urls/:id`

Permanently deletes the URL. A custom alias becomes available again.

```bash
curl -b cookies.txt -X DELETE http://localhost:3000/api/v1/urls/1
```

**204 No Content** · `404` not found or not yours.

---

## Redirects (Phase 5) · Analytics (Phase 6)

Documented as each phase is built.
