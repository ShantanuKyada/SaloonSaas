import { normalizePhone } from '@salon/shared';
import type { Tx } from '../db/tenant.js';
import { AppError } from './errors.js';

/** Normalises a phone number to E.164 or raises a field-level validation error the form can highlight. */
export function normalizePhoneOrThrow(input: string, callingCode: string, field: string): string {
  const normalized = normalizePhone(input, callingCode || '91');
  if (!normalized) {
    throw new AppError(400, 'VALIDATION_ERROR', 'Please check the mobile number.', {
      issues: [{ path: field, message: 'Enter a valid mobile number (with country code if outside India)' }],
    });
  }
  return normalized;
}

export function optionalPhone(input: string | null | undefined, callingCode: string, field: string): string | null {
  return input ? normalizePhoneOrThrow(input, callingCode, field) : null;
}

const CALLING_CODES: Record<string, string> = { IN: '91', AE: '971', GB: '44', US: '1', SG: '65', AU: '61', NP: '977', LK: '94', BD: '880' };

export function callingCodeFor(country: string): string {
  return CALLING_CODES[country] ?? '91';
}

/** Organization facts every module needs (currency, time zone, calling code, settings). Cached per transaction call. */
export interface OrgContext {
  id: string;
  name: string;
  code: string;
  country: string;
  currency: string;
  timezone: string;
  taxLabel: string;
  callingCode: string;
}

export async function loadOrg(tx: Tx, orgId: string): Promise<OrgContext> {
  const org = await tx
    .selectFrom('organizations')
    .select(['id', 'name', 'code', 'country', 'currency', 'timezone', 'taxLabel'])
    .where('id', '=', orgId)
    .executeTakeFirst();
  if (!org) throw new AppError(404, 'NOT_FOUND', 'Salon account not found.');
  return { ...org, callingCode: callingCodeFor(org.country) };
}

export async function loadSettings(tx: Tx, orgId: string) {
  const settings = await tx.selectFrom('organizationSettings').selectAll().where('organizationId', '=', orgId).executeTakeFirst();
  if (!settings) throw new AppError(500, 'INTERNAL_ERROR', 'Salon settings are missing.');
  return settings;
}
export type OrgSettings = Awaited<ReturnType<typeof loadSettings>>;

export async function loadBranch(tx: Tx, orgId: string, branchId: string) {
  const branch = await tx
    .selectFrom('branches')
    .selectAll()
    .where('organizationId', '=', orgId)
    .where('id', '=', branchId)
    .executeTakeFirst();
  if (!branch) throw new AppError(404, 'NOT_FOUND', 'Branch could not be found.');
  return branch;
}
export type BranchRow = Awaited<ReturnType<typeof loadBranch>>;
