import { AGEING_BUCKETS, formatMoney, type LedgerStatement, type OutstandingCustomerRow } from '@salon/shared';
import { sql, type RawBuilder } from 'kysely';
import { audit } from '../../core/audit.js';
import { assertBranchAccess, branchFilter, requireOrgId, type AuthContext } from '../../core/auth-context.js';
import { AppError, notFound } from '../../core/errors.js';
import { localRangeToUtc, todayIn } from '../../core/time.js';
import { loadBranch, loadOrg, loadSettings } from '../../core/validation.js';
import type { Tx } from '../../db/tenant.js';
import { canSeeContact, customerSearchCondition, maskContact } from '../customers/service.js';
import { enqueueNotification } from '../notifications/outbox.js';

export interface OutstandingFilter {
  branchId?: string;
  asOf?: string | null;
  bucket?: 'd0_30' | 'd31_60' | 'd61_90' | 'd90_plus';
  minAmount?: number;
  search?: string;
  customerId?: string;
}

const bucketSql = (asOf: string): Record<string, RawBuilder<boolean>> => ({
  d0_30: sql<boolean>`(${asOf}::date - i.invoice_date) <= 30`,
  d31_60: sql<boolean>`(${asOf}::date - i.invoice_date) between 31 and 60`,
  d61_90: sql<boolean>`(${asOf}::date - i.invoice_date) between 61 and 90`,
  d90_plus: sql<boolean>`(${asOf}::date - i.invoice_date) > 90`,
});

export async function asOfDate(tx: Tx, orgId: string, asOf?: string | null): Promise<string> {
  if (asOf) return asOf;
  const org = await loadOrg(tx, orgId);
  return todayIn(org.timezone);
}

function openInvoices(tx: Tx, auth: AuthContext, orgId: string, f: OutstandingFilter, asOf: string) {
  let q = tx
    .selectFrom('invoices as i')
    .innerJoin('customers as c', 'c.id', 'i.customerId')
    .where('i.organizationId', '=', orgId)
    .where('i.status', '=', 'issued')
    .where('i.balanceDue', '>', 0)
    .where('i.invoiceDate', '<=', asOf)
    .where('i.branchId', 'in', branchFilter(auth, f.branchId));
  if (f.customerId) q = q.where('i.customerId', '=', f.customerId);
  if (f.search) q = q.where(customerSearchCondition(f.search));
  if (f.bucket) q = q.where(bucketSql(asOf)[f.bucket]!);
  return q;
}

export async function outstandingSummary(tx: Tx, auth: AuthContext, f: OutstandingFilter) {
  const orgId = requireOrgId(auth);
  const asOf = await asOfDate(tx, orgId, f.asOf);
  const total = await openInvoices(tx, auth, orgId, f, asOf)
    .select([
      sql<number>`coalesce(sum(i.balance_due), 0)`.as('total'),
      sql<number>`coalesce(sum(i.balance_due) filter (where i.due_date is not null and i.due_date < ${asOf}::date), 0)`.as('overdue'),
      sql<number>`count(distinct i.customer_id)`.as('customers'),
      sql<number>`count(*)`.as('invoices'),
      ...AGEING_BUCKETS.map((b, n) => sql<number>`coalesce(sum(i.balance_due) filter (where ${bucketSql(asOf)[b.key]}), 0)`.as(`bucket${n}`)),
    ])
    .executeTakeFirstOrThrow();
  const byBranch = await openInvoices(tx, auth, orgId, f, asOf)
    .innerJoin('branches as b', 'b.id', 'i.branchId')
    .select(['b.id as branchId', 'b.name as branchName', sql<number>`sum(i.balance_due)`.as('outstanding'), sql<number>`count(distinct i.customer_id)`.as('customers')])
    .groupBy(['b.id', 'b.name'])
    .orderBy(sql`sum(i.balance_due)`, 'desc')
    .execute();
  const advance = await tx
    .selectFrom('payments')
    .select(sql<number>`coalesce(sum(amount - allocated_amount - refunded_amount), 0)`.as('advance'))
    .where('organizationId', '=', orgId)
    .where('status', '=', 'completed')
    .where('branchId', 'in', branchFilter(auth, f.branchId))
    .executeTakeFirstOrThrow();
  return {
    asOf,
    totalOutstanding: Number(total.total),
    overdueOutstanding: Number(total.overdue),
    customersWithOutstanding: Number(total.customers),
    openInvoices: Number(total.invoices),
    advanceHeld: Number(advance.advance),
    ageing: AGEING_BUCKETS.map((b, n) => ({ key: b.key, label: b.label, amount: Number((total as unknown as Record<string, number>)[`bucket${n}`]) })),
    byBranch: byBranch.map((b) => ({ ...b, outstanding: Number(b.outstanding), customers: Number(b.customers) })),
  };
}

