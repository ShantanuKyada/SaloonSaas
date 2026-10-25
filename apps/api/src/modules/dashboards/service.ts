import { formatMoney, type OperationalAlert, type StatValue } from '@salon/shared';
import { sql } from 'kysely';
import { DateTime } from 'luxon';
import { branchFilter, hasPermission, type AuthContext } from '../../core/auth-context.js';
import { addDays, daysBetween, eachDate, todayIn } from '../../core/time.js';
import { localDateConditionsTz } from '../../core/sql.js';
import { loadOrg } from '../../core/validation.js';
import type { Tx } from '../../db/tenant.js';
import { loadSalonNow, sumNow, type BranchNow } from './now.js';

const MINUTE = 60_000;

export interface Range {
  from: string;
  to: string;
}

export function previousRange(r: Range): Range {
  const days = daysBetween(r.from, r.to) + 1;
  return { from: addDays(r.from, -days), to: addDays(r.from, -1) };
}

const stat = (value: number, previous: number | null): StatValue => ({ value, previous });

async function revenueBetween(tx: Tx, orgId: string, branches: string[], r: Range) {
  const row = await tx
    .selectFrom('invoices')
    .select([
      sql<number>`coalesce(sum(grand_total - tax_total), 0)`.as('revenue'),
      sql<number>`coalesce(sum(grand_total), 0)`.as('billed'),
      sql<number>`coalesce(sum(discount_total), 0)`.as('discount'),
      sql<number>`count(*)`.as('bills'),
    ])
    .where('organizationId', '=', orgId)
    .where('status', '=', 'issued')
    .where('branchId', 'in', branches)
    .where('invoiceDate', '>=', r.from)
    .where('invoiceDate', '<=', r.to)
    .executeTakeFirstOrThrow();
  return { revenue: Number(row.revenue), billed: Number(row.billed), discount: Number(row.discount), bills: Number(row.bills) };
}

async function collectionsBetween(tx: Tx, orgId: string, branches: string[], tz: string, r: Range) {
  let q = tx
    .selectFrom('payments as p')
    .select([sql<number>`coalesce(sum(p.amount), 0)`.as('collected'), sql<number>`coalesce(sum(p.refunded_amount), 0)`.as('refunded')])
    .where('p.organizationId', '=', orgId)
    .where('p.status', '=', 'completed')
    .where('p.branchId', 'in', branches);
  for (const c of localDateConditionsTz('p.received_at', tz, r.from, r.to)) q = q.where(c);
  const row = await q.executeTakeFirstOrThrow();
  return { collected: Number(row.collected), refunded: Number(row.refunded) };
}

async function outstandingNow(tx: Tx, orgId: string, branches: string[], today: string) {
  const row = await tx
    .selectFrom('invoices')
    .select([sql<number>`coalesce(sum(balance_due), 0)`.as('total'), sql<number>`coalesce(sum(balance_due) filter (where due_date is not null and due_date < ${today}::date), 0)`.as('overdue'), sql<number>`count(distinct customer_id)`.as('customers')])
    .where('organizationId', '=', orgId)
    .where('status', '=', 'issued')
    .where('balanceDue', '>', 0)
    .where('branchId', 'in', branches)
    .executeTakeFirstOrThrow();
  return { total: Number(row.total), overdue: Number(row.overdue), customers: Number(row.customers) };
}

