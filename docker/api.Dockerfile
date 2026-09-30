# syntax=docker/dockerfile:1
#
# API image, built in stages. Only the last stage becomes the image that runs;
# the earlier ones are thrown away with their build tools and dev dependencies.
#
#   deps      install ALL dependencies, generate the Prisma client
#   migrate   deps + Prisma CLI → runs `prisma migrate deploy` once, then exits
#   prod-deps fresh install of production dependencies only (+ the generated Prisma client)
#   runtime   clean Node image + production node_modules + source code   ← the API image
#
# Build:  docker build -f docker/api.Dockerfile -t url-shortener-api .
#         docker build -f docker/api.Dockerfile --target migrate -t url-shortener-migrate .

ARG NODE_IMAGE=node:24-alpine

# ---------------------------------------------------------------------------
FROM ${NODE_IMAGE} AS deps
WORKDIR /app

# Prisma's migration engine (a native binary) needs OpenSSL, which Alpine doesn't ship by default.
RUN apk add --no-cache openssl

# Copy only what `npm ci` needs first. Docker caches each layer, so as long as
# these files don't change, the slow install step is reused on the next build
# even when the source code changed.
COPY package.json package-lock.json prisma.config.js ./
COPY prisma ./prisma

# npm ci installs exactly what package-lock.json says. The postinstall hook
# runs `prisma generate`. prisma.config.js reads DATABASE_URL, so give it a
# placeholder: nothing connects to a database at build time.
RUN DATABASE_URL=postgresql://build:build@localhost:5432/build npm ci

# ---------------------------------------------------------------------------
FROM deps AS migrate
ENV NODE_ENV=production
USER node
# DATABASE_URL is supplied at runtime (compose / deployment), never baked in.
CMD ["npx", "prisma", "migrate", "deploy"]

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
ENV NODE_ENV=production
WORKDIR /app

# Files stay owned by root and read-only to the app user: if the app were
# compromised, it couldn't modify its own code or dependencies.
COPY --from=prod-deps /app/node_modules ./node_modules
COPY package.json ./
COPY src ./src

# Don't run as root. The official Node image ships an unprivileged "node" user (uid 1000).
USER node

EXPOSE 3000

# Docker marks the container unhealthy if the liveness endpoint stops answering.
# (busybox wget is built into Alpine; no curl needed.)
HEALTHCHECK --interval=10s --timeout=3s --start-period=30s --retries=3 \
  CMD wget -qO- http://127.0.0.1:3000/health > /dev/null || exit 1

# Exec form (a JSON array), NOT `npm start`: node itself becomes the main
# process and receives SIGTERM directly, so graceful shutdown runs. npm would
# sit in between and doesn't reliably forward signals.
CMD ["node", "src/server.js"]
