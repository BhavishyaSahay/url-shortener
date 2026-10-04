import cookieParser from 'cookie-parser';
import express from 'express';
import helmet from 'helmet';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { pinoHttp } from 'pino-http';
import { config } from './config/env.js';
import { redirect } from './controllers/redirect.controller.js';
import { errorHandler, notFoundHandler } from './middleware/error.middleware.js';
import healthRoutes from './routes/health.routes.js';
import v1Router from './routes/index.js';
import { logger } from './utils/logger.js';

// The React frontend, built into frontend/dist by `npm run build` (the Dockerfile does this).
const FRONTEND_DIR = path.resolve(import.meta.dirname, '../frontend/dist');

// Builds the Express app without starting a server, so tests can use it directly.
export function createApp() {
  const app = express();

  // Behind nginx, trust its X-Forwarded-For header so req.ip is the real client IP.
  app.set('trust proxy', config.trustProxy);

  // Security headers. upgrade-insecure-requests makes browsers load everything over
  // HTTPS, so it's only on when the site is served over HTTPS (COOKIE_SECURE=true,
  // production). On plain HTTP (local Docker) it would break the frontend's JS and CSS.
  const upgradeInsecureRequests = config.cookieSecure ? [] : null;
  app.use(helmet({ contentSecurityPolicy: { directives: { upgradeInsecureRequests } } }));
  app.use(pinoHttp({ logger, autoLogging: { ignore: (req) => req.url === '/health' } })); // one log line per request
  app.use(express.json({ limit: '10kb' }));
  app.use(cookieParser());

  app.use(healthRoutes);
  app.use('/api/v1', v1Router);

  // The frontend lives under /app (every other path is a short link). Skipped when
  // it hasn't been built, e.g. in the API tests.
  if (existsSync(FRONTEND_DIR)) {
    app.get('/', (req, res) => res.redirect('/app/'));
    app.use('/app', express.static(FRONTEND_DIR));
    // Pages like /app/links/15 are handled by React Router in the browser, so
    // any other /app path gets the same index.html.
    app.get('/app/{*page}', (req, res) => res.sendFile(path.join(FRONTEND_DIR, 'index.html')));
  }

  app.get('/:shortCode', redirect); // last, because it matches any single-segment path

  app.use(notFoundHandler);
  app.use(errorHandler);
  return app;
}
