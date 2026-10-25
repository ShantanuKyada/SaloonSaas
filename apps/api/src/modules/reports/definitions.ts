import { AGEING_BUCKETS, ATTENDANCE_STATUS_LABELS, LEDGER_ENTRY_LABELS, PAYMENT_METHOD_LABELS, type AttendanceStatus, type Permission, type ReportQuery } from '@salon/shared';
import { sql, type RawBuilder } from 'kysely';
import { hasPermission, type AuthContext } from '../../core/auth-context.js';
import { localDateConditions, localDateConditionsTz } from '../../core/sql.js';
import type { OrgContext } from '../../core/validation.js';
import type { Tx } from '../../db/tenant.js';
import { loadAttendanceDays, recomputeBranch } from '../attendance/service.js';
import { loadServiceDemand, loadStaffMetrics } from '../analytics/metrics.js';
import { ledgerStatement, outstandingCustomers, outstandingInvoices, outstandingSummary } from '../collections/service.js';
import { maskContact } from '../customers/service.js';
import { loadBranch } from '../../core/validation.js';

export type ColumnType = 'text' | 'number' | 'money' | 'percent' | 'date' | 'datetime' | 'minutes';
export interface ReportColumn {
  key: string;
  label: string;
  type: ColumnType;
}
export interface ReportResult {
  columns: ReportColumn[];
  rows: Array<Record<string, unknown>>;
  totals?: Record<string, unknown>;
  /** Total rows available (for paged detail reports). */
  total: number;
  note?: string;
}
export interface ReportContext {
  tx: Tx;
  auth: AuthContext;
  orgId: string;
  org: OrgContext;
  branches: string[];
  q: ReportQuery;
  /** Contact details (phone/email) visible to this user. */
  contactVisible: boolean;
  limit: number;
  offset: number;
}
export interface ReportDefinition {
  key: string;
  title: string;
  group: 'Appointments' | 'Revenue' | 'Customers' | 'Pending payments & collections' | 'Staff';
  description: string;
  permissions: Permission[];
  run: (ctx: ReportContext) => Promise<ReportResult>;
}

const col = (key: string, label: string, type: ColumnType = 'text'): ReportColumn => ({ key, label, type });
const n = (v: unknown) => Number(v ?? 0);
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const sum = (rows: readonly any[], pick: (r: any) => number): number => rows.reduce((a, r) => a + pick(r), 0);

function bucketExpr(column: string, groupBy: 'day' | 'week' | 'month'): RawBuilder<string> {
  const ref = sql.ref(column);
  if (groupBy === 'week') return sql<string>`to_char(date_trunc('week', ${ref}), 'YYYY-MM-DD')`;
  if (groupBy === 'month') return sql<string>`to_char(date_trunc('month', ${ref}), 'YYYY-MM-01')`;
  return sql<string>`${ref}::text`;
}

// Shared filters ---------------------------------------------------------------------------------------------
function apptFilters(c: ReportContext) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return (qb: any) => {
    let q = qb.where('a.organizationId', '=', c.orgId).where('a.branchId', 'in', c.branches).where('a.localDate', '>=', c.q.from).where('a.localDate', '<=', c.q.to);
    if (c.q.customerId) q = q.where('a.customerId', '=', c.q.customerId);
    if (c.q.staffId) q = q.where(sql<boolean>`exists (select 1 from appointment_items ai where ai.appointment_id = a.id and ai.staff_id = ${c.q.staffId})`);
    if (c.q.serviceId) q = q.where(sql<boolean>`exists (select 1 from appointment_items ai where ai.appointment_id = a.id and ai.service_id = ${c.q.serviceId})`);
    return q;
  };
}

function invoiceFilters(c: ReportContext) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return (qb: any) => {
    let q = qb.where('i.organizationId', '=', c.orgId).where('i.status', '=', 'issued').where('i.branchId', 'in', c.branches).where('i.invoiceDate', '>=', c.q.from).where('i.invoiceDate', '<=', c.q.to);
    if (c.q.customerId) q = q.where('i.customerId', '=', c.q.customerId);
    if (c.q.staffId) q = q.where(sql<boolean>`exists (select 1 from invoice_items ii where ii.invoice_id = i.id and ii.staff_id = ${c.q.staffId})`);
    if (c.q.serviceId) q = q.where(sql<boolean>`exists (select 1 from invoice_items ii where ii.invoice_id = i.id and ii.service_id = ${c.q.serviceId})`);
    return q;
  };
}

const apptSummaryCols = [col('booked', 'Booked', 'number'), col('completed', 'Completed', 'number'), col('cancelled', 'Cancelled', 'number'), col('noShow', 'No-shows', 'number')];
const apptAggregates = [
  sql<number>`count(*) filter (where a.status not in ('cancelled','no_show','waiting'))`.as('booked'),
  sql<number>`count(*) filter (where a.status = 'completed')`.as('completed'),
  sql<number>`count(*) filter (where a.status = 'cancelled')`.as('cancelled'),
  sql<number>`count(*) filter (where a.status = 'no_show')`.as('noShow'),
] as const;

