import type { Permission, PageMeta } from '@salon/shared';
import { Router, type NextFunction, type Request, type RequestHandler, type Response } from 'express';
import { z, type ZodType } from 'zod';
import { withTenant, type Tx } from '../db/tenant.js';
import { authenticateBearer, systemContext, type AuthContext } from './auth-context.js';
import { AppError, validationError } from './errors.js';

// A thin layer over Express that gives every endpoint the same shape:
// authenticate → check permissions → validate params/query/body → run handler in a tenant transaction →
// respond `{ success, data, meta }`. The same metadata generates the OpenAPI document.

export type AuthMode = 'org' | 'platform' | 'any' | 'public';

export interface RouteSpec {
  method: 'get' | 'post' | 'put' | 'patch' | 'delete';
  path: string;
  tag: string;
  summary: string;
  description?: string;
  auth: AuthMode;
  permissions: Permission[];
  body?: ZodType;
  query?: ZodType;
  status: number;
  idempotent: boolean;
}

export const routeSpecs: RouteSpec[] = [];

export class Paged<T> {
  constructor(
    readonly rows: T[],
    readonly meta: PageMeta,
  ) {}
}

export function paged<T>(rows: T[], total: number, page: number, pageSize: number): Paged<T> {
  return new Paged(rows, { page, pageSize, total, totalPages: Math.max(1, Math.ceil(total / pageSize)) });
}

export class FileResponse {
  constructor(
    readonly filename: string,
    readonly contentType: string,
    readonly body: string | Buffer,
  ) {}
}

export interface HandlerContext<B, Q> {
  req: Request;
  res: Response;
  auth: AuthContext;
  body: B;
  query: Q;
  params: Record<string, string>;
  /** Runs `fn` inside a transaction scoped to the caller's organization (RLS). */
  tx: <T>(fn: (tx: Tx) => Promise<T>) => Promise<T>;
}

interface RouteOptions<B extends ZodType | undefined, Q extends ZodType | undefined> {
  summary: string;
  description?: string;
  auth?: AuthMode;
  /** Caller needs at least one of these. */
  permissions?: Permission[];
  body?: B;
  query?: Q;
  status?: number;
  idempotent?: boolean;
  middleware?: RequestHandler[];
  /** Reachable while two-step sign-in is required but not set up yet (only the account and security routes). */
  allowUnenrolled?: boolean;
}

type Infer<S> = S extends ZodType ? z.output<S> : undefined;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function requestMeta(req: Request) {
  return {
    requestId: (req as Request & { requestId?: string }).requestId ?? 'unknown',
    ip: req.ip ?? null,
    userAgent: req.get('user-agent') ?? null,
  };
}

