import { randomUUID } from 'node:crypto';
import cookieParser from 'cookie-parser';
import express from 'express';
import helmet from 'helmet';
import { pinoHttp } from 'pino-http';
import { logger } from './utils/logger.js';
import healthRoutes from './routes/health.routes.js';
import v1Router from './routes/index.js';
import redirectRoutes from './routes/redirect.routes.js';
import { config } from './config/env.js';
import { errorHandler, notFoundHandler } from './middleware/error.middleware.js';

// Infrastructure endpoints that are polled constantly (by Docker health checks,
// load balancers, Prometheus). Logging every one would drown out real traffic.
const QUIET_PATHS = new Set(['/health', '/ready', '/metrics']);

// Builds the Express app without starting a server. Keeping this separate from
// server.js lets tests run requests against the app with Supertest without
// opening a real port.
export function createApp() {
  const app = express();

  // Behind Nginx, every request arrives from Nginx's IP. Trusting N proxy hops
  // makes req.ip the real client IP from X-Forwarded-For, which the rate
  // limiter depends on. (Trusting it without a proxy would let clients spoof their IP.)
  app.set('trust proxy', config.trustProxy);

  // Security headers (X-Content-Type-Options, removes X-Powered-By, etc.)
  app.use(helmet());

  // One structured log line per request: method, url, status, response time.
  // Each request gets an ID (reused from X-Request-Id if a proxy set one) that
  // is echoed back in the response so a client error can be traced to a log line.
  app.use(
    pinoHttp({
      logger,
      genReqId: (req, res) => {
        const id = req.headers['x-request-id'] || randomUUID();
        res.setHeader('X-Request-Id', id);
        return id;
      },
      autoLogging: { ignore: (req) => QUIET_PATHS.has(req.url) },
      customLogLevel: (req, res, err) => {
        if (err || res.statusCode >= 500) return 'error';
        if (res.statusCode >= 400) return 'warn';
        return 'info';
      },
      serializers: {
        req: (req) => ({ id: req.id, method: req.method, url: req.url }),
        res: (res) => ({ statusCode: res.statusCode }),
      },
    }),
  );

  // Parse JSON bodies. A small limit protects against huge payloads; a URL
  // shortener request is only a few hundred bytes.
  app.use(express.json({ limit: '10kb' }));
  // Parse the Cookie header into req.cookies (the auth token lives in a cookie).
  app.use(cookieParser());

  // Route order matters: fixed paths first, then the catch-all short-link
  // route GET /:shortCode last, so it can't shadow /health, /ready or /api.
  app.use(healthRoutes);
  app.use('/api/v1', v1Router);
  app.use(redirectRoutes);

  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
}