async function trend(tx: Tx, orgId: string, branches: string[], r: Range) {
  const days = daysBetween(r.from, r.to) + 1;
  const bucket = days > 92 ? 'month' : 'day';
  const key = bucket === 'month' ? sql<string>`to_char(date_trunc('month', invoice_date), 'YYYY-MM-01')` : sql<string>`invoice_date::text`;
  const apptKey = bucket === 'month' ? sql<string>`to_char(date_trunc('month', local_date), 'YYYY-MM-01')` : sql<string>`local_date::text`;
  const [rev, appts] = await Promise.all([
    tx
      .selectFrom('invoices')
      .select([key.as('d'), sql<number>`sum(grand_total - tax_total)`.as('revenue'), sql<number>`count(*)`.as('bills')])
      .where('organizationId', '=', orgId)
      .where('status', '=', 'issued')
      .where('branchId', 'in', branches)
      .where('invoiceDate', '>=', r.from)
      .where('invoiceDate', '<=', r.to)
      .groupBy(key)
      .execute(),
    tx
      .selectFrom('appointments')
      .select([
        apptKey.as('d'),
        sql<number>`count(*) filter (where status not in ('cancelled','no_show','waiting'))`.as('booked'),
        sql<number>`count(*) filter (where status = 'completed')`.as('completed'),
        sql<number>`count(*) filter (where status = 'cancelled')`.as('cancelled'),
        sql<number>`count(*) filter (where status = 'no_show')`.as('noShow'),
      ])
      .where('organizationId', '=', orgId)
      .where('branchId', 'in', branches)
      .where('localDate', '>=', r.from)
      .where('localDate', '<=', r.to)
      .groupBy(apptKey)
      .execute(),
  ]);
  const keys = bucket === 'day' ? eachDate(r.from, r.to) : [...new Set(eachDate(r.from, r.to).map((d) => `${d.slice(0, 7)}-01`))];
  return {
    bucket,
    revenue: keys.map((d) => ({ date: d, revenue: Number(rev.find((x) => x.d === d)?.revenue ?? 0), bills: Number(rev.find((x) => x.d === d)?.bills ?? 0) })),
    appointments: keys.map((d) => {
      const a = appts.find((x) => x.d === d);
      return { date: d, booked: Number(a?.booked ?? 0), completed: Number(a?.completed ?? 0), cancelled: Number(a?.cancelled ?? 0), noShow: Number(a?.noShow ?? 0) };
    }),
  };
}

async function topServices(tx: Tx, orgId: string, branches: string[], r: Range) {
  const rows = await tx
    .selectFrom('invoiceItems as ii')
    .innerJoin('invoices as i', 'i.id', 'ii.invoiceId')
    .innerJoin('services as s', 's.id', 'ii.serviceId')
    .select(['s.id as serviceId', 's.name', sql<number>`sum(ii.quantity)`.as('bookings'), sql<number>`sum(ii.taxable_amount)`.as('revenue')])
    .where('i.organizationId', '=', orgId)
    .where('i.status', '=', 'issued')
    .where('i.branchId', 'in', branches)
    .where('i.invoiceDate', '>=', r.from)
    .where('i.invoiceDate', '<=', r.to)
    .where('ii.itemType', 'in', ['service', 'package_redemption'])
    .groupBy(['s.id', 's.name'])
    .execute();
  const mapped = rows.map((x) => ({ serviceId: x.serviceId, name: x.name, bookings: Number(x.bookings), revenue: Number(x.revenue), averageTicket: Number(x.bookings) ? Math.round(Number(x.revenue) / Number(x.bookings)) : 0 }));
  return {
    byBookings: [...mapped].sort((a, b) => b.bookings - a.bookings).slice(0, 5),
    byRevenue: [...mapped].sort((a, b) => b.revenue - a.revenue).slice(0, 5),
  };
}