// Detail list of appointments in a given terminal status.
async function lostAppointments(c: ReportContext, status: 'cancelled' | 'no_show'): Promise<ReportResult> {
  const base = (apptFilters(c)(c.tx.selectFrom('appointments as a').innerJoin('customers as cu', 'cu.id', 'a.customerId').innerJoin('branches as b', 'b.id', 'a.branchId'))).where('a.status', '=', status);
  const { total } = await base.select((eb: any) => eb.fn.countAll().as('total')).executeTakeFirstOrThrow();
  const rows = await base
    .leftJoin('users as u', 'u.id', 'a.cancelledBy')
    .select([
      'a.localDate as date',
      'a.bookingNumber',
      'cu.fullName as customer',
      'cu.mobile',
      'b.name as branch',
      sql<string>`coalesce((select string_agg(s.name, ', ' order by ai.sort_order) from appointment_items ai join services s on s.id = ai.service_id where ai.appointment_id = a.id), '')`.as('services'),
      sql<string>`coalesce((select string_agg(distinct st.display_name, ', ') from appointment_items ai join staff st on st.id = ai.staff_id where ai.appointment_id = a.id), '')`.as('staff'),
      'a.cancellationReason as reason',
      'u.fullName as cancelledBy',
      'a.startAt as scheduledFor',
    ])
    .orderBy('a.localDate', 'desc')
    .orderBy('a.startAt', 'desc')
    .limit(c.limit)
    .offset(c.offset)
    .execute();
  return {
    columns: [col('date', 'Date', 'date'), col('bookingNumber', 'Booking'), col('customer', 'Customer'), col('mobile', 'Mobile'), col('branch', 'Branch'), col('services', 'Services'), col('staff', 'Team member'), col('reason', 'Reason'), col('cancelledBy', 'Recorded by'), col('scheduledFor', 'Was booked for', 'datetime')],
    rows: rows.map((r: any) => maskContact({ ...r, scheduledFor: r.scheduledFor?.toISOString() ?? null }, c.contactVisible)),
    total: n(total),
  };
}