export async function outstandingCustomers(tx: Tx, auth: AuthContext, f: OutstandingFilter, page: { page: number; pageSize: number; sortBy?: string; sortDir?: string }) {
  const orgId = requireOrgId(auth);
  const settings = await loadSettings(tx, orgId);
  const asOf = await asOfDate(tx, orgId, f.asOf);
  const base = openInvoices(tx, auth, orgId, f, asOf);

  const grouped = base
    .leftJoin('customerAccounts as ca', 'ca.customerId', 'c.id')
    .select([
      'c.id as customerId',
      'c.customerCode',
      'c.fullName',
      'c.mobile',
      'c.creditLimit',
      sql<number>`greatest(-coalesce(ca.balance, 0), 0)`.as('advance'),
      sql<number>`sum(i.balance_due)`.as('outstanding'),
      sql<string>`min(i.invoice_date)`.as('oldestInvoiceDate'),
      sql<number>`count(*)`.as('invoiceCount'),
      ...AGEING_BUCKETS.map((b, n) => sql<number>`coalesce(sum(i.balance_due) filter (where ${bucketSql(asOf)[b.key]}), 0)`.as(`bucket${n}`)),
      sql<Date | null>`(select max(p.received_at) from payments p where p.customer_id = c.id and p.status = 'completed')`.as('lastPaymentAt'),
      sql<Date | null>`(select max(n.created_at) from notifications n where n.customer_id = c.id and n.event_type = 'outstanding_reminder' and n.status not in ('cancelled','skipped'))`.as('lastReminderAt'),
    ])
    .groupBy(['c.id', 'c.customerCode', 'c.fullName', 'c.mobile', 'c.creditLimit', 'ca.balance']);

  const minAmount = f.minAmount ?? 0;
  const filtered = minAmount > 0 ? grouped.having(sql<boolean>`sum(i.balance_due) >= ${minAmount}`) : grouped;

  const totalRows = await tx.selectFrom(filtered.as('x')).select((eb) => eb.fn.countAll<number>().as('n')).executeTakeFirstOrThrow();
  const sortMap: Record<string, string> = { outstanding: 'sum(i.balance_due)', name: 'c.full_name', oldest: 'min(i.invoice_date)' };
  const sort = sortMap[page.sortBy ?? 'outstanding'] ?? sortMap.outstanding!;
  const dir = page.sortDir === 'asc' ? sql`asc` : sql`desc`;
  const rows = await filtered
    .orderBy(sql`${sql.raw(sort)} ${dir}`)
    .orderBy('c.id')
    .limit(page.pageSize)
    .offset((page.page - 1) * page.pageSize)
    .execute();

  const visible = canSeeContact(auth, settings);
  const items: OutstandingCustomerRow[] = rows.map((r) =>
    maskContact(
      {
        customerId: r.customerId,
        customerCode: r.customerCode,
        fullName: r.fullName,
        mobile: r.mobile,
        outstanding: Number(r.outstanding),
        advance: Number(r.advance),
        oldestInvoiceDate: r.oldestInvoiceDate,
        invoiceCount: Number(r.invoiceCount),
        creditLimit: r.creditLimit,
        buckets: { d0_30: Number(r.bucket0), d31_60: Number(r.bucket1), d61_90: Number(r.bucket2), d90_plus: Number(r.bucket3) },
        lastReminderAt: r.lastReminderAt ? new Date(r.lastReminderAt).toISOString() : null,
        lastPaymentAt: r.lastPaymentAt ? new Date(r.lastPaymentAt).toISOString() : null,
      },
      visible,
    ),
  );
  return { items, total: totalRows.n };
}

