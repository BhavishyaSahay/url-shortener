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

## URLs (Phase 4) · Redirects (Phase 5) · Analytics (Phase 6)

Documented as each phase is built.
