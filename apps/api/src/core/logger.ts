import pino from 'pino';
import { env, isProduction, isTest } from '../config/env.js';

// Structured JSON logs. Secrets and personal data are redacted at the logger so no call site can leak them.
export const logger = pino({
  // Tests are silent unless TEST_LOG=1 is set (handy when a test hits an unexpected 500).
  level: isTest && !process.env.TEST_LOG ? 'silent' : env.LOG_LEVEL,
  base: { service: process.env.SERVICE_NAME ?? 'salonos-api' },
  timestamp: pino.stdTimeFunctions.isoTime,
  redact: {
    paths: [
      'req.headers.authorization',
      'req.headers.cookie',
      'res.headers["set-cookie"]',
      '*.password',
      '*.passwordHash',
      '*.newPassword',
      '*.currentPassword',
      '*.token',
      '*.refreshToken',
      '*.accessToken',
      '*.secrets',
      '*.secretsEncrypted',
      '*.mobile',
      '*.email',
    ],
    censor: '[redacted]',
  },
  transport:
    !isProduction && !isTest && process.stdout.isTTY
      ? { target: 'pino-pretty', options: { colorize: true, translateTime: 'HH:MM:ss', ignore: 'pid,hostname,service' } }
      : undefined,
});

export type Logger = typeof logger;
