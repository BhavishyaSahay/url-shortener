import pino from 'pino';
import { config } from '../config/env.js';

// Structured (JSON) logger. Each log line is one JSON object, which makes logs
// searchable and machine-parseable (e.g. by CloudWatch, Loki or `jq`).
// In development we pretty-print for readability instead.
export const logger = pino({
  level: config.logLevel,
  base: { service: config.serviceName },
  timestamp: pino.stdTimeFunctions.isoTime,
  // Write "level":"info" instead of pino's default numeric "level":30.
  formatters: { level: (label) => ({ level: label }) },
  // Never write secrets to logs. Matching fields are replaced with "[REDACTED]".
  redact: {
    paths: [
      'req.headers.authorization',
      'req.headers.cookie',
      'res.headers["set-cookie"]',
      '*.password',
      '*.passwordHash',
      '*.token',
    ],
    censor: '[REDACTED]',
  },
  transport:
    config.env === 'development'
      ? { target: 'pino-pretty', options: { translateTime: 'SYS:HH:MM:ss', ignore: 'pid,hostname' } }
      : undefined,
});