export async function outstandingInvoices(tx: Tx, auth: AuthContext, f: OutstandingFilter, page: { page: number; pageSize: number }) {
  const orgId = requireOrgId(auth);
  const asOf = await asOfDate(tx, orgId, f.asOf);
  const base = openInvoices(tx, auth, orgId, f, asOf);
  const { n } = await base.select((eb) => eb.fn.countAll<number>().as('n')).executeTakeFirstOrThrow();
  const rows = await base
    .innerJoin('branches as b', 'b.id', 'i.branchId')
    .select([
      'i.id',
      'i.invoiceNumber',
      'i.invoiceDate',
      'i.dueDate',
      'b.name as branchName',
      'c.id as customerId',
      'c.fullName as customerName',
      'i.grandTotal',
      'i.amountPaid',
      'i.amountAdjusted',
      'i.balanceDue',
      'i.paymentStatus',
      'i.status',
      sql<number>`(${asOf}::date - i.invoice_date)`.as('ageDays'),
    ])
    .orderBy('i.invoiceDate')
    .orderBy('i.issuedAt')
    .limit(page.pageSize)
    .offset((page.page - 1) * page.pageSize)
    .execute();
  return {
    total: n,
    items: rows.map((r) => ({
      ...r,
      ageDays: Number(r.ageDays),
      bucket: AGEING_BUCKETS.find((b) => Number(r.ageDays) >= b.min && (b.max === null || Number(r.ageDays) <= b.max))!.key,
      overdue: r.dueDate !== null && r.dueDate < asOf,
    })),
  };
}

// ───────────── Customer ledger ─────────────
export async function ledgerStatement(tx: Tx, auth: AuthContext, args: { customerId: string; branchId?: string; from?: string; to?: string }): Promise<LedgerStatement> {
  const orgId = requireOrgId(auth);
  const settings = await loadSettings(tx, orgId);
  const org = await loadOrg(tx, orgId);
  const customer = await tx.selectFrom('customers').select(['id', 'fullName', 'customerCode', 'mobile', 'creditLimit']).where('organizationId', '=', orgId).where('id', '=', args.customerId).executeTakeFirst();
  if (!customer) throw notFound('Customer');
  const branches = branchFilter(auth, args.branchId);
  const range = args.from && args.to ? localRangeToUtc(args.from, args.to, org.timezone) : args.from ? { start: localRangeToUtc(args.from, args.from, org.timezone).start, end: null } : args.to ? { start: null, end: localRangeToUtc(args.to, args.to, org.timezone).end } : { start: null, end: null };

  const base = () => tx.selectFrom('ledgerEntries as l').where('l.organizationId', '=', orgId).where('l.customerId', '=', customer.id).where('l.branchId', 'in', branches);
  const opening = range.start ? await base().select(sql<number>`coalesce(sum(l.debit - l.credit), 0)`.as('net')).where('l.occurredAt', '<', range.start).executeTakeFirstOrThrow() : { net: 0 };
  let q = base().innerJoin('branches as b', 'b.id', 'l.branchId').select(['l.id', 'l.occurredAt', 'l.entryType', 'l.reference', 'l.description', 'b.name as branchName', 'l.debit', 'l.credit', 'l.sourceType', 'l.sourceId']);
  if (range.start) q = q.where('l.occurredAt', '>=', range.start);
  if (range.end) q = q.where('l.occurredAt', '<', range.end);
  const entries = await q.orderBy('l.occurredAt').orderBy('l.id').limit(5000).execute();

  let running = Number(opening.net);
  const rows = entries.map((e) => {
    running += e.debit - e.credit;
    return { id: e.id, occurredAt: e.occurredAt.toISOString(), entryType: e.entryType as LedgerStatement['rows'][number]['entryType'], reference: e.reference, description: e.description, branchName: e.branchName, debit: e.debit, credit: e.credit, balance: running, sourceType: e.sourceType, sourceId: e.sourceId };
  });
  const orgBranches = await tx.selectFrom('branches').select((eb) => eb.fn.countAll<number>().as('n')).where('organizationId', '=', orgId).where('status', '!=', 'archived').executeTakeFirstOrThrow();
  return {
    customer: { id: customer.id, fullName: customer.fullName, customerCode: customer.customerCode, mobile: maskContact({ mobile: customer.mobile }, canSeeContact(auth, settings)).mobile, creditLimit: customer.creditLimit },
    openingBalance: Number(opening.net),
    closingBalance: running,
    totalDebit: entries.reduce((a, e) => a + e.debit, 0),
    totalCredit: entries.reduce((a, e) => a + e.credit, 0),
    rows,
    scopedToBranches: branches.length < orgBranches.n,
  };
}

