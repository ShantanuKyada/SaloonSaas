import {
  maskEmail,
  maskPhone,
  type CustomerDetail,
  type CustomerInput,
  type SegmentFilter,
} from '@salon/shared';
import { sql, type RawBuilder } from 'kysely';
import { audit } from '../../core/audit.js';
import { hasPermission, type AuthContext } from '../../core/auth-context.js';
import { AppError, notFound } from '../../core/errors.js';
import { nextCustomerCode } from '../../core/sequences.js';
import { optionalPhone, type OrgContext, type OrgSettings } from '../../core/validation.js';
import type { Tx } from '../../db/tenant.js';

/** Receptionists and managers see contact details; staff only when the owner allows it (data minimisation). */
export function canSeeContact(auth: AuthContext, settings: Pick<OrgSettings, 'staffCanViewCustomerPhone'>): boolean {
  if (hasPermission(auth, 'customers.view_contact')) return true;
  return !!auth.staffId && settings.staffCanViewCustomerPhone;
}

export function maskContact<T extends { mobile?: string | null; whatsappNumber?: string | null; email?: string | null }>(row: T, visible: boolean): T {
  if (visible) return row;
  return {
    ...row,
    ...('mobile' in row ? { mobile: maskPhone(row.mobile) } : {}),
    ...('whatsappNumber' in row ? { whatsappNumber: maskPhone(row.whatsappNumber) } : {}),
    ...('email' in row ? { email: maskEmail(row.email) } : {}),
  };
}

/** Search-box semantics: name, mobile (any partial digits), customer code, email. */
export function customerSearchCondition(term: string, alias = 'c'): RawBuilder<boolean> {
  const text = term.trim();
  const like = `%${text.replace(/[%_\\]/g, (m) => `\\${m}`)}%`;
  const digits = text.replace(/\D/g, '');
  const name = sql.ref(`${alias}.full_name`);
  const code = sql.ref(`${alias}.customer_code`);
  const email = sql.ref(`${alias}.email`);
  const mobile = sql.ref(`${alias}.mobile`);
  return digits.length >= 3
    ? sql<boolean>`(${name} ilike ${like} or ${code} ilike ${like} or ${email} ilike ${like} or ${mobile} like ${`%${digits}%`})`
    : sql<boolean>`(${name} ilike ${like} or ${code} ilike ${like} or ${email} ilike ${like})`;
}

export async function findCustomerByMobile(tx: Tx, orgId: string, mobile: string) {
  return tx
    .selectFrom('customers')
    .select(['id', 'fullName', 'customerCode', 'mobile'])
    .where('organizationId', '=', orgId)
    .where('mobile', '=', mobile)
    .where('status', '!=', 'archived')
    .executeTakeFirst();
}

/** Creates a customer, refusing duplicates by mobile number with a pointer to the existing record. */
export async function createCustomerRecord(
  tx: Tx,
  auth: AuthContext,
  org: OrgContext,
  input: Partial<CustomerInput> & { fullName: string },
  options: { registeredBranchId?: string | null; consentSource?: 'in_person' | 'phone' | 'online_form' } = {},
): Promise<string> {
  const mobile = optionalPhone(input.mobile ?? null, org.callingCode, 'mobile');
  const whatsapp = optionalPhone(input.whatsappNumber ?? null, org.callingCode, 'whatsappNumber');
  if (mobile) {
    const existing = await findCustomerByMobile(tx, org.id, mobile);
    if (existing) {
      throw new AppError(409, 'DUPLICATE_CUSTOMER', `This mobile number already belongs to ${existing.fullName} (${existing.customerCode}).`, { existing });
    }
  }
  const code = await nextCustomerCode(tx, org.id);
  const consent = input.marketingConsent ?? false;
  const row = await tx
    .insertInto('customers')
    .values({
      organizationId: org.id,
      customerCode: code,
      fullName: input.fullName.trim(),
      mobile,
      whatsappNumber: whatsapp,
      email: input.email?.toLowerCase() ?? null,
      gender: input.gender ?? 'unspecified',
      dateOfBirth: input.dateOfBirth ?? null,
      anniversaryDate: input.anniversaryDate ?? null,
      address: input.address ?? null,
      city: input.city ?? null,
      preferredBranchId: input.preferredBranchId ?? null,
      preferredStaffId: input.preferredStaffId ?? null,
      registeredBranchId: options.registeredBranchId ?? input.preferredBranchId ?? null,
      source: input.source ?? 'walk_in',
      referredById: input.referredById ?? null,
      notes: input.notes ?? null,
      tags: input.tags ?? [],
      creditLimit: input.creditLimit ?? null,
      marketingConsent: consent,
      marketingConsentAt: consent ? new Date() : null,
      createdBy: auth.userId || null,
    })
    .returning('id')
    .executeTakeFirstOrThrow();
  // customer_accounts is written only by the ledger trigger (created on the first ledger entry); readers use left joins.
  await tx.insertInto('customerStats').values({ customerId: row.id, organizationId: org.id }).onConflict((oc) => oc.doNothing()).execute();
  if (consent) {
    await tx
      .insertInto('consentEvents')
      .values({ organizationId: org.id, customerId: row.id, consentType: 'marketing', granted: true, source: options.consentSource ?? 'in_person', recordedBy: auth.userId || null })
      .execute();
  }
  if (input.preferences?.length) await savePreferences(tx, org.id, row.id, input.preferences);
  await audit(tx, auth, {
    action: 'customer.created',
    entityType: 'customer',
    entityId: row.id,
    branchId: options.registeredBranchId ?? null,
    summary: `Customer ${input.fullName} (${code}) added`,
    after: { fullName: input.fullName, customerCode: code, mobile, email: input.email ?? null },
  });
  return row.id;
}