async function branchPerformance(tx: Tx, orgId: string, branches: string[], r: Range, today: string) {
  const [rev, appts, served, open, bn] = await Promise.all([
    tx.selectFrom('invoices').select(['branchId', sql<number>`sum(grand_total - tax_total)`.as('revenue'), sql<number>`count(*)`.as('bills')]).where('organizationId', '=', orgId).where('status', '=', 'issued').where('branchId', 'in', branches).where('invoiceDate', '>=', r.from).where('invoiceDate', '<=', r.to).groupBy('branchId').execute(),
    tx.selectFrom('appointments').select(['branchId', sql<number>`count(*) filter (where status not in ('cancelled','no_show','waiting'))`.as('appointments'), sql<number>`count(*) filter (where status in ('cancelled','no_show'))`.as('lost')]).where('organizationId', '=', orgId).where('branchId', 'in', branches).where('localDate', '>=', r.from).where('localDate', '<=', r.to).groupBy('branchId').execute(),
    tx.selectFrom('invoices').select(['branchId', sql<number>`count(distinct customer_id)`.as('customers')]).where('organizationId', '=', orgId).where('status', '=', 'issued').where('branchId', 'in', branches).where('invoiceDate', '>=', r.from).where('invoiceDate', '<=', r.to).groupBy('branchId').execute(),
    tx.selectFrom('invoices').select(['branchId', sql<number>`sum(balance_due)`.as('outstanding'), sql<number>`coalesce(sum(balance_due) filter (where due_date < ${today}::date), 0)`.as('overdue')]).where('organizationId', '=', orgId).where('status', '=', 'issued').where('balanceDue', '>', 0).where('branchId', 'in', branches).groupBy('branchId').execute(),
    tx.selectFrom('branches').select(['id', 'name']).where('id', 'in', branches).orderBy('name').execute(),
  ]);
  return bn.map((b) => {
    const revenue = Number(rev.find((x) => x.branchId === b.id)?.revenue ?? 0);
    const bills = Number(rev.find((x) => x.branchId === b.id)?.bills ?? 0);
    return {
      branchId: b.id,
      branchName: b.name,
      revenue,
      bills,
      averageTicket: bills ? Math.round(revenue / bills) : 0,
      appointments: Number(appts.find((x) => x.branchId === b.id)?.appointments ?? 0),
      cancelledOrMissed: Number(appts.find((x) => x.branchId === b.id)?.lost ?? 0),
      customers: Number(served.find((x) => x.branchId === b.id)?.customers ?? 0),
      outstanding: Number(open.find((x) => x.branchId === b.id)?.outstanding ?? 0),
      overdue: Number(open.find((x) => x.branchId === b.id)?.overdue ?? 0),
    };
  });
}

