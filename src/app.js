import cookieParser from 'cookie-parser';
import express from 'express';
import helmet from 'helmet';
import { pinoHttp } from 'pino-http';
import { config } from './config/env.js';
import { redirect } from './controllers/redirect.controller.js';
import { errorHandler, notFoundHandler } from './middleware/error.middleware.js';
import healthRoutes from './routes/health.routes.js';
import v1Router from './routes/index.js';
import { logger } from './utils/logger.js';

// Builds the Express app without starting a server, so tests can use it directly.
export function createApp() {
  const app = express();

  // Behind nginx, trust its X-Forwarded-For header so req.ip is the real client IP.
  app.set('trust proxy', config.trustProxy);

  app.use(helmet()); // security headers
  app.use(pinoHttp({ logger, autoLogging: { ignore: (req) => req.url === '/health' } })); // one log line per request
  app.use(express.json({ limit: '10kb' }));
  app.use(cookieParser());

  app.use(healthRoutes);
  app.use('/api/v1', v1Router);
  app.get('/:shortCode', redirect); // last, because it matches any single-segment path

  app.use(notFoundHandler);
  app.use(errorHandler);
  return app;
}
