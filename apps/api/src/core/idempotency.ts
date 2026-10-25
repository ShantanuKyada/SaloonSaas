import type { Request } from 'express';
import type { Tx } from '../db/tenant.js';
import type { AuthContext } from './auth-context.js';
import { sha256 } from './crypto.js';
import { AppError } from './errors.js';

/**
 * Makes a mutating request safe to retry. The key row is inserted in the same transaction as the business change:
 * a concurrent duplicate blocks on the unique index until the first commits, then replays its stored response.
 * If the first request fails and rolls back, the key disappears and a retry runs normally.
 */
export async function idempotent<T>(tx: Tx, auth: AuthContext, req: Request, fn: () => Promise<T>): Promise<T> {
  const key = req.get('idempotency-key');
  if (!key || !auth.orgId) return fn();
  if (!/^[A-Za-z0-9_-]{8,100}$/.test(key)) {
    throw new AppError(400, 'BAD_REQUEST', 'Invalid Idempotency-Key header.');
  }
  const requestHash = sha256(`${req.method}:${req.baseUrl}${req.path}:${JSON.stringify(req.body ?? {})}`);

  const inserted = await tx
    .insertInto('idempotencyKeys')
    .values({ organizationId: auth.orgId, key, userId: auth.userId, method: req.method, path: `${req.baseUrl}${req.path}`, requestHash })
    .onConflict((oc) => oc.columns(['organizationId', 'key']).doNothing())
    .returning('key')
    .executeTakeFirst();

  if (!inserted) {
    const existing = await tx
      .selectFrom('idempotencyKeys')
      .select(['requestHash', 'responseBody', 'userId'])
      .where('organizationId', '=', auth.orgId)
      .where('key', '=', key)
      .executeTakeFirst();
    if (!existing || existing.userId !== auth.userId || existing.requestHash !== requestHash) {
      throw new AppError(422, 'IDEMPOTENCY_CONFLICT', 'This request was already submitted with different details. Refresh and try again.');
    }
    if (existing.responseBody === null) {
      throw new AppError(409, 'CONFLICT', 'This request is still being processed. Please wait a moment.');
    }
    return existing.responseBody as T;
  }

  const result = await fn();
  await tx
    .updateTable('idempotencyKeys')
    .set({ statusCode: 200, responseBody: JSON.stringify(result ?? null) })
    .where('organizationId', '=', auth.orgId)
    .where('key', '=', key)
    .execute();
  return result;
}
