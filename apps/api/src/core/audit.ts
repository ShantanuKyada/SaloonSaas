import type { Tx } from '../db/tenant.js';
import type { AuthContext } from './auth-context.js';

const REDACTED_KEYS = new Set([
  'passwordHash',
  'password',
  'secretsEncrypted',
  'secrets',
  'webhookSecret',
  'manageTokenHash',
  'tokenHash',
]);

type Plain = Record<string, unknown>;

function normalize(value: unknown): unknown {
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return value.map(normalize);
  if (value && typeof value === 'object') {
    const out: Plain = {};
    for (const [k, v] of Object.entries(value as Plain)) {
      out[k] = REDACTED_KEYS.has(k) ? '[redacted]' : normalize(v);
    }
    return out;
  }
  return value;
}

/** Returns only the fields that changed, so the audit trail shows exactly what was edited. */
export function diff(before: Plain | null | undefined, after: Plain | null | undefined): { old: Plain | null; new: Plain | null } {
  const b = (normalize(before ?? null) as Plain | null) ?? null;
  const a = (normalize(after ?? null) as Plain | null) ?? null;
  if (!b || !a) return { old: b, new: a };
  const oldOut: Plain = {};
  const newOut: Plain = {};
  for (const key of new Set([...Object.keys(b), ...Object.keys(a)])) {
    if (key === 'updatedAt' || key === 'version') continue;
    if (JSON.stringify(b[key]) !== JSON.stringify(a[key])) {
      oldOut[key] = b[key];
      newOut[key] = a[key];
    }
  }
  return { old: oldOut, new: newOut };
}

export interface AuditEntry {
  action: string;
  entityType: string;
  entityId?: string | null;
  branchId?: string | null;
  summary?: string;
  before?: Plain | null;
  after?: Plain | null;
  /** Organization override for platform actions acting on a tenant. */
  organizationId?: string | null;
}

/** Writes an audit record inside the caller's transaction: it commits or rolls back with the change itself. */
export async function audit(tx: Tx, auth: AuthContext, entry: AuditEntry): Promise<void> {
  const changes = diff(entry.before, entry.after);
  await tx
    .insertInto('auditLogs')
    .values({
      organizationId: entry.organizationId !== undefined ? entry.organizationId : auth.orgId,
      branchId: entry.branchId ?? null,
      userId: auth.userId || null,
      action: entry.action,
      entityType: entry.entityType,
      entityId: entry.entityId ?? null,
      summary: entry.summary ?? null,
      oldValues: changes.old ? JSON.stringify(changes.old) : null,
      newValues: changes.new ? JSON.stringify(changes.new) : null,
      ip: auth.ip,
      userAgent: auth.userAgent?.slice(0, 300) ?? null,
      requestId: auth.requestId,
    })
    .execute();
}
