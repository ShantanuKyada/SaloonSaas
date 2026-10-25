import { CamelCasePlugin, Kysely, PostgresDialect } from 'kysely';
import pg from 'pg';
import { env } from '../config/env.js';
import type { DB } from './schema.generated.js';

// int8 → number: money is stored in minor units and counts are small; both fit in Number.MAX_SAFE_INTEGER.
pg.types.setTypeParser(pg.types.builtins.INT8, (v) => Number(v));
// numeric → number: only produced by aggregates such as sum(bigint).
pg.types.setTypeParser(pg.types.builtins.NUMERIC, (v) => Number(v));
// date stays 'YYYY-MM-DD' so calendar dates are never shifted by the server time zone.
pg.types.setTypeParser(pg.types.builtins.DATE, (v) => v);

export function createPool(connectionString: string, max = env.DB_POOL_MAX): pg.Pool {
  const pool = new pg.Pool({
    connectionString,
    max,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 10_000,
    statement_timeout: env.DB_STATEMENT_TIMEOUT_MS,
    application_name: 'salonos',
    ssl: env.DB_SSL ? { rejectUnauthorized: true } : undefined,
  });
  return pool;
}

export function createDb(pool: pg.Pool): Kysely<DB> {
  return new Kysely<DB>({
    dialect: new PostgresDialect({ pool }),
    plugins: [new CamelCasePlugin()],
  });
}

export const pool = createPool(env.DATABASE_URL);
export const db = createDb(pool);

export async function closeDb(): Promise<void> {
  await db.destroy();
}
