import { sql, type Transaction } from 'kysely';
import { db } from './pool.js';
import type { DB } from './schema.generated.js';

export type Tx = Transaction<DB>;

export interface TenantScope {
  orgId: string | null;
  /** Platform/system context: bypasses tenant RLS. Only for super-admin screens, auth lookups and the worker. */
  platform?: boolean;
  userId?: string | null;
}

/**
 * Runs `fn` in a transaction whose PostgreSQL session settings identify the tenant. RLS policies read
 * `app.org_id`, so every query inside is confined to that organization even if a WHERE clause is forgotten.
 * Settings are transaction-local (`set_config(..., true)`) and therefore safe with pooled connections.
 */
export async function withTenant<T>(scope: TenantScope, fn: (tx: Tx) => Promise<T>): Promise<T> {
  return db.transaction().execute(async (tx) => {
    await sql`select set_config('app.org_id', ${scope.orgId ?? ''}, true),
                     set_config('app.platform', ${scope.platform ? 'on' : 'off'}, true),
                     set_config('app.user_id', ${scope.userId ?? ''}, true)`.execute(tx);
    return fn(tx);
  });
}

export function withSystem<T>(fn: (tx: Tx) => Promise<T>): Promise<T> {
  return withTenant({ orgId: null, platform: true }, fn);
}

/** Serialises concurrent work on the same key (e.g. one staff member's schedule) until the transaction ends. */
export async function advisoryLock(tx: Tx, namespace: string, key: string): Promise<void> {
  await sql`select pg_advisory_xact_lock(hashtextextended(${`${namespace}:${key}`}, 0))`.execute(tx);
}