export async function buildAlerts(tx: Tx, auth: AuthContext, orgId: string, branches: string[], tz: string, currency: string, nowRows: BranchNow[]): Promise<OperationalAlert[]> {
  const alerts: OperationalAlert[] = [];
  const today = todayIn(tz);
  const canMoney = hasPermission(auth, 'reports.financial') || hasPermission(auth, 'ledger.view');

  if (canMoney) {
    const out = await outstandingNow(tx, orgId, branches, today);
    const last30 = await revenueBetween(tx, orgId, branches, { from: addDays(today, -29), to: today });
    if (out.overdue > 0) alerts.push({ id: 'overdue', severity: out.overdue > Math.max(last30.billed * 0.25, 1) ? 'critical' : 'warning', title: `${formatMoney(out.overdue, currency)} is overdue`, detail: `${out.customers} customer${out.customers === 1 ? '' : 's'} have pending payments. Send reminders or collect at their next visit.`, link: '/billing/outstanding' });
    else if (last30.billed > 0 && out.total > last30.billed * 0.3) alerts.push({ id: 'high-outstanding', severity: 'warning', title: `Pending payments are ${formatMoney(out.total, currency)}`, detail: 'That is more than 30% of the last 30 days of billing.', link: '/billing/outstanding' });
  }

  const outcomes = await tx
    .selectFrom('appointments')
    .select([
      sql<number>`count(*) filter (where local_date >= ${addDays(today, -6)}::date and status not in ('waiting'))`.as('recent'),
      sql<number>`count(*) filter (where local_date >= ${addDays(today, -6)}::date and status = 'cancelled')`.as('recentCancelled'),
      sql<number>`count(*) filter (where local_date >= ${addDays(today, -6)}::date and status = 'no_show')`.as('recentNoShow'),
      sql<number>`count(*) filter (where local_date between ${addDays(today, -34)}::date and ${addDays(today, -7)}::date and status not in ('waiting'))`.as('prior'),
      sql<number>`count(*) filter (where local_date between ${addDays(today, -34)}::date and ${addDays(today, -7)}::date and status = 'cancelled')`.as('priorCancelled'),
    ])
    .where('organizationId', '=', orgId)
    .where('branchId', 'in', branches)
    .where('localDate', '>=', addDays(today, -34))
    .where('localDate', '<=', today)
    .executeTakeFirstOrThrow();
  const recent = Number(outcomes.recent);
  const cancelRate = recent ? Number(outcomes.recentCancelled) / recent : 0;
  const priorRate = Number(outcomes.prior) ? Number(outcomes.priorCancelled) / Number(outcomes.prior) : 0;
  if (recent >= 10 && cancelRate >= 0.2 && cancelRate > priorRate * 1.5) {
    alerts.push({ id: 'cancellations', severity: 'warning', title: 'More cancellations than usual', detail: `${Math.round(cancelRate * 100)}% of bookings this week were cancelled (usually ${Math.round(priorRate * 100)}%).`, link: '/reports/appointments' });
  }
  if (Number(outcomes.recentNoShow) >= 3 && Number(outcomes.recentNoShow) / Math.max(recent, 1) >= 0.1) {
    alerts.push({ id: 'no-shows', severity: 'warning', title: 'No-shows are up', detail: `${outcomes.recentNoShow} customers did not turn up in the last 7 days. Reminders may need to go out earlier.`, link: '/reports/appointments' });
  }

  const totals = sumNow(nowRows);
  const working = totals.staffTotal - totals.staffAbsent - totals.staffOnLeave;
  if (nowRows.length && totals.staffTotal > 0 && (working <= 1 || totals.staffAbsent + totals.staffOnLeave >= Math.ceil(totals.staffTotal / 2)) && totals.upcomingAppointments + totals.waitingCustomers >= 3) {
    alerts.push({ id: 'staff-shortage', severity: 'critical', title: 'Short on team members today', detail: `${totals.staffAbsent + totals.staffOnLeave} of ${totals.staffTotal} are away and ${totals.upcomingAppointments + totals.waitingCustomers} customers are booked or waiting.`, link: '/staff/attendance' });
  }

  const nextDay = await tx
    .selectFrom('appointmentItems as ai')
    .innerJoin('appointments as a', 'a.id', 'ai.appointmentId')
    .select([sql<number>`coalesce(sum(ai.duration_minutes), 0)`.as('booked'), sql<number>`count(distinct ai.staff_id)`.as('staff')])
    .where('a.organizationId', '=', orgId)
    .where('a.branchId', 'in', branches)
    .where('a.localDate', '=', addDays(today, 1))
    .where('ai.blocksSchedule', '=', true)
    .executeTakeFirstOrThrow();
  const staffCount = totals.staffTotal;
  if (staffCount >= 2 && Number(nextDay.booked) < staffCount * 8 * 60 * 0.2) {
    alerts.push({ id: 'low-utilisation', severity: 'info', title: 'Tomorrow is quiet', detail: `Only ${Math.round(Number(nextDay.booked) / 60)} hours are booked across ${staffCount} team members. A message to regular customers could fill it.`, link: '/notifications/campaigns' });
  }

  const big = await tx
    .selectFrom('appointments as a')
    .innerJoin('customers as c', 'c.id', 'a.customerId')
    .select(['a.id', 'a.estimatedAmount', 'a.startAt', 'c.fullName'])
    .where('a.organizationId', '=', orgId)
    .where('a.branchId', 'in', branches)
    .where('a.status', 'in', ['scheduled', 'confirmed'])
    .where('a.startAt', '>', new Date())
    .where('a.startAt', '<', new Date(Date.now() + 36 * 60 * MINUTE))
    .where('a.estimatedAmount', '>=', 1_000_000)
    .orderBy('a.estimatedAmount', 'desc')
    .limit(3)
    .execute();
  for (const b of big) {
    alerts.push({ id: `big-${b.id}`, severity: 'info', title: `High-value booking: ${b.fullName}`, detail: `${formatMoney(b.estimatedAmount, currency)} at ${DateTime.fromJSDate(b.startAt!).setZone(tz).toFormat('ccc h:mm a')}.`, link: `/appointments/${b.id}` });
  }

  if (hasPermission(auth, 'notifications.view')) {
    const failed = await tx.selectFrom('notifications').select((eb) => eb.fn.countAll<number>().as('n')).where('organizationId', '=', orgId).where('status', '=', 'failed').where('failedAt', '>', new Date(Date.now() - 24 * 60 * MINUTE)).executeTakeFirstOrThrow();
    if (failed.n >= 5) alerts.push({ id: 'failed-messages', severity: 'warning', title: `${failed.n} messages could not be delivered`, detail: 'Check your WhatsApp / email connection.', link: '/notifications/logs' });
  }
  if (hasPermission(auth, 'attendance.manage')) {
    const broken = await tx.selectFrom('organizationIntegrations').select(['displayName']).where('organizationId', '=', orgId).where('kind', '=', 'biometric').where('status', '=', 'error').execute();
    for (const b of broken) alerts.push({ id: `device-${b.displayName}`, severity: 'warning', title: `${b.displayName} is not connected`, detail: 'Attendance is not updating. Bookings are not affected.', link: '/settings/connections' });
  }
  const order = { critical: 0, warning: 1, info: 2 } as const;
  return alerts.sort((a, b) => order[a.severity] - order[b.severity]);
}

