# syntax=docker/dockerfile:1
#
# Analytics worker image. Same multi-stage pattern as the API image
# (see api.Dockerfile for the step-by-step explanation); only the copied code,
# the health port and the start command differ.
#
# Build:  docker build -f docker/worker.Dockerfile -t url-shortener-worker .

ARG NODE_IMAGE=node:24-alpine

# ---------------------------------------------------------------------------
FROM ${NODE_IMAGE} AS deps
WORKDIR /app
RUN apk add --no-cache openssl
COPY package.json package-lock.json prisma.config.js ./
COPY prisma ./prisma
RUN DATABASE_URL=postgresql://build:build@localhost:5432/build npm ci

# ---------------------------------------------------------------------------
FROM ${NODE_IMAGE} AS prod-deps
WORKDIR /app
COPY package.json package-lock.json ./
# A FRESH install of production dependencies only.
# Why --omit=optional too: the Prisma CLI (and Prisma Studio, ~150 MB of
# packages) is marked "devOptional" in package-lock.json, meaning it's a
# devDependency here AND an optional peer of @prisma/client. npm only leaves
# such packages out when BOTH dev and optional are omitted. (The only other
# optional package, pg-cloudflare, is for Cloudflare Workers and unused.)
# --ignore-scripts skips our postinstall (`prisma generate` needs the CLI), so
# argon2's install step is re-run explicitly; it picks up a prebuilt native
# binary, and nothing is compiled.
RUN npm ci --omit=dev --omit=optional --ignore-scripts && npm rebuild argon2
# The generated Prisma client comes from the deps stage.
COPY --from=deps /app/node_modules/.prisma ./node_modules/.prisma

# ---------------------------------------------------------------------------
FROM ${NODE_IMAGE} AS runtime
ENV NODE_ENV=production \
    SERVICE_NAME=analytics-worker
WORKDIR /app

COPY --from=prod-deps /app/node_modules ./node_modules
COPY package.json ./
# The worker reuses the API's config, Prisma client, Kafka client and logger.
COPY src ./src
COPY worker ./worker

USER node

EXPOSE 9101

HEALTHCHECK --interval=10s --timeout=3s --start-period=60s --retries=3 \
  CMD wget -qO- http://127.0.0.1:9101/health > /dev/null || exit 1

CMD ["node", "worker/analytics.worker.js"]