export function createRouter(basePath: string, tag: string) {
  const router = Router();

  function register<B extends ZodType | undefined, Q extends ZodType | undefined>(
    method: RouteSpec['method'],
    path: string,
    options: RouteOptions<B, Q>,
    handler: (ctx: HandlerContext<Infer<B>, Infer<Q>>) => Promise<unknown>,
  ) {
    const auth = options.auth ?? 'org';
    const permissions = options.permissions ?? [];
    routeSpecs.push({
      method,
      path: `${basePath}${path === '/' ? '' : path}`,
      tag,
      summary: options.summary,
      description: options.description,
      auth,
      permissions,
      body: options.body,
      query: options.query,
      status: options.status ?? (method === 'post' ? 201 : 200),
      idempotent: options.idempotent ?? false,
    });

    const run = async (req: Request, res: Response, _next: NextFunction) => {
      for (const [name, value] of Object.entries(req.params)) {
        if ((name === 'id' || name.endsWith('Id')) && !UUID.test(String(value))) throw new AppError(404, 'NOT_FOUND', 'Record could not be found.');
      }

      const meta = requestMeta(req);
      let ctxAuth: AuthContext;
      if (auth === 'public') {
        ctxAuth = { ...systemContext(null, meta.requestId), ip: meta.ip, userAgent: meta.userAgent };
      } else {
        ctxAuth = await authenticateBearer(req.get('authorization'), meta);
        if (auth === 'org' && !ctxAuth.orgId) {
          throw new AppError(403, 'FORBIDDEN', 'This screen is only available inside a salon account.');
        }
        if (auth === 'platform' && !ctxAuth.isPlatformAdmin) {
          throw new AppError(403, 'FORBIDDEN', 'Only platform administrators can do this.');
        }
        if (ctxAuth.mfaSetupRequired && !options.allowUnenrolled) {
          throw new AppError(403, 'MFA_SETUP_REQUIRED', 'Your salon requires two-step sign-in. Set it up to continue.');
        }
        if (permissions.length && !permissions.some((p) => ctxAuth.permissions.has(p))) {
          throw new AppError(403, 'FORBIDDEN', "You don't have permission to do this. Ask your manager or salon owner for access.");
        }
      }
      (req as Request & { auth?: AuthContext }).auth = ctxAuth;

      let body: unknown = undefined;
      if (options.body) {
        const parsed = options.body.safeParse(req.body ?? {});
        if (!parsed.success) throw validationError(parsed.error);
        body = parsed.data;
      }
      let query: unknown = undefined;
      if (options.query) {
        const parsed = options.query.safeParse(req.query ?? {});
        if (!parsed.success) throw validationError(parsed.error, 'Some filters are not valid.');
        query = parsed.data;
      }

      const scope = { orgId: ctxAuth.orgId, platform: auth === 'platform' || ctxAuth.isPlatformAdmin, userId: ctxAuth.userId || null };
      const result = await handler({
        req,
        res,
        auth: ctxAuth,
        body: body as Infer<B>,
        query: query as Infer<Q>,
        params: req.params as Record<string, string>,
        tx: (fn) => withTenant(scope, fn),
      });

      if (res.headersSent) return;
      if (result === undefined) {
        res.status(204).end();
      } else if (result instanceof Paged) {
        res.status(200).json({ success: true, data: result.rows, meta: result.meta });
      } else if (result instanceof FileResponse) {
        res.setHeader('Content-Type', result.contentType);
        res.setHeader('Content-Disposition', `attachment; filename="${result.filename.replace(/[^A-Za-z0-9._-]/g, '_')}"`);
        res.setHeader('Cache-Control', 'no-store');
        res.status(200).send(result.body);
      } else {
        res.status(options.status ?? (method === 'post' ? 201 : 200)).json({ success: true, data: result });
      }
    };

    router[method](path, ...(options.middleware ?? []), run);
  }

  return {
    router,
    basePath,
    get: <Q extends ZodType | undefined = undefined>(
      path: string,
      options: RouteOptions<undefined, Q>,
      handler: (ctx: HandlerContext<undefined, Infer<Q>>) => Promise<unknown>,
    ) => register('get', path, options, handler),
    post: <B extends ZodType | undefined = undefined>(
      path: string,
      options: RouteOptions<B, undefined>,
      handler: (ctx: HandlerContext<Infer<B>, undefined>) => Promise<unknown>,
    ) => register('post', path, options, handler),
    put: <B extends ZodType | undefined = undefined>(
      path: string,
      options: RouteOptions<B, undefined>,
      handler: (ctx: HandlerContext<Infer<B>, undefined>) => Promise<unknown>,
    ) => register('put', path, options, handler),
    patch: <B extends ZodType | undefined = undefined>(
      path: string,
      options: RouteOptions<B, undefined>,
      handler: (ctx: HandlerContext<Infer<B>, undefined>) => Promise<unknown>,
    ) => register('patch', path, options, handler),
    delete: <B extends ZodType | undefined = undefined>(
      path: string,
      options: RouteOptions<B, undefined>,
      handler: (ctx: HandlerContext<Infer<B>, undefined>) => Promise<unknown>,
    ) => register('delete', path, options, handler),
  };
}

export type ModuleRouter = ReturnType<typeof createRouter>;

/** Parses a value with a schema, throwing the standard validation error. */
export function parseWith<S extends ZodType>(schema: S, value: unknown): z.output<S> {
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw validationError(parsed.error);
  return parsed.data;
}