export interface OwnerQuery {
  branchId?: string;
  from: string;
  to: string;
}

export async function ownerDashboard(tx: Tx, auth: AuthContext, orgId: string, q: OwnerQuery) {
  const org = await loadOrg(tx, orgId);
  const branches = branchFilter(auth, q.branchId);
  const today = todayIn(org.timezone);
  const range = { from: q.from, to: q.to };
  const prev = previousRange(range);
  const weekStart = DateTime.fromISO(today).startOf('week').toISODate()!;
  const monthStart = DateTime.fromISO(today).startOf('month').toISODate()!;
  const lastWeek = { from: addDays(weekStart, -7), to: addDays(weekStart, -1) };
  const lastMonthStart = DateTime.fromISO(monthStart).minus({ months: 1 }).toISODate()!;
  const lastMonth = { from: lastMonthStart, to: addDays(monthStart, -1) };
  const yesterday = addDays(today, -1);

  const [rToday, rYesterday, rWeek, rLastWeek, rMonth, rLastMonth, rRange, rPrev, cRange, cPrev, out, tr, top, perf, nowRows] = await Promise.all([
    revenueBetween(tx, orgId, branches, { from: today, to: today }),
    revenueBetween(tx, orgId, branches, { from: yesterday, to: yesterday }),
    revenueBetween(tx, orgId, branches, { from: weekStart, to: today }),
    revenueBetween(tx, orgId, branches, lastWeek),
    revenueBetween(tx, orgId, branches, { from: monthStart, to: today }),
    revenueBetween(tx, orgId, branches, lastMonth),
    revenueBetween(tx, orgId, branches, range),
    revenueBetween(tx, orgId, branches, prev),
    collectionsBetween(tx, orgId, branches, org.timezone, range),
    collectionsBetween(tx, orgId, branches, org.timezone, prev),
    outstandingNow(tx, orgId, branches, today),
    trend(tx, orgId, branches, range),
    topServices(tx, orgId, branches, range),
    branchPerformance(tx, orgId, branches, range, today),
    loadSalonNow(tx, orgId, branches),
  ]);

  const todayAppts = await tx
    .selectFrom('appointments')
    .select([
      sql<number>`count(*) filter (where status not in ('cancelled','no_show','waiting'))`.as('total'),
      sql<number>`count(*) filter (where status = 'completed')`.as('completed'),
      sql<number>`count(*) filter (where status in ('scheduled','confirmed','checked_in','in_service','waiting'))`.as('pending'),
      sql<number>`count(*) filter (where status = 'cancelled')`.as('cancelled'),
      sql<number>`count(*) filter (where status = 'no_show')`.as('noShow'),
    ])
    .where('organizationId', '=', orgId)
    .where('branchId', 'in', branches)
    .where('localDate', '=', today)
    .executeTakeFirstOrThrow();

  const customerCounts = await tx
    .selectFrom('customers as c')
    .leftJoin('customerStats as cs', 'cs.customerId', 'c.id')
    .select([
      sql<number>`count(*) filter (where c.status = 'active')`.as('active'),
      sql<number>`count(*) filter (where c.status = 'active' and ${sql.ref('c.registered_at')} >= ${new Date(Date.parse(`${range.from}T00:00:00Z`) - 86400_000)} and (c.registered_at at time zone ${org.timezone}::text)::date between ${range.from}::date and ${range.to}::date)`.as('newCustomers'),
      sql<number>`count(*) filter (where c.status = 'active' and cs.visit_count > 0 and coalesce(cs.last_visit_at, c.registered_at) < now() - interval '60 days')`.as('inactive'),
      sql<number>`coalesce(percentile_cont(0.9) within group (order by cs.lifetime_spend) filter (where cs.lifetime_spend > 0), 0)`.as('p90'),
    ])
    .where('c.organizationId', '=', orgId)
    .executeTakeFirstOrThrow();
  const served = await tx
    .selectFrom('invoices as i')
    .select([
      sql<number>`count(distinct i.customer_id)`.as('served'),
      sql<number>`count(distinct i.customer_id) filter (where exists (select 1 from invoices p where p.customer_id = i.customer_id and p.status = 'issued' and p.invoice_date < ${range.from}::date))`.as('returning'),
    ])
    .where('i.organizationId', '=', orgId)
    .where('i.status', '=', 'issued')
    .where('i.branchId', 'in', branches)
    .where('i.invoiceDate', '>=', range.from)
    .where('i.invoiceDate', '<=', range.to)
    .executeTakeFirstOrThrow();
  const highValue = await tx
    .selectFrom('customerStats')
    .select((eb) => eb.fn.countAll<number>().as('n'))
    .where('organizationId', '=', orgId)
    .where('lifetimeSpend', '>', 0)
    .where('lifetimeSpend', '>=', Math.round(Number(customerCounts.p90)))
    .executeTakeFirstOrThrow();

  const schedule = await tx
    .selectFrom('appointments as a')
    .innerJoin('customers as c', 'c.id', 'a.customerId')
    .innerJoin('branches as b', 'b.id', 'a.branchId')
    .select([
      'a.id',
      'a.startAt',
      'a.status',
      'b.name as branchName',
      'c.fullName as customerName',
      sql<string>`coalesce((select string_agg(s.name, ', ' order by ai.sort_order) from appointment_items ai join services s on s.id = ai.service_id where ai.appointment_id = a.id), '')`.as('services'),
      sql<string>`coalesce((select string_agg(distinct st.display_name, ', ') from appointment_items ai join staff st on st.id = ai.staff_id where ai.appointment_id = a.id), '')`.as('staff'),
    ])
    .where('a.organizationId', '=', orgId)
    .where('a.branchId', 'in', branches)
    .where('a.localDate', '=', today)
    .where('a.status', 'in', ['scheduled', 'confirmed', 'checked_in', 'in_service'])
    .orderBy('a.startAt')
    .limit(12)
    .execute();

  const topCustomers = await tx
    .selectFrom('customerStats as cs')
    .innerJoin('customers as c', 'c.id', 'cs.customerId')
    .leftJoin('services as fs', 'fs.id', 'cs.favoriteServiceId')
    .leftJoin('staff as fst', 'fst.id', 'cs.favoriteStaffId')
    .select(['c.id', 'c.fullName', 'cs.visitCount', 'cs.lifetimeSpend', 'cs.lastVisitAt', 'fs.name as favoriteService', 'fst.displayName as favoriteStaff'])
    .where('cs.organizationId', '=', orgId)
    .where('c.status', '=', 'active')
    .where('cs.lifetimeSpend', '>', 0)
    .orderBy('cs.lifetimeSpend', 'desc')
    .limit(5)
    .execute();

  const t = sumNow(nowRows);
  const alerts = await buildAlerts(tx, auth, orgId, branches, org.timezone, org.currency, nowRows);
  const retention = served.served ? Math.round((Number(served.returning) / Number(served.served)) * 100) : 0;

  return {
    asOf: new Date().toISOString(),
    timezone: org.timezone,
    range,
    revenue: {
      today: stat(rToday.revenue, rYesterday.revenue),
      week: stat(rWeek.revenue, rLastWeek.revenue),
      month: stat(rMonth.revenue, rLastMonth.revenue),
      range: stat(rRange.revenue, rPrev.revenue),
      bills: stat(rRange.bills, rPrev.bills),
      averageTicket: stat(rRange.bills ? Math.round(rRange.revenue / rRange.bills) : 0, rPrev.bills ? Math.round(rPrev.revenue / rPrev.bills) : 0),
      discounts: stat(rRange.discount, rPrev.discount),
    },
    collections: { collected: stat(cRange.collected, cPrev.collected), refunded: cRange.refunded },
    appointments: { today: { total: Number(todayAppts.total), completed: Number(todayAppts.completed), pending: Number(todayAppts.pending), cancelled: Number(todayAppts.cancelled), noShow: Number(todayAppts.noShow) } },
    customers: {
      newCustomers: Number(customerCounts.newCustomers),
      served: Number(served.served),
      returning: Number(served.returning),
      totalActive: Number(customerCounts.active),
      inactive60Days: Number(customerCounts.inactive),
      highValue: { count: highValue.n, threshold: Math.round(Number(customerCounts.p90)) },
      repeatRatePercent: retention,
    },
    staff: { total: t.staffTotal, present: t.staffTotal - t.staffAbsent - t.staffOnLeave - nowRows.reduce((a, r) => a + r.staff.filter((s) => s.state === 'off').length, 0), absent: t.staffAbsent, onLeave: t.staffOnLeave, busy: t.staffServing, available: t.staffAvailable },
    outstanding: out,
    trend: tr,
    topServices: top,
    todaySchedule: schedule.map((s) => ({ id: s.id, startAt: s.startAt?.toISOString() ?? null, status: s.status, branchName: s.branchName, customerName: s.customerName, services: s.services, staff: s.staff })),
    topCustomers: topCustomers.map((c) => ({ id: c.id, fullName: c.fullName, visits: c.visitCount, lifetimeSpend: c.lifetimeSpend, lastVisitAt: c.lastVisitAt?.toISOString() ?? null, favoriteService: c.favoriteService, favoriteStaff: c.favoriteStaff })),
    branches: perf,
    alerts,
  };
}

