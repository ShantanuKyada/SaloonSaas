import {
  maskEmail,
  maskPhone,
  type CustomerDetail,
  type CustomerInput,
  type SegmentFilter,
} from '@salon/shared';
import { sql, type RawBuilder } from 'kysely';
import { audit } from '../../core/audit.js';
import { branchFilter, hasPermission, type AuthContext } from '../../core/auth-context.js';
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

/**
 * The digits to look for in phone numbers, when the search looks like a phone number: 3+ digits and no letters
 * ("98765", "+91 98765 43210"). Text with letters is a name, code or email, so "Riya 2nd floor" or "E2E 1M4GB" does not
 * also bring up everyone whose number happens to contain those digits.
 */
export function phoneDigits(term: string): string {
  if (/\p{L}/u.test(term)) return '';
  const digits = term.replace(/\D/g, '');
  return digits.length >= 3 ? digits : '';
}

/** Search-box semantics: name, customer code, email, and mobile (any partial digits) when the search is a number. */
export function customerSearchCondition(term: string, alias = 'c'): RawBuilder<boolean> {
  const text = term.trim();
  const like = `%${text.replace(/[%_\\]/g, (m) => `\\${m}`)}%`;
  const digits = phoneDigits(text);
  const name = sql.ref(`${alias}.full_name`);
  const code = sql.ref(`${alias}.customer_code`);
  const email = sql.ref(`${alias}.email`);
  const mobile = sql.ref(`${alias}.mobile`);
  return digits
    ? sql<boolean>`(${name} ilike ${like} or ${code} ilike ${like} or ${email} ilike ${like} or ${mobile} like ${`%${digits}%`})`
    : sql<boolean>`(${name} ilike ${like} or ${code} ilike ${like} or ${email} ilike ${like})`;
}

// ───────────── Customers seen through some branches ─────────────
// A login limited to some branches sees the customers connected to them (registered or preferred there, or with a
// booking or bill there), with visits, spend and pending payments counted in those branches only. Finding someone by
// name or phone still searches the whole salon, so a customer of another branch can be booked here instead of being
// added twice; their profile then shows only what happened here.

/** The branches a customer screen is limited to: the one asked for, or the login's own; null = the whole salon. */
export function customerScope(auth: AuthContext, requestedBranchId?: string | null): string[] | null {
  if (requestedBranchId) return branchFilter(auth, requestedBranchId);
  return auth.allBranches ? null : branchFilter(auth);
}

const inBranches = (column: RawBuilder<unknown> | ReturnType<typeof sql.ref>, branches: readonly string[]) => sql<boolean>`${column} = any(${[...branches]}::uuid[])`;

/** Is the customer connected to one of these branches? */
export function customerInBranches(branches: readonly string[], alias = 'c'): RawBuilder<boolean> {
  const id = sql.ref(`${alias}.id`);
  return sql<boolean>`(${inBranches(sql.ref(`${alias}.registered_branch_id`), branches)} or ${inBranches(sql.ref(`${alias}.preferred_branch_id`), branches)}
    or exists (select 1 from appointments xa where xa.customer_id = ${id} and ${inBranches(sql.ref('xa.branch_id'), branches)})
    or exists (select 1 from invoices xi where xi.customer_id = ${id} and ${inBranches(sql.ref('xi.branch_id'), branches)}))`;
}

export interface CustomerMetrics {
  visits: RawBuilder<number>;
  spend: RawBuilder<number>;
  firstVisit: RawBuilder<Date | null>;
  lastVisit: RawBuilder<Date | null>;
  outstanding: RawBuilder<number>;
}

/**
 * Visits, spend, last visit and pending payment for list screens. The whole salon: the cached totals (the query must
 * join customer_stats as cs and customer_accounts as ca). Some branches: counted from their bookings and bills, by the
 * same rules as refreshCustomerStats.
 */
export function customerMetrics(branches: readonly string[] | null, alias = 'c'): CustomerMetrics {
  if (!branches) {
    return {
      visits: sql<number>`coalesce(cs.visit_count, 0)`,
      spend: sql<number>`coalesce(cs.lifetime_spend, 0)`,
      firstVisit: sql<Date | null>`cs.first_visit_at`,
      lastVisit: sql<Date | null>`cs.last_visit_at`,
      outstanding: sql<number>`greatest(coalesce(ca.balance, 0), 0)`,
    };
  }
  const id = sql.ref(`${alias}.id`);
  const appts = (what: RawBuilder<unknown>) => sql`(select ${what} from appointments ma where ma.customer_id = ${id} and ma.status = 'completed' and ${inBranches(sql.ref('ma.branch_id'), branches)})`;
  const bills = (what: RawBuilder<unknown>, extra: RawBuilder<unknown> = sql`true`) => sql`(select ${what} from invoices mi where mi.customer_id = ${id} and mi.status = 'issued' and ${inBranches(sql.ref('mi.branch_id'), branches)} and ${extra})`;
  return {
    visits: sql<number>`(${appts(sql`count(*)`)} + ${bills(sql`count(*)`, sql`mi.appointment_id is null`)})::int`,
    spend: sql<number>`coalesce(${bills(sql`sum(mi.grand_total)`)}, 0)::bigint`,
    firstVisit: sql<Date | null>`least(${appts(sql`min(coalesce(ma.completed_at, ma.start_at))`)}, ${bills(sql`min(mi.issued_at)`, sql`mi.appointment_id is null`)})`,
    lastVisit: sql<Date | null>`greatest(${appts(sql`max(coalesce(ma.completed_at, ma.start_at))`)}, ${bills(sql`max(mi.issued_at)`, sql`mi.appointment_id is null`)})`,
    outstanding: sql<number>`coalesce(${bills(sql`sum(mi.balance_due)`)}, 0)::bigint`,
  };
}

