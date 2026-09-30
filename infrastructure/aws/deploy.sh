#!/usr/bin/env bash
# Runs ON the EC2 server. The CD pipeline copies it (with docker-compose.prod.yml
# and nginx/nginx.conf) into /opt/url-shortener and calls:
#
#   ./deploy.sh <image-tag>
#
# Steps:
#   1. pull the images for <image-tag>
#   2. `up --wait`: runs migrations (one-shot container), recreates the API and
#      worker, and waits for every health check
#   3. confirm GET /ready answers 200
#   4. success → remember the tag; failure → ROLL BACK to the previous tag
#
# Configuration and secrets come from /opt/url-shortener/.env (see
# .env.production.example). IMAGE_TAG exported here overrides the value in .env.
set -euo pipefail

NEW_TAG="${1:?usage: deploy.sh <image-tag>}"
cd "$(dirname "$0")"

COMPOSE=(docker compose -f docker-compose.prod.yml)
STATE_FILE=.deployed-tag
PREVIOUS_TAG="$(cat "$STATE_FILE" 2>/dev/null || true)"

log() { echo "[deploy $(date -u +%H:%M:%S)] $*"; }

deploy_tag() {
  export IMAGE_TAG="$1"
  "${COMPOSE[@]}" pull --quiet migrate api worker
  # --wait-timeout: a release that never becomes healthy (e.g. crash-looping)
  # fails the deploy instead of hanging it.
  "${COMPOSE[@]}" up -d --wait --wait-timeout 180 --remove-orphans
}

is_ready() {
  for _ in $(seq 1 20); do
    curl -fsS -o /dev/null http://localhost/ready && return 0
    sleep 3
  done
  return 1
}

log "deploying ${NEW_TAG} (currently running: ${PREVIOUS_TAG:-nothing})"

if deploy_tag "$NEW_TAG" && is_ready; then
  echo "$NEW_TAG" > "$STATE_FILE"
  # Delete unused images older than a week, so old releases don't fill the
  # disk. Recent ones stay around for a quick rollback.
  docker image prune -af --filter "until=168h" > /dev/null
  log "deployed ${NEW_TAG} successfully"
  "${COMPOSE[@]}" ps
  exit 0
fi

log "deployment of ${NEW_TAG} FAILED"
"${COMPOSE[@]}" ps || true
"${COMPOSE[@]}" logs --tail 50 api worker migrate || true

if [[ -n "$PREVIOUS_TAG" ]]; then
  log "rolling back to ${PREVIOUS_TAG}"
  # Note: this rolls back the CODE, not the database. Migrations must be
  # backward compatible (expand/contract) for a rollback to be safe.
  if deploy_tag "$PREVIOUS_TAG" && is_ready; then
    log "rollback to ${PREVIOUS_TAG} succeeded"
  else
    log "ROLLBACK FAILED: manual intervention needed"
  fi
fi
exit 1
