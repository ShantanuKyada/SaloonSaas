import { randomUUID } from 'node:crypto';
import cookieParser from 'cookie-parser';
import cors from 'cors';
import express, { type NextFunction, type Request, type Response } from 'express';
import { rateLimit } from 'express-rate-limit';
import helmet from 'helmet';
import { pinoHttp } from 'pino-http';
import swaggerUi from 'swagger-ui-express';
import { corsOrigins, env, scaledLimit } from './config/env.js';
import { safeEqual } from './core/crypto.js';
import { AppError, translateDatabaseError } from './core/errors.js';
import { logger } from './core/logger.js';
import { metrics, renderMetrics } from './core/metrics.js';
import { db } from './db/pool.js';
import { sql } from 'kysely';
import { apiRouter } from './modules/index.js';
import { buildOpenApiDocument } from './openapi/document.js';

type RequestWithId = Request & { requestId: string };

export function createApp() {
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', env.TRUST_PROXY);

  // Correlation id: accept a well-formed upstream id (from the proxy) or create one.
  app.use((req, res, next) => {
    const incoming = req.get('x-request-id');
    const id = incoming && /^[A-Za-z0-9._-]{8,64}$/.test(incoming) ? incoming : randomUUID();
    (req as RequestWithId).requestId = id;
    res.setHeader('X-Request-Id', id);
    next();
  });

  app.use(
    pinoHttp({
      logger,
      genReqId: (req) => (req as unknown as RequestWithId).requestId,
      customLogLevel: (_req, res, err) => (err || res.statusCode >= 500 ? 'error' : res.statusCode >= 400 ? 'warn' : 'info'),
      customProps: (req) => {
        const auth = (req as Request & { auth?: { userId: string; orgId: string | null } }).auth;
        return auth ? { userId: auth.userId, orgId: auth.orgId } : {};
      },
      serializers: {
        req: (req: { method: string; url: string }) => ({ method: req.method, url: req.url.split('?')[0] }),
        res: (res: { statusCode: number }) => ({ statusCode: res.statusCode }),
      },
      autoLogging: { ignore: (req) => req.url === '/health' || req.url === '/ready' || req.url === '/metrics' },
    }),
  );

  app.use(
    helmet({
      contentSecurityPolicy: {
        directives: {
          defaultSrc: ["'self'"],
          scriptSrc: ["'self'"],
          styleSrc: ["'self'", "'unsafe-inline'"],
          imgSrc: ["'self'", 'data:'],
          frameAncestors: ["'none'"],
        },
      },
      crossOriginResourcePolicy: { policy: 'same-site' },
    }),
  );
  app.use(
    cors({
      origin: (origin, callback) => callback(null, !origin || corsOrigins.includes(origin)),
      credentials: true,
      maxAge: 600,
      exposedHeaders: ['X-Request-Id', 'Content-Disposition'],
    }),
  );
  // The raw body is kept for webhook signature verification (WhatsApp, biometric devices).
app.use(express.json({ limit: '1mb', verify: (req, _res, buf) => { (req as unknown as { rawBody: Buffer }).rawBody = buf; } }));
  app.use(cookieParser());

  // Route-level latency metrics.
  app.use((req, res, next) => {
    const started = process.hrtime.bigint();
    res.on('finish', () => {
      const route = req.route?.path ? `${req.baseUrl}${req.route.path}` : 'unmatched';
      const seconds = Number(process.hrtime.bigint() - started) / 1e9;
      const labels = { method: req.method, route, status: String(res.statusCode) };
      metrics.httpRequests.inc(labels);
      metrics.httpDuration.observe({ method: req.method, route }, seconds);
      if (res.statusCode >= 500) metrics.httpErrors.inc({ route });
      if (seconds > 1) {
        metrics.slowRequests.inc({ route });
        logger.warn({ route, seconds: Number(seconds.toFixed(3)) }, 'slow request');
      }
    });
    next();
  });

  app.get('/health', (_req, res) => {
    res.json({ status: 'ok' });
  });
  app.get('/ready', async (_req, res) => {
    try {
      await sql`select 1`.execute(db);
      res.json({ status: 'ready' });
    } catch {
      res.status(503).json({ status: 'unavailable' });
    }
  });
  app.get('/metrics', (req, res) => {
    if (env.METRICS_TOKEN) {
      const header = req.get('authorization') ?? '';
      if (!safeEqual(header, `Bearer ${env.METRICS_TOKEN}`)) {
        res.status(401).end();
        return;
      }
    }
    res.type('text/plain; version=0.0.4').send(renderMetrics());
  });

  const openApi = buildOpenApiDocument();
  app.get('/api/openapi.json', (_req, res) => {
    res.json(openApi);
  });
  app.use(
    '/api/docs',
    (_req: Request, res: Response, next: NextFunction) => {
      // Swagger UI needs inline scripts; relax CSP for the docs page only.
      res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data:");
      next();
    },
    swaggerUi.serve,
    swaggerUi.setup(openApi, { customSiteTitle: 'SalonOS API' }),
  );

  const apiLimiter = rateLimit({
    windowMs: 60 * 1000,
    limit: scaledLimit(600),
    standardHeaders: 'draft-8',
    legacyHeaders: false,
    handler: (_req, _res, next) => next(new AppError(429, 'RATE_LIMITED', 'Too many requests. Please slow down and try again.')),
  });
  app.use('/api/v1', apiLimiter, apiRouter);

  app.use((req, _res, next) => {
    next(new AppError(404, 'NOT_FOUND', `No endpoint ${req.method} ${req.path}`));
  });

  // Central error handler: one response shape, no stack traces or SQL ever reach the client.
  app.use((error: unknown, req: Request, res: Response, _next: NextFunction) => {
    const requestId = (req as RequestWithId).requestId;
    let appError: AppError | null = error instanceof AppError ? error : translateDatabaseError(error);

    if (!appError && error instanceof SyntaxError && 'body' in error) {
      appError = new AppError(400, 'BAD_REQUEST', 'The request body is not valid JSON.');
    }
    if (!appError) {
      const pgCode = (error as { code?: string })?.code;
      if (pgCode) metrics.dbErrors.inc({ code: pgCode });
      logger.error({ err: error, requestId }, 'unhandled error');
      appError = new AppError(500, 'INTERNAL_ERROR', 'Something went wrong on our side. Please try again; if it keeps happening, contact support.');
    } else if (appError.code === 'APPOINTMENT_CONFLICT') {
      metrics.appointmentConflicts.inc();
    } else if (appError.code === 'FINANCIAL_INTEGRITY' && appError.status >= 500) {
      logger.error({ err: error, requestId }, 'financial integrity check failed');
    }

    if (res.headersSent) return;
    res.status(appError.status).json({
      success: false,
      message: appError.message,
      errorCode: appError.code,
      details: appError.details,
      requestId,
    });
  });

  return app;
}
