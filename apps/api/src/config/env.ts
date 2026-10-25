import { z } from 'zod';

// All configuration comes from environment variables, validated once at start-up (fail fast, never at request time).

const bool = z
  .enum(['true', 'false', '1', '0', 'yes', 'no'])
  .transform((v) => v === 'true' || v === '1' || v === 'yes');

const schema = z
  .object({
    NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
    PORT: z.coerce.number().int().min(1).max(65535).default(4000),
    LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),

    DATABASE_URL: z.string().min(1),
    DATABASE_MIGRATION_URL: z.string().min(1).optional(),
    DATABASE_SUPERUSER_URL: z.string().min(1).optional(),
    DB_APP_ROLE: z.string().regex(/^[a-z_][a-z0-9_]*$/).default('salon_app'),
    DB_POOL_MAX: z.coerce.number().int().min(1).max(200).default(10),
    DB_STATEMENT_TIMEOUT_MS: z.coerce.number().int().min(1000).default(15000),
    DB_SSL: bool.default(false),

    JWT_ACCESS_SECRET: z.string().min(32, 'JWT_ACCESS_SECRET must be at least 32 characters'),
    JWT_ISSUER: z.string().default('salonos'),
    ACCESS_TOKEN_TTL_SECONDS: z.coerce.number().int().min(60).max(3600).default(900),
    REFRESH_TOKEN_TTL_DAYS: z.coerce.number().int().min(1).max(90).default(30),
    PUBLIC_LINK_SECRET: z.string().min(32).optional(),
    DATA_ENCRYPTION_KEY: z
      .string()
      .refine((v) => Buffer.from(v, 'base64').length === 32, 'DATA_ENCRYPTION_KEY must be 32 bytes, base64-encoded'),

    APP_BASE_URL: z.string().url().default('http://localhost:5173'),
    API_BASE_URL: z.string().url().default('http://localhost:4000'),
    CORS_ORIGINS: z.string().default('http://localhost:5173'),
    COOKIE_SECURE: bool.optional(),
    TRUST_PROXY: z.coerce.number().int().min(0).max(10).default(0),
    METRICS_TOKEN: z.string().min(16).optional(),

    LOGIN_MAX_ATTEMPTS: z.coerce.number().int().min(3).max(20).default(5),
    LOGIN_LOCK_MINUTES: z.coerce.number().int().min(1).max(1440).default(15),

    NOTIFICATIONS_MODE: z.enum(['console', 'live', 'disabled']).default('console'),
    WHATSAPP_PROVIDER: z.enum(['meta_cloud', 'none']).default('none'),
    WHATSAPP_API_KEY: z.string().optional(),
    WHATSAPP_PHONE_NUMBER_ID: z.string().optional(),
    WHATSAPP_API_VERSION: z.string().default('v21.0'),
    WHATSAPP_WEBHOOK_VERIFY_TOKEN: z.string().optional(),
    WHATSAPP_APP_SECRET: z.string().optional(),
    EMAIL_PROVIDER: z.enum(['smtp', 'none']).default('none'),
    SMTP_HOST: z.string().optional(),
    SMTP_PORT: z.coerce.number().int().default(587),
    SMTP_SECURE: bool.default(false),
    SMTP_USER: z.string().optional(),
    EMAIL_API_KEY: z.string().optional(),
    EMAIL_FROM: z.string().optional(),
    SMS_PROVIDER: z.enum(['http', 'none']).default('none'),
    SMS_API_URL: z.string().url().optional(),
    SMS_API_KEY: z.string().optional(),
    SMS_SENDER_ID: z.string().optional(),
    BIOMETRIC_API_URL: z.string().url().optional(),
    BIOMETRIC_API_KEY: z.string().optional(),

    /** Multiplies every rate limit (end-to-end and load tests only; must stay 1 in production). */
    RATE_LIMIT_MULTIPLIER: z.coerce.number().int().min(1).max(1000).default(1),

    WORKER_POLL_INTERVAL_MS: z.coerce.number().int().min(200).default(2000),
    WORKER_BATCH_SIZE: z.coerce.number().int().min(1).max(500).default(25),
    WORKER_CONCURRENCY: z.coerce.number().int().min(1).max(50).default(5),
  })
  .superRefine((env, ctx) => {
    if (env.NODE_ENV === 'production') {
      if (env.NOTIFICATIONS_MODE === 'console') {
        ctx.addIssue({ code: 'custom', path: ['NOTIFICATIONS_MODE'], message: 'console mode is not allowed in production' });
      }
      if (!env.METRICS_TOKEN) {
        ctx.addIssue({ code: 'custom', path: ['METRICS_TOKEN'], message: 'METRICS_TOKEN is required in production' });
      }
      // Example values from .env.example must never reach production.
      if (/^(replace|change)/i.test(env.JWT_ACCESS_SECRET) || (env.PUBLIC_LINK_SECRET && /^(replace|change)/i.test(env.PUBLIC_LINK_SECRET))) {
        ctx.addIssue({ code: 'custom', path: ['JWT_ACCESS_SECRET'], message: 'replace the example secret with a long random value' });
      }
      if (Buffer.from(env.DATA_ENCRYPTION_KEY, 'base64').every((byte) => byte === 0)) {
        ctx.addIssue({ code: 'custom', path: ['DATA_ENCRYPTION_KEY'], message: 'the all-zero example key must not be used' });
      }
      if (env.RATE_LIMIT_MULTIPLIER !== 1) {
        ctx.addIssue({ code: 'custom', path: ['RATE_LIMIT_MULTIPLIER'], message: 'must be 1 in production' });
      }
      if (env.CORS_ORIGINS.includes('*')) {
        ctx.addIssue({ code: 'custom', path: ['CORS_ORIGINS'], message: 'Wildcard CORS is not allowed in production' });
      }
    }
  });

export type Env = z.infer<typeof schema>;

function load(): Env {
  // Empty values (KEY=) mean "not set".
  const raw = Object.fromEntries(Object.entries(process.env).filter(([, v]) => v !== undefined && v !== ''));
  const parsed = schema.safeParse(raw);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `  - ${i.path.join('.')}: ${i.message}`).join('\n');
    // eslint-disable-next-line no-console
    console.error(`Invalid environment configuration:\n${issues}`);
    process.exit(1);
  }
  return parsed.data;
}

export const env = load();
export const isProduction = env.NODE_ENV === 'production';
export const isTest = env.NODE_ENV === 'test';
export const corsOrigins = env.CORS_ORIGINS.split(',').map((o) => o.trim()).filter(Boolean);
/** A rate limit adjusted for the environment: effectively unlimited under test, scaled for end-to-end runs. */
export const scaledLimit = (limit: number): number => (isTest ? limit * 100 : limit * env.RATE_LIMIT_MULTIPLIER);
export const cookieSecure = env.COOKIE_SECURE ?? isProduction;
