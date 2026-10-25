import { sql } from 'kysely';
import { eachDate, isoWeekday } from '../../core/time.js';
import type { Tx } from '../../db/tenant.js';

const NO_MATCH = '00000000-0000-0000-0000-000000000000';

export interface Range {
  from: string;
  to: string;
}

/** Minutes each staff member was scheduled to work in the range: shifts (or one-day overrides) minus breaks, leave and holidays. */
export async function scheduledMinutes(tx: Tx, orgId: string, branchIds: string[], staffIds: string[], range: Range): Promise<Map<string, number>> {
  const result = new Map<string, number>(staffIds.map((id) => [id, 0]));
  if (!staffIds.length) return result;
  const dates = eachDate(range.from, range.to);
  const [shifts, breaks, overrides, leaves, holidays] = await Promise.all([
    tx.selectFrom('staffShifts').select(['staffId', 'weekday', 'startTime', 'endTime']).where('staffId', 'in', staffIds).execute(),
    tx.selectFrom('staffBreaks').select(['staffId', 'weekday', 'startTime', 'endTime']).where('staffId', 'in', staffIds).execute(),
    tx.selectFrom('staffScheduleOverrides').select(['staffId', 'date', 'isWorking', 'startTime', 'endTime']).where('staffId', 'in', staffIds).where('date', '>=', range.from).where('date', '<=', range.to).execute(),
    tx.selectFrom('staffLeaves').select(['staffId', 'startDate', 'endDate', 'halfDay']).where('staffId', 'in', staffIds).where('status', '=', 'approved').where('startDate', '<=', range.to).where('endDate', '>=', range.from).execute(),
    tx.selectFrom('holidays').select(['date', 'branchId']).where('organizationId', '=', orgId).where('date', '>=', range.from).where('date', '<=', range.to).execute(),
  ]);
  const staff = await tx.selectFrom('staff').select(['id', 'branchId']).where('id', 'in', staffIds).where('branchId', 'in', branchIds.length ? branchIds : [NO_MATCH]).execute();
  const minutes = (t: string) => {
    const [h, m] = t.split(':').map(Number);
    return h! * 60 + m!;
  };
  for (const s of staff) {
    let total = 0;
    for (const date of dates) {
      if (holidays.some((h) => h.date === date && (h.branchId === null || h.branchId === s.branchId))) continue;
      const leave = leaves.filter((l) => l.staffId === s.id && date >= l.startDate && date <= l.endDate);
      if (leave.some((l) => l.halfDay === 'none')) continue;
      const weekday = isoWeekday(date);
      const override = overrides.find((o) => o.staffId === s.id && o.date === date);
      const windows = override
        ? override.isWorking && override.startTime && override.endTime
          ? [{ start: minutes(override.startTime), end: minutes(override.endTime) }]
          : []
        : shifts.filter((x) => x.staffId === s.id && x.weekday === weekday).map((x) => ({ start: minutes(x.startTime), end: minutes(x.endTime) }));
      let day = windows.reduce((a, w) => a + (w.end - w.start), 0);
      if (!override || override.isWorking) day -= breaks.filter((b) => b.staffId === s.id && b.weekday === weekday).reduce((a, b) => a + (minutes(b.endTime) - minutes(b.startTime)), 0);
      if (leave.length) day = day / 2; // half-day leave
      total += Math.max(day, 0);
    }
    result.set(s.id, total);
  }
  return result;
}

export interface StaffMetric {
  staffId: string;
  staffName: string;
  branchId: string;
  branchName: string;
  totalAppointments: number;
  completedAppointments: number;
  cancelledAppointments: number;
  noShows: number;
  revenue: number;
  servicesPerformed: number;
  averageServiceValue: number;
  customers: number;
  repeatCustomers: number;
  bookedMinutes: number;
  availableMinutes: number;
  utilizationPercent: number;
}

