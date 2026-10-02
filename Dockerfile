# One image for the API, the analytics worker and database migrations: the
# same code, started with a different command (see docker-compose.yml).
#
# Multi-stage build: dependencies are installed in a "build" stage, and the
# final image copies only the result (no dev tools, no npm cache).

FROM node:24-alpine AS build
WORKDIR /app
RUN apk add --no-cache openssl
# Copy the package files first: Docker caches this step, so `npm ci` only
# re-runs when dependencies change, not on every code change.
COPY package.json package-lock.json prisma.config.js ./
COPY prisma ./prisma
# `npm ci` also runs `prisma generate` (postinstall). DATABASE_URL is only a
# placeholder; nothing connects to a database while building.
RUN DATABASE_URL=postgresql://build:build@localhost/build npm ci && npm prune --omit=dev

FROM node:24-alpine
RUN apk add --no-cache openssl
WORKDIR /app
ENV NODE_ENV=production
COPY --from=build /app/node_modules ./node_modules
COPY package.json prisma.config.js ./
COPY prisma ./prisma
COPY src ./src
COPY worker ./worker
USER node
EXPOSE 3000
CMD ["node", "src/server.js"]
