import pino from 'pino';
import { config } from '../config/env.js';

// Structured JSON logs (one object per line), pretty-printed in development.
export const logger = pino({
  level: config.logLevel,
  timestamp: pino.stdTimeFunctions.isoTime,
  formatters: { level: (label) => ({ level: label }) },
  // Never write secrets to the logs.
  redact: ['req.headers.cookie', 'req.headers.authorization', 'res.headers["set-cookie"]'],
  transport: config.env === 'development' ? { target: 'pino-pretty' } : undefined,
});