/** Everything the owner needs to judge staff fairly: raw numbers side by side, never a single "score". */
export async function loadStaffMetrics(tx: Tx, orgId: string, branchIds: string[], range: Range, staffIds?: string[]): Promise<StaffMetric[]> {
  let sq = tx
    .selectFrom('staff as s')
    .innerJoin('branches as b', 'b.id', 's.branchId')
    .select(['s.id', 's.displayName', 's.branchId', 'b.name as branchName'])
    .where('s.organizationId', '=', orgId)
    .where('s.branchId', 'in', branchIds.length ? branchIds : [NO_MATCH])
    .where('s.employmentStatus', 'in', ['active', 'on_notice', 'inactive', 'terminated']);
  if (staffIds) sq = sq.where('s.id', 'in', staffIds.length ? staffIds : [NO_MATCH]);
  const staff = await sq.orderBy('s.displayName').execute();
  if (!staff.length) return [];
  const ids = staff.map((s) => s.id);

  const [appts, revenue, served, available] = await Promise.all([
    tx
      .selectFrom('appointmentItems as ai')
      .innerJoin('appointments as a', 'a.id', 'ai.appointmentId')
      .select([
        'ai.staffId',
        sql<number>`count(distinct a.id) filter (where a.status not in ('waiting'))`.as('total'),
        sql<number>`count(distinct a.id) filter (where a.status = 'completed')`.as('completed'),
        sql<number>`count(distinct a.id) filter (where a.status = 'cancelled')`.as('cancelled'),
        sql<number>`count(distinct a.id) filter (where a.status = 'no_show')`.as('noShow'),
        sql<number>`coalesce(sum(ai.duration_minutes) filter (where a.status in ('scheduled','confirmed','checked_in','in_service','completed')), 0)`.as('bookedMinutes'),
      ])
      .where('a.organizationId', '=', orgId)
      .where('ai.staffId', 'in', ids)
      .where('a.localDate', '>=', range.from)
      .where('a.localDate', '<=', range.to)
      .groupBy('ai.staffId')
      .execute(),
    tx
      .selectFrom('invoiceItems as ii')
      .innerJoin('invoices as i', 'i.id', 'ii.invoiceId')
      .select(['ii.staffId', sql<number>`coalesce(sum(ii.taxable_amount), 0)`.as('revenue'), sql<number>`coalesce(sum(ii.quantity) filter (where ii.item_type in ('service','package_redemption')), 0)`.as('performed')])
      .where('i.organizationId', '=', orgId)
      .where('i.status', '=', 'issued')
      .where('ii.staffId', 'in', ids)
      .where('i.invoiceDate', '>=', range.from)
      .where('i.invoiceDate', '<=', range.to)
      .groupBy('ii.staffId')
      .execute(),
    tx
      .selectFrom('invoiceItems as ii')
      .innerJoin('invoices as i', 'i.id', 'ii.invoiceId')
      .select([
        'ii.staffId',
        sql<number>`count(distinct i.customer_id)`.as('customers'),
        sql<number>`count(distinct i.customer_id) filter (where exists (select 1 from invoice_items x join invoices xi on xi.id = x.invoice_id where x.staff_id = ii.staff_id and xi.customer_id = i.customer_id and xi.status = 'issued' and xi.invoice_date < i.invoice_date))`.as('repeat'),
      ])
      .where('i.organizationId', '=', orgId)
      .where('i.status', '=', 'issued')
      .where('ii.staffId', 'in', ids)
      .where('i.invoiceDate', '>=', range.from)
      .where('i.invoiceDate', '<=', range.to)
      .groupBy('ii.staffId')
      .execute(),
    scheduledMinutes(tx, orgId, branchIds, ids, range),
  ]);

  return staff.map((s) => {
    const a = appts.find((x) => x.staffId === s.id);
    const r = revenue.find((x) => x.staffId === s.id);
    const c = served.find((x) => x.staffId === s.id);
    const performed = Number(r?.performed ?? 0);
    const rev = Number(r?.revenue ?? 0);
    const avail = available.get(s.id) ?? 0;
    const booked = Number(a?.bookedMinutes ?? 0);
    return {
      staffId: s.id,
      staffName: s.displayName,
      branchId: s.branchId,
      branchName: s.branchName,
      totalAppointments: Number(a?.total ?? 0),
      completedAppointments: Number(a?.completed ?? 0),
      cancelledAppointments: Number(a?.cancelled ?? 0),
      noShows: Number(a?.noShow ?? 0),
      revenue: rev,
      servicesPerformed: performed,
      averageServiceValue: performed ? Math.round(rev / performed) : 0,
      customers: Number(c?.customers ?? 0),
      repeatCustomers: Number(c?.repeat ?? 0),
      bookedMinutes: booked,
      availableMinutes: avail,
      utilizationPercent: avail ? Math.min(Math.round((booked / avail) * 100), 100) : 0,
    };
  }).filter((m) => m.totalAppointments > 0 || m.revenue > 0 || m.availableMinutes > 0);
}