export async function savePreferences(
  tx: Tx,
  orgId: string,
  customerId: string,
  prefs: Array<{ channel: 'whatsapp' | 'email' | 'sms'; category: 'appointment' | 'reminder' | 'offers' | 'outstanding' | 'receipt'; enabled: boolean }>,
): Promise<void> {
  for (const p of prefs) {
    await tx
      .insertInto('customerNotificationPreferences')
      .values({ organizationId: orgId, customerId, channel: p.channel, category: p.category, enabled: p.enabled })
      .onConflict((oc) => oc.columns(['customerId', 'channel', 'category']).doUpdateSet({ enabled: p.enabled }))
      .execute();
  }
}

export async function loadCustomerDetail(tx: Tx, auth: AuthContext, orgId: string, customerId: string, settings: OrgSettings): Promise<CustomerDetail> {
  const c = await tx
    .selectFrom('customers as c')
    .leftJoin('customers as r', 'r.id', 'c.referredById')
    .selectAll('c')
    .select(['r.fullName as referredByName'])
    .where('c.organizationId', '=', orgId)
    .where('c.id', '=', customerId)
    .executeTakeFirst();
  if (!c) throw notFound('Customer');
  const prefs = await tx.selectFrom('customerNotificationPreferences').select(['channel', 'category', 'enabled']).where('customerId', '=', customerId).execute();
  const visible = canSeeContact(auth, settings);
  const detail: CustomerDetail = {
    id: c.id,
    customerCode: c.customerCode,
    fullName: c.fullName,
    mobile: c.mobile,
    whatsappNumber: c.whatsappNumber,
    email: c.email,
    gender: c.gender as CustomerDetail['gender'],
    dateOfBirth: c.dateOfBirth,
    anniversaryDate: c.anniversaryDate,
    address: c.address,
    city: c.city,
    preferredBranchId: c.preferredBranchId,
    preferredStaffId: c.preferredStaffId,
    registeredBranchId: c.registeredBranchId,
    source: c.source as CustomerDetail['source'],
    referredBy: c.referredById ? { id: c.referredById, fullName: c.referredByName ?? '' } : null,
    notes: c.notes,
    tags: c.tags,
    creditLimit: c.creditLimit,
    marketingConsent: c.marketingConsent,
    marketingConsentAt: c.marketingConsentAt?.toISOString() ?? null,
    status: c.status,
    registeredAt: c.registeredAt.toISOString(),
    contactMasked: !visible,
    preferences: prefs as CustomerDetail['preferences'],
  };
  return maskContact(detail, visible);
}

/**
 * Recomputes the cached CRM numbers for one customer from billing records (single source of truth).
 * Called inside the transaction that issues/voids an invoice or completes an appointment.
 */
