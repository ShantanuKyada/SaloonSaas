import { sql } from 'kysely';
import type { Tx } from '../db/tenant.js';

/**
 * Gapless, concurrency-safe counter. The row lock taken by the upsert is held until the surrounding transaction
 * commits, so concurrent bills queue for a number and a rolled-back bill does not burn one.
 */
export async function nextSequence(
  tx: Tx,
  organizationId: string,
  scopeKey: string,
  docType: string,
  periodKey: string,
): Promise<number> {
  const result = await sql<{ value: number }>`
    insert into document_sequences (organization_id, scope_key, doc_type, period_key, next_value)
    values (${organizationId}, ${scopeKey}, ${docType}, ${periodKey}, 2)
    on conflict (organization_id, scope_key, doc_type, period_key)
    do update set next_value = document_sequences.next_value + 1
    returning next_value - 1 as value`.execute(tx);
  return Number(result.rows[0]!.value);
}

export async function nextBranchDocumentNumber(
  tx: Tx,
  args: { organizationId: string; branchId: string; branchCode: string; docType: string; prefix: string; periodKey: string },
): Promise<string> {
  const value = await nextSequence(tx, args.organizationId, args.branchId, args.docType, args.periodKey);
  return `${args.prefix}-${args.branchCode.toUpperCase()}-${args.periodKey}-${String(value).padStart(5, '0')}`;
}

export async function nextCustomerCode(tx: Tx, organizationId: string): Promise<string> {
  const value = await nextSequence(tx, organizationId, 'org', 'customer', 'all');
  return `C${String(value).padStart(5, '0')}`;
}

/** BK261023-012: readable over the phone; unique per organization. */
export async function nextBookingNumber(tx: Tx, organizationId: string, prefix: string, localDate: string): Promise<string> {
  const ymd = localDate.replace(/-/g, '').slice(2);
  const value = await nextSequence(tx, organizationId, 'org', 'booking', ymd);
  return `${prefix}${ymd}-${String(value).padStart(3, '0')}`;
}

export async function nextQueueNumber(tx: Tx, organizationId: string, branchId: string, localDate: string): Promise<number> {
  return nextSequence(tx, organizationId, branchId, 'walk_in_queue', localDate);
}