/**
 * Proves the books are consistent: cached balances equal the ledger, and the ledger equals open bills minus
 * unapplied payments. Any row returned here is a bug and is surfaced loudly (and checked by the test-suite).
 */
export async function reconcile(tx: Tx, orgId: string) {
  const balanceMismatch = await sql<{ customerId: string; ledger: number; cached: number }>`
    select c.id as "customerId", coalesce(l.net, 0)::bigint as ledger, coalesce(ca.balance, 0)::bigint as cached
      from customers c
      left join (select customer_id, sum(debit - credit) as net from ledger_entries where organization_id = ${orgId} group by customer_id) l on l.customer_id = c.id
      left join customer_accounts ca on ca.customer_id = c.id
     where c.organization_id = ${orgId} and coalesce(l.net, 0) <> coalesce(ca.balance, 0)`.execute(tx);
  const identityMismatch = await sql<{ customerId: string; ledger: number; derived: number }>`
    select c.id as "customerId", coalesce(ca.balance, 0)::bigint as ledger,
           (coalesce((select sum(balance_due) from invoices where customer_id = c.id and status = 'issued'), 0)
            - coalesce((select sum(amount - allocated_amount - refunded_amount) from payments where customer_id = c.id and status = 'completed'), 0))::bigint as derived
      from customers c left join customer_accounts ca on ca.customer_id = c.id
     where c.organization_id = ${orgId}
       and coalesce(ca.balance, 0) <> coalesce((select sum(balance_due) from invoices where customer_id = c.id and status = 'issued'), 0)
            - coalesce((select sum(amount - allocated_amount - refunded_amount) from payments where customer_id = c.id and status = 'completed'), 0)`.execute(tx);
  const invoiceMismatch = await sql<{ invoiceNumber: string }>`
    select i.invoice_number as "invoiceNumber" from invoices i
     where i.organization_id = ${orgId} and i.status = 'issued'
       and (i.amount_paid <> coalesce((select sum(amount) from payment_allocations where invoice_id = i.id and reversed_at is null), 0)
         or i.amount_adjusted <> coalesce((select sum(amount) from ledger_adjustments where invoice_id = i.id), 0)
         or i.balance_due <> i.grand_total - i.amount_paid - i.amount_adjusted)`.execute(tx);
  return {
    consistent: !balanceMismatch.rows.length && !identityMismatch.rows.length && !invoiceMismatch.rows.length,
    balanceMismatches: balanceMismatch.rows,
    identityMismatches: identityMismatch.rows,
    invoiceMismatches: invoiceMismatch.rows,
  };
}