export async function refreshCustomerStats(tx: Tx, orgId: string, customerId: string): Promise<void> {
  await sql`
    with spend as (
      select coalesce(sum(grand_total), 0)::bigint as total
        from invoices where organization_id = ${orgId} and customer_id = ${customerId} and status = 'issued'
    ),
    visits as (
      select ts, branch_id from (
        select coalesce(a.completed_at, a.start_at) as ts, a.branch_id
          from appointments a
         where a.organization_id = ${orgId} and a.customer_id = ${customerId} and a.status = 'completed'
        union all
        select i.issued_at, i.branch_id
          from invoices i
         where i.organization_id = ${orgId} and i.customer_id = ${customerId} and i.status = 'issued' and i.appointment_id is null
      ) v where ts is not null
    ),
    agg as (
      select count(*)::int as visit_count, min(ts) as first_at, max(ts) as last_at,
             (select branch_id from visits order by ts desc limit 1) as last_branch
        from visits
    ),
    fav_service as (
      select ii.service_id from invoice_items ii
        join invoices i on i.id = ii.invoice_id
       where i.organization_id = ${orgId} and i.customer_id = ${customerId} and i.status = 'issued' and ii.service_id is not null
       group by ii.service_id order by count(*) desc, max(i.issued_at) desc limit 1
    ),
    fav_staff as (
      select ii.staff_id from invoice_items ii
        join invoices i on i.id = ii.invoice_id
       where i.organization_id = ${orgId} and i.customer_id = ${customerId} and i.status = 'issued' and ii.staff_id is not null
       group by ii.staff_id order by count(*) desc, max(i.issued_at) desc limit 1
    ),
    outcomes as (
      select count(*) filter (where status = 'cancelled')::int as cancelled,
             count(*) filter (where status = 'no_show')::int as no_show
        from appointments where organization_id = ${orgId} and customer_id = ${customerId}
    )
    insert into customer_stats as cs (customer_id, organization_id, visit_count, lifetime_spend, first_visit_at, last_visit_at,
                                      last_branch_id, favorite_service_id, favorite_staff_id, cancelled_count, no_show_count, updated_at)
    select ${customerId}, ${orgId}, agg.visit_count, spend.total, agg.first_at, agg.last_at, agg.last_branch,
           (select service_id from fav_service), (select staff_id from fav_staff), outcomes.cancelled, outcomes.no_show, now()
      from agg, spend, outcomes
    on conflict (customer_id) do update set
      visit_count = excluded.visit_count, lifetime_spend = excluded.lifetime_spend, first_visit_at = excluded.first_visit_at,
      last_visit_at = excluded.last_visit_at, last_branch_id = excluded.last_branch_id,
      favorite_service_id = excluded.favorite_service_id, favorite_staff_id = excluded.favorite_staff_id,
      cancelled_count = excluded.cancelled_count, no_show_count = excluded.no_show_count, updated_at = now()`.execute(tx);
}

/** Customers matching a saved/ad-hoc segment. Used by the Segments screen and campaigns. */
export function segmentQuery(tx: Tx, orgId: string, filter: SegmentFilter) {
  let q = tx
    .selectFrom('customers as c')
    .leftJoin('customerStats as cs', 'cs.customerId', 'c.id')
    .leftJoin('customerAccounts as ca', 'ca.customerId', 'c.id')
    .where('c.organizationId', '=', orgId)
    .where('c.status', '=', 'active');
  if (filter.marketingConsentOnly) q = q.where('c.marketingConsent', '=', true);
  if (filter.branchId) {
    const branchId = filter.branchId;
    q = q.where(sql<boolean>`coalesce(cs.last_branch_id, c.preferred_branch_id, c.registered_branch_id) = ${branchId}`);
  }
  if (filter.minLifetimeSpend != null) q = q.where(sql<boolean>`coalesce(cs.lifetime_spend, 0) >= ${filter.minLifetimeSpend}`);
  if (filter.maxLifetimeSpend != null) q = q.where(sql<boolean>`coalesce(cs.lifetime_spend, 0) <= ${filter.maxLifetimeSpend}`);
  if (filter.minVisits != null) q = q.where(sql<boolean>`coalesce(cs.visit_count, 0) >= ${filter.minVisits}`);
  if (filter.maxVisits != null) q = q.where(sql<boolean>`coalesce(cs.visit_count, 0) <= ${filter.maxVisits}`);
  if (filter.inactiveForDays != null) {
    q = q.where(sql<boolean>`coalesce(cs.last_visit_at, c.registered_at) < now() - make_interval(days => ${filter.inactiveForDays})`);
  }
  if (filter.visitedWithinDays != null) {
    q = q.where(sql<boolean>`cs.last_visit_at >= now() - make_interval(days => ${filter.visitedWithinDays})`);
  }
  if (filter.favoriteServiceId) q = q.where('cs.favoriteServiceId', '=', filter.favoriteServiceId);
  if (filter.favoriteStaffId) q = q.where('cs.favoriteStaffId', '=', filter.favoriteStaffId);
  if (filter.minOutstanding != null) q = q.where(sql<boolean>`coalesce(ca.balance, 0) >= ${filter.minOutstanding}`);
  if (filter.gender) q = q.where('c.gender', '=', filter.gender);
  if (filter.birthdayMonth) q = q.where(sql<boolean>`extract(month from c.date_of_birth) = ${filter.birthdayMonth}`);
  if (filter.tag) q = q.where(sql<boolean>`${filter.tag} = any(c.tags)`);
  return q;
}