export const REPORTS: ReportDefinition[] = [
  // ───────────── Appointments ─────────────
  {
    key: 'appointments-daily',
    title: 'Daily appointments',
    group: 'Appointments',
    description: 'Bookings, completions, cancellations and no-shows by day, week or month.',
    permissions: ['reports.operations'],
    run: async (c) => {
      const bucket = bucketExpr('a.local_date', c.q.groupBy);
      const rows = await apptFilters(c)(c.tx.selectFrom('appointments as a'))
        .select([bucket.as('period'), ...apptAggregates, sql<number>`count(*) filter (where a.source = 'walk_in' and a.status not in ('cancelled','no_show'))`.as('walkIns'), sql<number>`count(*) filter (where a.source = 'online' and a.status not in ('cancelled','no_show'))`.as('online')])
        .groupBy(bucket)
        .orderBy(bucket)
        .execute();
      return {
        columns: [col('period', c.q.groupBy === 'day' ? 'Date' : c.q.groupBy === 'week' ? 'Week starting' : 'Month', 'date'), ...apptSummaryCols, col('walkIns', 'Walk-ins', 'number'), col('online', 'Online bookings', 'number')],
        rows: rows.map((r: any) => ({ period: r.period, booked: n(r.booked), completed: n(r.completed), cancelled: n(r.cancelled), noShow: n(r.noShow), walkIns: n(r.walkIns), online: n(r.online) })),
        totals: { period: 'Total', booked: sum(rows, (r: any) => n(r.booked)), completed: sum(rows, (r: any) => n(r.completed)), cancelled: sum(rows, (r: any) => n(r.cancelled)), noShow: sum(rows, (r: any) => n(r.noShow)), walkIns: sum(rows, (r: any) => n(r.walkIns)), online: sum(rows, (r: any) => n(r.online)) },
        total: rows.length,
      };
    },
  },
  {
    key: 'appointments-staff',
    title: 'Appointments by team member',
    group: 'Appointments',
    description: 'How many appointments each team member had, and how they ended.',
    permissions: ['reports.operations'],
    run: async (c) => {
      const metrics = await loadStaffMetrics(c.tx, c.orgId, c.branches, c.q, c.q.staffId ? [c.q.staffId] : undefined);
      return {
        columns: [col('staffName', 'Team member'), col('branchName', 'Branch'), col('totalAppointments', 'Appointments', 'number'), col('completedAppointments', 'Completed', 'number'), col('cancelledAppointments', 'Cancelled', 'number'), col('noShows', 'No-shows', 'number')],
        rows: metrics.map((m) => ({ ...m })),
        totals: { staffName: 'Total', totalAppointments: sum(metrics, (m) => m.totalAppointments), completedAppointments: sum(metrics, (m) => m.completedAppointments), cancelledAppointments: sum(metrics, (m) => m.cancelledAppointments), noShows: sum(metrics, (m) => m.noShows) },
        total: metrics.length,
      };
    },
  },
  {
    key: 'appointments-branch',
    title: 'Appointments by branch',
    group: 'Appointments',
    description: 'Bookings and outcomes for each branch.',
    permissions: ['reports.operations'],
    run: async (c) => {
      const rows = await apptFilters(c)(c.tx.selectFrom('appointments as a').innerJoin('branches as b', 'b.id', 'a.branchId')).select(['b.name as branch', ...apptAggregates]).groupBy(['b.id', 'b.name']).orderBy('b.name').execute();
      return {
        columns: [col('branch', 'Branch'), ...apptSummaryCols],
        rows: rows.map((r: any) => ({ branch: r.branch, booked: n(r.booked), completed: n(r.completed), cancelled: n(r.cancelled), noShow: n(r.noShow) })),
        totals: { branch: 'Total', booked: sum(rows, (r: any) => n(r.booked)), completed: sum(rows, (r: any) => n(r.completed)), cancelled: sum(rows, (r: any) => n(r.cancelled)), noShow: sum(rows, (r: any) => n(r.noShow)) },
        total: rows.length,
      };
    },
  },
  { key: 'appointments-cancellations', title: 'Cancellations', group: 'Appointments', description: 'Every cancelled booking with the reason given.', permissions: ['reports.operations'], run: (c) => lostAppointments(c, 'cancelled') },
  { key: 'appointments-no-shows', title: 'No-shows', group: 'Appointments', description: 'Customers who booked but did not come.', permissions: ['reports.operations'], run: (c) => lostAppointments(c, 'no_show') },

  // ───────────── Revenue ─────────────
  {
    key: 'revenue-daily',
    title: 'Revenue',
    group: 'Revenue',
    description: 'Billing by day, week or month: bills, discounts, tax and revenue.',
    permissions: ['reports.financial'],
    run: async (c) => {
      const bucket = bucketExpr('i.invoice_date', c.q.groupBy);
      const rows = await invoiceFilters(c)(c.tx.selectFrom('invoices as i'))
        .select([bucket.as('period'), sql<number>`count(*)`.as('bills'), sql<number>`sum(i.subtotal)`.as('subtotal'), sql<number>`sum(i.discount_total)`.as('discount'), sql<number>`sum(i.tax_total)`.as('tax'), sql<number>`sum(i.grand_total - i.tax_total)`.as('revenue'), sql<number>`sum(i.grand_total)`.as('billed')])
        .groupBy(bucket)
        .orderBy(bucket)
        .execute();
      const mapped = rows.map((r: any) => ({ period: r.period, bills: n(r.bills), subtotal: n(r.subtotal), discount: n(r.discount), tax: n(r.tax), revenue: n(r.revenue), billed: n(r.billed), averageTicket: n(r.bills) ? Math.round(n(r.revenue) / n(r.bills)) : 0 }));
      const t = { bills: sum(mapped, (r) => r.bills), subtotal: sum(mapped, (r) => r.subtotal), discount: sum(mapped, (r) => r.discount), tax: sum(mapped, (r) => r.tax), revenue: sum(mapped, (r) => r.revenue), billed: sum(mapped, (r) => r.billed) };
      return {
        columns: [col('period', c.q.groupBy === 'day' ? 'Date' : c.q.groupBy === 'week' ? 'Week starting' : 'Month', 'date'), col('bills', 'Bills', 'number'), col('subtotal', 'Before discount', 'money'), col('discount', 'Discounts', 'money'), col('tax', 'Tax', 'money'), col('revenue', 'Revenue (excl. tax)', 'money'), col('billed', 'Total billed', 'money'), col('averageTicket', 'Average bill', 'money')],
        rows: mapped,
        totals: { period: 'Total', ...t, averageTicket: t.bills ? Math.round(t.revenue / t.bills) : 0 },
        total: mapped.length,
        note: 'Revenue excludes tax. Package sales count when sold.',
      };
    },
  },
  {
    key: 'revenue-services',
    title: 'Revenue by service',
    group: 'Revenue',
    description: 'Bookings, revenue and average price for each service.',
    permissions: ['reports.financial'],
    run: async (c) => {
      const rows = (await loadServiceDemand(c.tx, c.orgId, c.branches, c.q)).filter((s) => (!c.q.serviceId || s.serviceId === c.q.serviceId) && (s.bookings > 0 || s.billedQuantity > 0));
      return {
        columns: [col('name', 'Service'), col('category', 'Category'), col('bookings', 'Bookings', 'number'), col('billedQuantity', 'Times billed', 'number'), col('revenue', 'Revenue (excl. tax)', 'money'), col('averageTicket', 'Average price', 'money'), col('revenueSharePercent', 'Share of revenue', 'percent'), col('topStaff', 'Most often done by')],
        rows: rows.map((r) => ({ ...r, topStaff: r.topStaff ? `${r.topStaff.name} (${r.topStaff.count})` : '' })),
        totals: { name: 'Total', bookings: sum(rows, (r) => r.bookings), billedQuantity: sum(rows, (r) => r.billedQuantity), revenue: sum(rows, (r) => r.revenue) },
        total: rows.length,
      };
    },
  },
  {
    key: 'revenue-branches',
    title: 'Revenue by branch',
    group: 'Revenue',
    description: 'Billing and average bill for each branch.',
    permissions: ['reports.financial'],
    run: async (c) => {
      const rows = await invoiceFilters(c)(c.tx.selectFrom('invoices as i').innerJoin('branches as b', 'b.id', 'i.branchId'))
        .select(['b.name as branch', sql<number>`count(*)`.as('bills'), sql<number>`count(distinct i.customer_id)`.as('customers'), sql<number>`sum(i.discount_total)`.as('discount'), sql<number>`sum(i.grand_total - i.tax_total)`.as('revenue')])
        .groupBy(['b.id', 'b.name'])
        .orderBy('b.name')
        .execute();
      const mapped = rows.map((r: any) => ({ branch: r.branch, bills: n(r.bills), customers: n(r.customers), discount: n(r.discount), revenue: n(r.revenue), averageTicket: n(r.bills) ? Math.round(n(r.revenue) / n(r.bills)) : 0 }));
      return {
        columns: [col('branch', 'Branch'), col('bills', 'Bills', 'number'), col('customers', 'Customers served', 'number'), col('discount', 'Discounts', 'money'), col('revenue', 'Revenue (excl. tax)', 'money'), col('averageTicket', 'Average bill', 'money')],
        rows: mapped,
        totals: { branch: 'Total', bills: sum(mapped, (r) => r.bills), discount: sum(mapped, (r) => r.discount), revenue: sum(mapped, (r) => r.revenue) },
        total: mapped.length,
      };
    },
  },
  {
    key: 'revenue-staff',
    title: 'Service revenue by team member',
    group: 'Revenue',
    description: 'Revenue from the services each team member performed.',
    permissions: ['reports.financial', 'reports.staff'],
    run: async (c) => staffRevenue(c),
  },

  // ───────────── Customers ─────────────
  {
    key: 'customers-new',
    title: 'New customers',
    group: 'Customers',
    description: 'Customers who joined in the period and where they came from.',
    permissions: ['reports.operations'],
    run: async (c) => {
      let base = c.tx.selectFrom('customers as cu').leftJoin('branches as b', 'b.id', 'cu.registeredBranchId').where('cu.organizationId', '=', c.orgId).where('cu.status', '!=', 'archived');
      for (const cond of localDateConditionsTz('cu.registered_at', c.org.timezone, c.q.from, c.q.to)) base = base.where(cond);
      const { total } = await base.select((eb) => eb.fn.countAll<number>().as('total')).executeTakeFirstOrThrow();
      const rows = await base.select(['cu.customerCode', 'cu.fullName', 'cu.mobile', 'cu.source', 'cu.registeredAt', 'b.name as branch']).orderBy('cu.registeredAt', 'desc').limit(c.limit).offset(c.offset).execute();
      return {
        columns: [col('customerCode', 'Code'), col('fullName', 'Name'), col('mobile', 'Mobile'), col('source', 'How they found us'), col('registeredAt', 'Joined', 'datetime'), col('branch', 'Branch')],
        rows: rows.map((r) => maskContact({ ...r, registeredAt: r.registeredAt.toISOString() }, c.contactVisible)),
        total: n(total),
      };
    },
  },
  {
    key: 'customers-returning',
    title: 'Returning customers',
    group: 'Customers',
    description: 'Customers who visited in the period and had visited before.',
    permissions: ['reports.operations'],
    run: async (c) => {
      const rows = await c.tx
        .selectFrom('invoices as i')
        .innerJoin('customers as cu', 'cu.id', 'i.customerId')
        .select(['cu.customerCode', 'cu.fullName', 'cu.mobile', sql<number>`count(*)`.as('visits'), sql<number>`sum(i.grand_total - i.tax_total)`.as('spend'), sql<string>`max(i.invoice_date)`.as('lastVisit')])
        .where('i.organizationId', '=', c.orgId)
        .where('i.status', '=', 'issued')
        .where('i.branchId', 'in', c.branches)
        .where('i.invoiceDate', '>=', c.q.from)
        .where('i.invoiceDate', '<=', c.q.to)
        .where(sql<boolean>`exists (select 1 from invoices p where p.customer_id = i.customer_id and p.status = 'issued' and p.invoice_date < ${c.q.from}::date)`)
        .groupBy(['cu.id', 'cu.customerCode', 'cu.fullName', 'cu.mobile'])
        .orderBy(sql`sum(i.grand_total - i.tax_total)`, 'desc')
        .limit(c.limit)
        .offset(c.offset)
        .execute();
      return {
        columns: [col('customerCode', 'Code'), col('fullName', 'Name'), col('mobile', 'Mobile'), col('visits', 'Visits in period', 'number'), col('spend', 'Spend (excl. tax)', 'money'), col('lastVisit', 'Last visit', 'date')],
        rows: rows.map((r) => maskContact({ ...r, visits: n(r.visits), spend: n(r.spend) }, c.contactVisible)),
        total: rows.length < c.limit ? c.offset + rows.length : c.offset + rows.length + 1,
      };
    },
  },
  {
    key: 'customers-inactive',
    title: 'Inactive customers',
    group: 'Customers',
    description: 'Customers who have not visited for a while (choose how many days).',
    permissions: ['reports.operations'],
    run: async (c) => {
      const base = c.tx
        .selectFrom('customers as cu')
        .innerJoin('customerStats as cs', 'cs.customerId', 'cu.id')
        .leftJoin('customerAccounts as ca', 'ca.customerId', 'cu.id')
        .where('cu.organizationId', '=', c.orgId)
        .where('cu.status', '=', 'active')
        .where('cs.visitCount', '>', 0)
        .where(sql<boolean>`cs.last_visit_at < now() - make_interval(days => ${c.q.inactiveDays})`);
      const { total } = await base.select((eb) => eb.fn.countAll<number>().as('total')).executeTakeFirstOrThrow();
      const rows = await base
        .select(['cu.customerCode', 'cu.fullName', 'cu.mobile', 'cu.marketingConsent', 'cs.lastVisitAt', 'cs.visitCount', 'cs.lifetimeSpend', sql<number>`greatest(coalesce(ca.balance, 0), 0)`.as('outstanding'), sql<number>`extract(day from now() - cs.last_visit_at)::int`.as('daysSince')])
        .orderBy('cs.lifetimeSpend', 'desc')
        .limit(c.limit)
        .offset(c.offset)
        .execute();
      return {
        columns: [col('customerCode', 'Code'), col('fullName', 'Name'), col('mobile', 'Mobile'), col('lastVisitAt', 'Last visit', 'date'), col('daysSince', 'Days since', 'number'), col('visitCount', 'Visits', 'number'), col('lifetimeSpend', 'Lifetime spend', 'money'), col('outstanding', 'Pending payment', 'money'), col('marketingConsent', 'OK to send offers')],
        rows: rows.map((r) => maskContact({ ...r, lastVisitAt: r.lastVisitAt?.toISOString().slice(0, 10) ?? null, daysSince: n(r.daysSince), outstanding: n(r.outstanding), marketingConsent: r.marketingConsent ? 'Yes' : 'No' }, c.contactVisible)),
        total: n(total),
        note: `No visit for at least ${c.q.inactiveDays} days.`,
      };
    },
  },
  {
    key: 'customers-high-value',
    title: 'High-value customers',
    group: 'Customers',
    description: 'Top customers by lifetime spend.',
    permissions: ['reports.operations', 'reports.financial'],
    run: async (c) => {
      const rows = await c.tx
        .selectFrom('customerStats as cs')
        .innerJoin('customers as cu', 'cu.id', 'cs.customerId')
        .leftJoin('services as fs', 'fs.id', 'cs.favoriteServiceId')
        .leftJoin('staff as fst', 'fst.id', 'cs.favoriteStaffId')
        .select(['cu.customerCode', 'cu.fullName', 'cu.mobile', 'cs.visitCount', 'cs.lifetimeSpend', 'cs.lastVisitAt', 'fs.name as favoriteService', 'fst.displayName as favoriteStaff', sql<number>`extract(day from now() - cs.last_visit_at)::int`.as('daysSince')])
        .where('cs.organizationId', '=', c.orgId)
        .where('cu.status', '=', 'active')
        .where('cs.lifetimeSpend', '>', 0)
        .orderBy('cs.lifetimeSpend', 'desc')
        .limit(Math.min(c.limit, 200))
        .execute();
      return {
        columns: [col('customerCode', 'Code'), col('fullName', 'Name'), col('mobile', 'Mobile'), col('lifetimeSpend', 'Lifetime spend', 'money'), col('visitCount', 'Visits', 'number'), col('averageVisit', 'Average visit', 'money'), col('daysSince', 'Days since last visit', 'number'), col('favoriteService', 'Favourite service'), col('favoriteStaff', 'Favourite team member')],
        rows: rows.map((r) => maskContact({ ...r, averageVisit: r.visitCount ? Math.round(r.lifetimeSpend / r.visitCount) : 0, daysSince: r.lastVisitAt ? n(r.daysSince) : null }, c.contactVisible)),
        total: rows.length,
      };
    },
  },

  // ───────────── Pending payments & collections ─────────────
  {
    key: 'finance-collections',
    title: 'Collection summary',
    group: 'Pending payments & collections',
    description: 'Money received by payment method, settlement of earlier credit, advances and refunds.',
    permissions: ['reports.financial'],
    run: async (c) => {
      const filters = (qb: any) => {
        let q = qb.where('p.organizationId', '=', c.orgId).where('p.status', '=', 'completed').where('p.branchId', 'in', c.branches);
        for (const cond of localDateConditions('p.received_at', 'b.timezone', c.q.from, c.q.to)) q = q.where(cond);
        if (c.q.method) q = q.where('p.method', '=', c.q.method);
        if (c.q.receivedBy) q = q.where('p.receivedBy', '=', c.q.receivedBy);
        if (c.q.customerId) q = q.where('p.customerId', '=', c.q.customerId);
        return q;
      };
      const rows = await filters(c.tx.selectFrom('payments as p').innerJoin('branches as b', 'b.id', 'p.branchId'))
        .select([
          'p.method',
          sql<number>`count(*)`.as('payments'),
          sql<number>`sum(p.amount)`.as('amount'),
          sql<number>`coalesce(sum(p.refunded_amount), 0)`.as('refunds'),
          sql<number>`coalesce(sum((select sum(pa.amount) from payment_allocations pa join invoices i on i.id = pa.invoice_id where pa.payment_id = p.id and pa.reversed_at is null and i.invoice_date < (p.received_at at time zone b.timezone)::date)), 0)`.as('creditSettlement'),
          sql<number>`coalesce(sum(p.amount - p.allocated_amount - p.refunded_amount), 0)`.as('advance'),
        ])
        .groupBy('p.method')
        .execute();
      const order = ['cash', 'upi', 'card', 'bank_transfer', 'online', 'other'];
      const mapped = rows
        .map((r: any) => ({ method: PAYMENT_METHOD_LABELS[r.method as keyof typeof PAYMENT_METHOD_LABELS] ?? r.method, key: r.method, payments: n(r.payments), amount: n(r.amount), creditSettlement: n(r.creditSettlement), advance: n(r.advance), refunds: n(r.refunds), net: n(r.amount) - n(r.refunds) }))
        .filter((r: any) => (c.q.collectionType === 'credit_settlement' ? r.creditSettlement > 0 : c.q.collectionType === 'advance' ? r.advance > 0 : true))
        .sort((a: any, b: any) => order.indexOf(a.key) - order.indexOf(b.key));
      const t = { payments: sum(mapped, (r: any) => r.payments), amount: sum(mapped, (r: any) => r.amount), creditSettlement: sum(mapped, (r: any) => r.creditSettlement), advance: sum(mapped, (r: any) => r.advance), refunds: sum(mapped, (r: any) => r.refunds) };
      const byMethod = Object.fromEntries(mapped.map((r: any) => [`${r.key}Total`, r.amount]));
      return {
        columns: [col('method', 'Payment method'), col('payments', 'Payments', 'number'), col('amount', 'Collected', 'money'), col('creditSettlement', 'Of which: earlier credit settled', 'money'), col('advance', 'Of which: kept as advance', 'money'), col('refunds', 'Refunds', 'money'), col('net', 'Net', 'money')],
        rows: mapped,
        totals: { method: 'Total', ...t, net: t.amount - t.refunds, ...byMethod },
        total: mapped.length,
      };
    },
  },
  {
    key: 'finance-collection-details',
    title: 'Collection details',
    group: 'Pending payments & collections',
    description: 'Every payment received with receipt number, method and who took it.',
    permissions: ['reports.financial'],
    run: async (c) => {
      let base = c.tx
        .selectFrom('payments as p')
        .innerJoin('branches as b', 'b.id', 'p.branchId')
        .innerJoin('customers as cu', 'cu.id', 'p.customerId')
        .innerJoin('users as u', 'u.id', 'p.receivedBy')
        .where('p.organizationId', '=', c.orgId)
        .where('p.branchId', 'in', c.branches);
      for (const cond of localDateConditions('p.received_at', 'b.timezone', c.q.from, c.q.to)) base = base.where(cond);
      if (c.q.method) base = base.where('p.method', '=', c.q.method);
      if (c.q.receivedBy) base = base.where('p.receivedBy', '=', c.q.receivedBy);
      if (c.q.customerId) base = base.where('p.customerId', '=', c.q.customerId);
      if (c.q.collectionType === 'advance') base = base.where(sql<boolean>`p.amount - p.allocated_amount - p.refunded_amount > 0`);
      const { total } = await base.select((eb) => eb.fn.countAll<number>().as('total')).executeTakeFirstOrThrow();
      const rows = await base
        .select(['p.receivedAt', 'p.receiptNumber', 'cu.fullName as customer', 'b.name as branch', 'p.method', 'p.amount', 'p.allocatedAmount', 'p.refundedAmount', 'p.status', 'u.fullName as receivedBy', 'p.reference'])
        .orderBy('p.receivedAt', 'desc')
        .limit(c.limit)
        .offset(c.offset)
        .execute();
      return {
        columns: [col('receivedAt', 'Received', 'datetime'), col('receiptNumber', 'Receipt'), col('customer', 'Customer'), col('branch', 'Branch'), col('method', 'Method'), col('amount', 'Amount', 'money'), col('applied', 'Applied to bills', 'money'), col('advance', 'Kept as advance', 'money'), col('refundedAmount', 'Refunded', 'money'), col('status', 'Status'), col('receivedBy', 'Received by'), col('reference', 'Reference')],
        rows: rows.map((r) => ({ ...r, receivedAt: r.receivedAt.toISOString(), method: PAYMENT_METHOD_LABELS[r.method as keyof typeof PAYMENT_METHOD_LABELS] ?? r.method, applied: r.allocatedAmount, advance: r.status === 'void' ? 0 : r.amount - r.allocatedAmount - r.refundedAmount, status: r.status === 'void' ? 'Cancelled' : 'Received' })),
        total: n(total),
      };
    },
  },
  {
    key: 'finance-outstanding',
    title: 'Pending payments by customer',
    group: 'Pending payments & collections',
    description: 'Who owes what, with ageing (0–30, 31–60, 61–90, 90+ days).',
    permissions: ['reports.financial', 'ledger.view'],
    run: async (c) => {
      const { items, total } = await outstandingCustomers(c.tx, c.auth, { asOf: c.q.to, branchId: c.q.branchId, customerId: c.q.customerId }, { page: 1, pageSize: Math.min(c.limit + c.offset, 5000) });
      const rows = items.slice(c.offset, c.offset + c.limit).map((r) => ({ ...r, ...r.buckets }));
      return {
        columns: [col('customerCode', 'Code'), col('fullName', 'Customer'), col('mobile', 'Mobile'), col('d0_30', '0–30 days', 'money'), col('d31_60', '31–60 days', 'money'), col('d61_90', '61–90 days', 'money'), col('d90_plus', '90+ days', 'money'), col('outstanding', 'Total pending', 'money'), col('oldestInvoiceDate', 'Oldest bill', 'date'), col('advance', 'Advance held', 'money')],
        rows,
        totals: { fullName: 'Total', outstanding: sum(items, (r) => r.outstanding), d0_30: sum(items, (r) => r.buckets.d0_30), d31_60: sum(items, (r) => r.buckets.d31_60), d61_90: sum(items, (r) => r.buckets.d61_90), d90_plus: sum(items, (r) => r.buckets.d90_plus) },
        total,
        note: `As of ${c.q.to}.`,
      };
    },
  },
  {
    key: 'finance-outstanding-details',
    title: 'Pending payments by bill',
    group: 'Pending payments & collections',
    description: 'Each unpaid or part-paid bill with its age.',
    permissions: ['reports.financial', 'ledger.view'],
    run: async (c) => {
      const page = Math.floor(c.offset / c.limit) + 1;
      const { items, total } = await outstandingInvoices(c.tx, c.auth, { asOf: c.q.to, branchId: c.q.branchId, customerId: c.q.customerId }, { page, pageSize: c.limit });
      return {
        columns: [col('invoiceNumber', 'Bill'), col('invoiceDate', 'Date', 'date'), col('dueDate', 'Due', 'date'), col('customerName', 'Customer'), col('branchName', 'Branch'), col('grandTotal', 'Bill total', 'money'), col('amountPaid', 'Paid', 'money'), col('balanceDue', 'Pending', 'money'), col('ageDays', 'Days old', 'number')],
        rows: items,
        total,
      };
    },
  },
  {
    key: 'finance-ageing',
    title: 'Ageing report',
    group: 'Pending payments & collections',
    description: 'Pending amounts by age for each branch.',
    permissions: ['reports.financial', 'ledger.view'],
    run: async (c) => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const out: Array<Record<string, any>> = [];
      for (const branchId of c.branches) {
        const branch = await loadBranch(c.tx, c.orgId, branchId);
        const s = await outstandingSummary(c.tx, c.auth, { branchId, asOf: c.q.to });
        out.push({ branch: branch.name, ...Object.fromEntries(s.ageing.map((a) => [a.key, a.amount])), total: s.totalOutstanding, overdue: s.overdueOutstanding });
      }
      return {
        columns: [col('branch', 'Branch'), ...AGEING_BUCKETS.map((b) => col(b.key, b.label, 'money')), col('total', 'Total pending', 'money'), col('overdue', 'Past due date', 'money')],
        rows: out,
        totals: { branch: 'Total', ...Object.fromEntries(AGEING_BUCKETS.map((b) => [b.key, sum(out, (r: any) => n(r[b.key]))])), total: sum(out, (r) => r.total), overdue: sum(out, (r) => r.overdue) },
        total: out.length,
        note: `As of ${c.q.to}.`,
      };
    },
  },
  {
    key: 'finance-ledger',
    title: 'Customer ledger',
    group: 'Pending payments & collections',
    description: 'Every bill, payment and adjustment for one customer, with a running balance. Choose a customer.',
    permissions: ['reports.financial', 'ledger.view'],
    run: async (c) => {
      if (!c.q.customerId) return { columns: [], rows: [], total: 0, note: 'Choose a customer to see their ledger.' };
      const s = await ledgerStatement(c.tx, c.auth, { customerId: c.q.customerId, branchId: c.q.branchId, from: c.q.from, to: c.q.to });
      return {
        columns: [col('occurredAt', 'Date', 'datetime'), col('reference', 'Reference'), col('description', 'Description'), col('branchName', 'Branch'), col('debit', 'Billed', 'money'), col('credit', 'Paid / adjusted', 'money'), col('balance', 'Balance', 'money')],
        rows: [{ occurredAt: null, reference: '', description: 'Opening balance', branchName: '', debit: null, credit: null, balance: s.openingBalance }, ...s.rows.map((r) => ({ ...r, description: `${LEDGER_ENTRY_LABELS[r.entryType]}: ${r.description}` }))],
        totals: { description: 'Total', debit: s.totalDebit, credit: s.totalCredit, balance: s.closingBalance },
        total: s.rows.length + 1,
        note: s.scopedToBranches ? 'Shows only the branches you can access.' : undefined,
      };
    },
  },

  // ───────────── Staff ─────────────
  {
    key: 'staff-attendance',
    title: 'Attendance',
    group: 'Staff',
    description: 'Present, late, absent, leave and missing-punch days for each team member.',
    permissions: ['reports.staff', 'attendance.view'],
    run: async (c) => {
      for (const branchId of c.branches) await recomputeBranch(c.tx, c.orgId, await loadBranch(c.tx, c.orgId, branchId), c.q.from, c.q.to);
      const days = await loadAttendanceDays(c.tx, c.orgId, c.branches, { from: c.q.from, to: c.q.to, staffId: c.q.staffId });
      const byStaff = new Map<string, { staff: string; counts: Record<string, number>; worked: number; late: number }>();
      for (const d of days) {
        const row = byStaff.get(d.staffId) ?? { staff: d.staffName, counts: {}, worked: 0, late: 0 };
        row.counts[d.status] = (row.counts[d.status] ?? 0) + 1;
        row.worked += d.workedMinutes;
        row.late += d.lateMinutes;
        byStaff.set(d.staffId, row);
      }
      const cnt = (r: { counts: Record<string, number> }, ...s: AttendanceStatus[]) => s.reduce((a, k) => a + (r.counts[k] ?? 0), 0);
      const rows = [...byStaff.values()].sort((a, b) => a.staff.localeCompare(b.staff)).map((r) => ({ staff: r.staff, present: cnt(r, 'present', 'half_day'), late: cnt(r, 'late'), absent: cnt(r, 'absent'), onLeave: cnt(r, 'on_leave'), missingPunch: cnt(r, 'missing_punch'), off: cnt(r, 'weekly_off', 'holiday'), hoursWorked: Number((r.worked / 60).toFixed(1)), lateMinutes: r.late }));
      return {
        columns: [col('staff', 'Team member'), col('present', `Present`, 'number'), col('late', ATTENDANCE_STATUS_LABELS.late, 'number'), col('absent', ATTENDANCE_STATUS_LABELS.absent, 'number'), col('onLeave', ATTENDANCE_STATUS_LABELS.on_leave, 'number'), col('missingPunch', ATTENDANCE_STATUS_LABELS.missing_punch, 'number'), col('off', 'Off days', 'number'), col('hoursWorked', 'Hours worked', 'number'), col('lateMinutes', 'Minutes late', 'minutes')],
        rows,
        total: rows.length,
        note: 'Only branches with a connected attendance device (or recent punches) are included.',
      };
    },
  },
  {
    key: 'staff-utilization',
    title: 'Utilization',
    group: 'Staff',
    description: 'How much of each team member’s working time was booked.',
    permissions: ['reports.staff'],
    run: async (c) => {
      const m = await loadStaffMetrics(c.tx, c.orgId, c.branches, c.q, c.q.staffId ? [c.q.staffId] : undefined);
      return {
        columns: [col('staffName', 'Team member'), col('branchName', 'Branch'), col('availableHours', 'Working hours', 'number'), col('bookedHours', 'Booked hours', 'number'), col('utilizationPercent', 'Utilization', 'percent')],
        rows: m.map((x) => ({ ...x, availableHours: Number((x.availableMinutes / 60).toFixed(1)), bookedHours: Number((x.bookedMinutes / 60).toFixed(1)) })),
        total: m.length,
        note: 'Working hours come from schedules, minus breaks, leave and holidays. Show these numbers side by side rather than ranking people by one figure.',
      };
    },
  },
  {
    key: 'staff-services',
    title: 'Services performed',
    group: 'Staff',
    description: 'Which services each team member performed, and how often.',
    permissions: ['reports.staff'],
    run: async (c) => {
      let q = c.tx
        .selectFrom('invoiceItems as ii')
        .innerJoin('invoices as i', 'i.id', 'ii.invoiceId')
        .innerJoin('staff as st', 'st.id', 'ii.staffId')
        .innerJoin('services as s', 's.id', 'ii.serviceId')
        .select(['st.displayName as staff', 's.name as service', sql<number>`sum(ii.quantity)`.as('performed'), sql<number>`sum(ii.taxable_amount)`.as('revenue')])
        .where('i.organizationId', '=', c.orgId)
        .where('i.status', '=', 'issued')
        .where('i.branchId', 'in', c.branches)
        .where('i.invoiceDate', '>=', c.q.from)
        .where('i.invoiceDate', '<=', c.q.to);
      if (c.q.staffId) q = q.where('ii.staffId', '=', c.q.staffId);
      if (c.q.serviceId) q = q.where('ii.serviceId', '=', c.q.serviceId);
      const rows = await q.groupBy(['st.id', 'st.displayName', 's.id', 's.name']).orderBy('st.displayName').orderBy(sql`sum(ii.quantity)`, 'desc').limit(5000).execute();
      return {
        columns: [col('staff', 'Team member'), col('service', 'Service'), col('performed', 'Times performed', 'number'), col('revenue', 'Revenue (excl. tax)', 'money')],
        rows: rows.map((r) => ({ ...r, performed: n(r.performed), revenue: n(r.revenue) })),
        total: rows.length,
      };
    },
  },
  {
    key: 'staff-revenue',
    title: 'Revenue generated',
    group: 'Staff',
    description: 'Revenue, services and customers for each team member.',
    permissions: ['reports.staff'],
    run: async (c) => staffRevenue(c),
  },
];

async function staffRevenue(c: ReportContext): Promise<ReportResult> {
  const m = await loadStaffMetrics(c.tx, c.orgId, c.branches, c.q, c.q.staffId ? [c.q.staffId] : undefined);
  return {
    columns: [col('staffName', 'Team member'), col('branchName', 'Branch'), col('servicesPerformed', 'Services performed', 'number'), col('revenue', 'Revenue (excl. tax)', 'money'), col('averageServiceValue', 'Average service value', 'money'), col('customers', 'Customers', 'number'), col('repeatCustomers', 'Repeat customers', 'number')],
    rows: m.map((x) => ({ ...x })),
    totals: { staffName: 'Total', servicesPerformed: sum(m, (x) => x.servicesPerformed), revenue: sum(m, (x) => x.revenue), customers: sum(m, (x) => x.customers) },
    total: m.length,
  };
}

export function reportsFor(auth: AuthContext): ReportDefinition[] {
  return REPORTS.filter((r) => r.permissions.some((p) => hasPermission(auth, p)));
}