/** A customer's most-booked service or team member: the cached one for the whole salon (needs cs), else counted in some branches. */
export function customerFavourite(what: 'service' | 'staff', branches: readonly string[] | null, alias = 'c'): RawBuilder<string | null> {
  const [table, col, name, cached] = what === 'service' ? ['services', 'service_id', 'name', 'favorite_service_id'] : ['staff', 'staff_id', 'display_name', 'favorite_staff_id'];
  if (!branches) return sql<string | null>`(select x.${sql.raw(name)} from ${sql.raw(table)} x where x.id = cs.${sql.raw(cached)})`;
  return sql<string | null>`(select x.${sql.raw(name)} from invoice_items ii join invoices i on i.id = ii.invoice_id join ${sql.raw(table)} x on x.id = ii.${sql.raw(col)}
    where i.customer_id = ${sql.ref(`${alias}.id`)} and i.status = 'issued' and i.branch_id = any(${[...branches]}::uuid[])
    group by x.id, x.${sql.raw(name)} order by count(*) desc, max(i.issued_at) desc limit 1)`;
}

/** A customer's profile numbers counted in some branches only (the profile's "visits, spend, favourites" block). */
export async function customerStatsInBranches(tx: Tx, orgId: string, customerId: string, branches: readonly string[]) {
  const b = [...branches];
  const { rows } = await sql<{
    visitCount: number; lifetimeSpend: number; firstVisitAt: Date | null; lastVisitAt: Date | null; cancelledCount: number; noShowCount: number;
    favoriteServiceId: string | null; favoriteServiceName: string | null; favoriteStaffId: string | null; favoriteStaffName: string | null;
  }>`
    with visits as (
      select coalesce(a.completed_at, a.start_at) as ts from appointments a
       where a.organization_id = ${orgId} and a.customer_id = ${customerId} and a.status = 'completed' and a.branch_id = any(${b}::uuid[])
      union all
      select i.issued_at from invoices i
       where i.organization_id = ${orgId} and i.customer_id = ${customerId} and i.status = 'issued' and i.appointment_id is null and i.branch_id = any(${b}::uuid[])
    ),
    lines as (
      select ii.service_id, ii.staff_id, i.issued_at from invoice_items ii join invoices i on i.id = ii.invoice_id
       where i.organization_id = ${orgId} and i.customer_id = ${customerId} and i.status = 'issued' and i.branch_id = any(${b}::uuid[])
    ),
    fav_service as (select service_id from lines where service_id is not null group by service_id order by count(*) desc, max(issued_at) desc limit 1),
    fav_staff as (select staff_id from lines where staff_id is not null group by staff_id order by count(*) desc, max(issued_at) desc limit 1)
    select (select count(*) from visits where ts is not null)::int as "visitCount",
           (select coalesce(sum(grand_total), 0) from invoices where organization_id = ${orgId} and customer_id = ${customerId} and status = 'issued' and branch_id = any(${b}::uuid[]))::bigint as "lifetimeSpend",
           (select min(ts) from visits) as "firstVisitAt", (select max(ts) from visits) as "lastVisitAt",
           (select count(*) from appointments where organization_id = ${orgId} and customer_id = ${customerId} and status = 'cancelled' and branch_id = any(${b}::uuid[]))::int as "cancelledCount",
           (select count(*) from appointments where organization_id = ${orgId} and customer_id = ${customerId} and status = 'no_show' and branch_id = any(${b}::uuid[]))::int as "noShowCount",
           fs.id as "favoriteServiceId", fs.name as "favoriteServiceName", fst.id as "favoriteStaffId", fst.display_name as "favoriteStaffName"
      from (select 1) one
      left join services fs on fs.id = (select service_id from fav_service)
      left join staff fst on fst.id = (select staff_id from fav_staff)`.execute(tx);
  const r = rows[0]!;
  return { ...r, visitCount: Number(r.visitCount), lifetimeSpend: Number(r.lifetimeSpend), cancelledCount: Number(r.cancelledCount), noShowCount: Number(r.noShowCount) };
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
export function segmentQuery(tx: Tx, orgId: string, filter: SegmentFilter, branches: readonly string[] | null = null) {
  let q = tx
    .selectFrom('customers as c')
    .leftJoin('customerStats as cs', 'cs.customerId', 'c.id')
    .leftJoin('customerAccounts as ca', 'ca.customerId', 'c.id')
    .where('c.organizationId', '=', orgId)
    .where('c.status', '=', 'active');
  if (branches) q = q.where(customerInBranches(branches));
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