export async function branchDashboard(tx: Tx, auth: AuthContext, orgId: string, branchId: string) {
  const org = await loadOrg(tx, orgId);
  const today = todayIn(org.timezone);
  const [now] = await loadSalonNow(tx, orgId, [branchId]);
  const [rev, col, out] = await Promise.all([
    revenueBetween(tx, orgId, [branchId], { from: today, to: today }),
    collectionsBetween(tx, orgId, [branchId], org.timezone, { from: today, to: today }),
    outstandingNow(tx, orgId, [branchId], today),
  ]);
  const byStatus = await tx
    .selectFrom('appointments')
    .select(['status', (eb) => eb.fn.countAll<number>().as('n')])
    .where('organizationId', '=', orgId)
    .where('branchId', '=', branchId)
    .where('localDate', '=', today)
    .groupBy('status')
    .execute();
  const alerts = await buildAlerts(tx, auth, orgId, [branchId], org.timezone, org.currency, now ? [now] : []);
  return {
    now,
    today: { revenue: rev.revenue, bills: rev.bills, collected: col.collected, refunded: col.refunded, outstanding: out.total, overdue: out.overdue, appointmentsByStatus: Object.fromEntries(byStatus.map((s) => [s.status, Number(s.n)])) },
    alerts,
  };
}
