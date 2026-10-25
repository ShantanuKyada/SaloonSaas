import { PERMISSIONS } from '@salon/shared';
import { z, type ZodType } from 'zod';
import { routeSpecs } from '../core/router.js';

// OpenAPI 3.1 generated from the same Zod schemas that validate requests, so documentation cannot drift.

function toJsonSchema(schema: ZodType): Record<string, unknown> {
  try {
    return z.toJSONSchema(schema, { io: 'input', unrepresentable: 'any', target: 'draft-2020-12' }) as Record<string, unknown>;
  } catch {
    return { type: 'object' };
  }
}

function queryParameters(schema: ZodType): unknown[] {
  const json = toJsonSchema(schema) as { properties?: Record<string, Record<string, unknown>>; required?: string[] };
  return Object.entries(json.properties ?? {}).map(([name, prop]) => ({
    name,
    in: 'query',
    required: json.required?.includes(name) ?? false,
    schema: prop,
  }));
}

const errorResponse = {
  description: 'Error',
  content: {
    'application/json': {
      schema: {
        type: 'object',
        required: ['success', 'message', 'errorCode', 'details'],
        properties: {
          success: { const: false },
          message: { type: 'string', description: 'Human-readable explanation safe to show to end users' },
          errorCode: { type: 'string', examples: ['APPOINTMENT_CONFLICT', 'VALIDATION_ERROR'] },
          details: { type: 'object' },
          requestId: { type: 'string' },
        },
      },
    },
  },
};

export function buildOpenApiDocument(): Record<string, unknown> {
  const paths: Record<string, Record<string, unknown>> = {};
  for (const spec of routeSpecs) {
    const path = `/api/v1${spec.path}`.replace(/:([A-Za-z]+)/g, '{$1}');
    const pathParams = [...path.matchAll(/\{([A-Za-z]+)\}/g)].map((m) => ({
      name: m[1],
      in: 'path',
      required: true,
      schema: { type: 'string', format: 'uuid' },
    }));
    const permissionText = spec.permissions.length
      ? `\n\n**Requires any of:** ${spec.permissions.map((p) => `\`${p}\` (${PERMISSIONS[p].label})`).join(', ')}`
      : '';
    const authText =
      spec.auth === 'public' ? '\n\n**Public endpoint.**' : spec.auth === 'platform' ? '\n\n**Platform administrators only.**' : '';
    const operation: Record<string, unknown> = {
      tags: [spec.tag],
      summary: spec.summary,
      description: `${spec.description ?? ''}${permissionText}${authText}${spec.idempotent ? '\n\nSupports the `Idempotency-Key` header.' : ''}`.trim(),
      security: spec.auth === 'public' ? [] : [{ bearerAuth: [] }],
      parameters: [...pathParams, ...(spec.query ? queryParameters(spec.query) : [])],
      responses: {
        [String(spec.status)]: {
          description: 'Success',
          content: spec.status === 204 ? undefined : { 'application/json': { schema: { $ref: '#/components/schemas/Success' } } },
        },
        '400': errorResponse,
        '401': errorResponse,
        '403': errorResponse,
        '404': errorResponse,
        '409': errorResponse,
        '429': errorResponse,
        '500': errorResponse,
      },
    };
    if (spec.body) {
      operation.requestBody = { required: true, content: { 'application/json': { schema: toJsonSchema(spec.body) } } };
    }
    paths[path] ??= {};
    paths[path][spec.method] = operation;
  }

  return {
    openapi: '3.1.0',
    info: {
      title: 'SalonOS API',
      version: '1.0.0',
      description:
        'Multi-tenant salon management API. Authenticate with `POST /api/v1/auth/login`, then send `Authorization: Bearer <accessToken>`. ' +
        'Money values are integers in minor units (paise). Timestamps are ISO-8601 UTC; dates are `YYYY-MM-DD` in the branch time zone. ' +
        'Every response is `{ success, data, meta? }` or `{ success: false, message, errorCode, details }`.',
    },
    servers: [{ url: '/' }],
    components: {
      securitySchemes: { bearerAuth: { type: 'http', scheme: 'bearer', bearerFormat: 'JWT' } },
      schemas: {
        Success: {
          type: 'object',
          properties: {
            success: { const: true },
            data: {},
            meta: {
              type: 'object',
              properties: { page: { type: 'integer' }, pageSize: { type: 'integer' }, total: { type: 'integer' }, totalPages: { type: 'integer' } },
            },
          },
        },
      },
    },
    paths,
  };
}