// ───────────── Reminders ─────────────
export async function sendOutstandingReminder(tx: Tx, auth: AuthContext, customerId: string, mode: 'manual' | 'auto'): Promise<{ queued: number }> {
  const orgId = requireOrgId(auth);
  const [org, settings] = await Promise.all([loadOrg(tx, orgId), loadSettings(tx, orgId)]);
  const customer = await tx.selectFrom('customers').select(['id', 'fullName']).where('organizationId', '=', orgId).where('id', '=', customerId).where('status', '=', 'active').executeTakeFirst();
  if (!customer) throw notFound('Customer');
  const balance = (await tx.selectFrom('customerAccounts').select('balance').where('customerId', '=', customerId).executeTakeFirst())?.balance ?? 0;
  if (balance <= 0) throw new AppError(409, 'CONFLICT', 'This customer has nothing pending.');
  if (mode === 'auto' && (!settings.outstandingReminderEnabled || balance < settings.outstandingReminderMinAmount)) return { queued: 0 };

  // Do not spam: a minimum gap between reminders and a monthly cap, both configurable by the owner.
  const recent = await tx
    .selectFrom('notifications')
    .select(['createdAt'])
    .where('organizationId', '=', orgId)
    .where('customerId', '=', customerId)
    .where('eventType', '=', 'outstanding_reminder')
    .where('status', 'not in', ['cancelled', 'skipped'])
    .where('createdAt', '>', sql<Date>`now() - interval '30 days'`)
    .orderBy('createdAt', 'desc')
    .execute();
  const gapDays = mode === 'auto' ? settings.outstandingReminderIntervalDays : 1;
  const last = recent[0]?.createdAt;
  if (last && Date.now() - last.getTime() < gapDays * 86400_000) {
    if (mode === 'auto') return { queued: 0 };
    throw new AppError(429, 'RATE_LIMITED', `A reminder was already sent on ${last.toISOString().slice(0, 10)}. To avoid bothering the customer, wait at least a day between reminders.`);
  }
  if (recent.length >= settings.outstandingReminderMaxPerMonth) {
    if (mode === 'auto') return { queued: 0 };
    throw new AppError(429, 'RATE_LIMITED', `This customer has already received ${recent.length} reminders this month, which is the limit you set.`);
  }

  const lastBranch = await tx.selectFrom('ledgerEntries').select('branchId').where('customerId', '=', customerId).orderBy('id', 'desc').limit(1).executeTakeFirst();
  const branch = lastBranch ? await loadBranch(tx, orgId, lastBranch.branchId) : null;
  if (branch && mode === 'manual') assertBranchAccess(auth, branch.id);
  const queued = await enqueueNotification(tx, {
    orgId,
    branchId: branch?.id ?? null,
    customerId,
    eventType: 'outstanding_reminder',
    sourceType: 'customer',
    sourceId: customerId,
    dedupeKey: `outstanding:${customerId}:${new Date().toISOString().slice(0, 10)}`,
    createdBy: auth.userId || null,
    variables: { salonName: org.name, branchName: branch?.name ?? org.name, branchPhone: branch?.phone ?? '', amount: formatMoney(balance, org.currency) },
  });
  if (mode === 'manual' && queued === 0) {
    throw new AppError(409, 'CONFLICT', `No reminder could be queued: ${customer.fullName} has opted out, has no WhatsApp/email on file, or messaging is not set up yet.`);
  }
  if (queued > 0) await audit(tx, auth, { action: 'outstanding.reminder', entityType: 'customer', entityId: customerId, summary: `Pending-payment reminder queued for ${customer.fullName}`, after: { amount: balance, mode } });
  return { queued };
}