export interface ServiceDemand {
  serviceId: string;
  name: string;
  category: string;
  bookings: number;
  billedQuantity: number;
  revenue: number;
  averageTicket: number;
  revenueSharePercent: number;
  topStaff: { staffId: string; name: string; count: number } | null;
}

export async function loadServiceDemand(tx: Tx, orgId: string, branchIds: string[], range: Range): Promise<ServiceDemand[]> {
  const branches = branchIds.length ? branchIds : [NO_MATCH];
  const [services, bookings, billed, topStaff] = await Promise.all([
    tx.selectFrom('services as s').innerJoin('serviceCategories as c', 'c.id', 's.categoryId').select(['s.id', 's.name', 'c.name as category']).where('s.organizationId', '=', orgId).where('s.status', '!=', 'archived').execute(),
    tx
      .selectFrom('appointmentItems as ai')
      .innerJoin('appointments as a', 'a.id', 'ai.appointmentId')
      .select(['ai.serviceId', sql<number>`count(*)`.as('n')])
      .where('a.organizationId', '=', orgId)
      .where('a.branchId', 'in', branches)
      .where('a.localDate', '>=', range.from)
      .where('a.localDate', '<=', range.to)
      .where('a.status', 'in', ['scheduled', 'confirmed', 'checked_in', 'in_service', 'completed'])
      .groupBy('ai.serviceId')
      .execute(),
    tx
      .selectFrom('invoiceItems as ii')
      .innerJoin('invoices as i', 'i.id', 'ii.invoiceId')
      .select(['ii.serviceId', sql<number>`sum(ii.quantity)`.as('qty'), sql<number>`sum(ii.taxable_amount)`.as('revenue')])
      .where('i.organizationId', '=', orgId)
      .where('i.status', '=', 'issued')
      .where('i.branchId', 'in', branches)
      .where('i.invoiceDate', '>=', range.from)
      .where('i.invoiceDate', '<=', range.to)
      .where('ii.serviceId', 'is not', null)
      .groupBy('ii.serviceId')
      .execute(),
    tx
      .selectFrom('invoiceItems as ii')
      .innerJoin('invoices as i', 'i.id', 'ii.invoiceId')
      .innerJoin('staff as st', 'st.id', 'ii.staffId')
      .select(['ii.serviceId', 'st.id as staffId', 'st.displayName', sql<number>`sum(ii.quantity)`.as('n')])
      .where('i.organizationId', '=', orgId)
      .where('i.status', '=', 'issued')
      .where('i.branchId', 'in', branches)
      .where('i.invoiceDate', '>=', range.from)
      .where('i.invoiceDate', '<=', range.to)
      .where('ii.serviceId', 'is not', null)
      .groupBy(['ii.serviceId', 'st.id', 'st.displayName'])
      .execute(),
  ]);
  const totalRevenue = billed.reduce((a, b) => a + Number(b.revenue), 0);
  return services
    .map((s) => {
      const b = billed.find((x) => x.serviceId === s.id);
      const qty = Number(b?.qty ?? 0);
      const rev = Number(b?.revenue ?? 0);
      const top = topStaff.filter((x) => x.serviceId === s.id).sort((a, c) => Number(c.n) - Number(a.n))[0];
      return {
        serviceId: s.id,
        name: s.name,
        category: s.category,
        bookings: Number(bookings.find((x) => x.serviceId === s.id)?.n ?? 0),
        billedQuantity: qty,
        revenue: rev,
        averageTicket: qty ? Math.round(rev / qty) : 0,
        revenueSharePercent: totalRevenue ? Number(((rev / totalRevenue) * 100).toFixed(1)) : 0,
        topStaff: top ? { staffId: top.staffId, name: top.displayName, count: Number(top.n) } : null,
      };
    })
    .sort((a, b) => b.revenue - a.revenue || b.bookings - a.bookings);
}
