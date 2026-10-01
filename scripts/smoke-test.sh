#!/usr/bin/env bash
# Smoke test: is a running deployment actually working, end to end?
#
#   scripts/smoke-test.sh [BASE_URL] [--read-only]
#
#   full (default)  health, readiness, register, create link, redirect, and a click
#                   reaching analytics through the Redis Stream and the worker.
#                   Used in CI against the Docker Compose stack.
#   --read-only     health + readiness only: creates no data.
#                   Used by CD against production after a deploy.
#
# Only needs bash, curl and grep, so it runs on a CI runner, a laptop or a server.
set -euo pipefail

BASE_URL="${1:-http://localhost:8080}"
BASE_URL="${BASE_URL%/}"
MODE="${2:-full}"
COOKIES="$(mktemp)"
trap 'rm -f "$COOKIES"' EXIT

pass() { echo "  ✓ $*"; }
fail() { echo "  ✗ $*" >&2; exit 1; }
json_field() { grep -o "\"$1\":\"\\{0,1\\}[^,\"}]*" | head -1 | sed -E "s/\"$1\":\"?//"; }

echo "Smoke test against $BASE_URL ($MODE)"

# Readiness can take a few seconds right after a deploy; retry for up to 60 s.
for attempt in $(seq 1 30); do
  if curl -fsS -o /dev/null "$BASE_URL/ready" 2>/dev/null; then break; fi
  [[ $attempt -eq 30 ]] && fail "GET /ready did not return 200 within 60 s"
  sleep 2
done

health="$(curl -fsS "$BASE_URL/health")" || fail "GET /health failed"
[[ "$health" == *'"status":"ok"'* ]] || fail "unexpected /health body: $health"
pass "GET /health → ok"

ready="$(curl -fsS "$BASE_URL/ready")"
pass "GET /ready → $(echo "$ready" | json_field status) $(echo "$ready" | grep -o '"checks":{[^}]*}')"

if [[ "$MODE" == "--read-only" ]]; then
  echo "Smoke test passed (read-only)"
  exit 0
fi

email="smoke-$(date +%s)-$RANDOM@example.com"
status="$(curl -sS -o /dev/null -w '%{http_code}' -c "$COOKIES" -X POST "$BASE_URL/api/v1/auth/register" \
  -H 'Content-Type: application/json' -d "{\"email\":\"$email\",\"password\":\"smoke-test-password\"}")"
[[ "$status" == 201 ]] || fail "register returned $status"
pass "POST /api/v1/auth/register → 201"

created="$(curl -fsS -b "$COOKIES" -X POST "$BASE_URL/api/v1/urls" \
  -H 'Content-Type: application/json' -d '{"url":"https://example.com/smoke-test"}')" || fail "create URL failed"
id="$(echo "$created" | json_field id)"
code="$(echo "$created" | json_field shortCode)"
[[ -n "$id" && -n "$code" ]] || fail "unexpected create response: $created"
pass "POST /api/v1/urls → /$code (id $id)"

redirect="$(curl -sS -o /dev/null -w '%{http_code} %{redirect_url}' "$BASE_URL/$code")"
[[ "$redirect" == "302 https://example.com/smoke-test" ]] || fail "redirect returned: $redirect"
pass "GET /$code → 302 https://example.com/smoke-test"

# The click travels API → Redis Stream → worker → PostgreSQL asynchronously.
for attempt in $(seq 1 30); do
  clicks="$(curl -fsS -b "$COOKIES" "$BASE_URL/api/v1/urls/$id/analytics" | json_field totalClicks)"
  [[ "${clicks:-0}" -ge 1 ]] && break
  [[ $attempt -eq 30 ]] && fail "click never reached analytics (Redis Stream → worker pipeline) within 30 s"
  sleep 1
done
pass "click processed by the analytics worker (totalClicks=$clicks)"

echo "Smoke test passed"
