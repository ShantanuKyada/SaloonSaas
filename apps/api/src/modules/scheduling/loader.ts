import { DateTime } from 'luxon';
import { AppError } from '../../core/errors.js';
import { isoWeekday, zoned } from '../../core/time.js';
import type { BranchRow, OrgSettings } from '../../core/validation.js';
import type { Tx } from '../../db/tenant.js';
import { mergeIntervals, type Interval, type StaffDay } from './engine.js';

// Reads everything the scheduling engine needs for one branch-day. All instants leave this module as epoch ms.

const MINUTE = 60_000;
const NO_MATCH = '00000000-0000-0000-0000-000000000000';

export interface DayContext {
  date: string;
  timezone: string;
  branchOpen: Interval | null;
  holiday: string | null;
  dayStart: number;
  dayEnd: number;
}

export async function loadDayContext(tx: Tx, orgId: string, branch: BranchRow, date: string): Promise<DayContext> {
  const weekday = isoWeekday(date);
  const [hours, holiday] = await Promise.all([
    tx.selectFrom('branchHours').select(['isClosed', 'openTime', 'closeTime']).where('branchId', '=', branch.id).where('weekday', '=', weekday).executeTakeFirst(),
    tx
      .selectFrom('holidays')
      .select('name')
      .where('organizationId', '=', orgId)
      .where('date', '=', date)
      .where((eb) => eb.or([eb('branchId', 'is', null), eb('branchId', '=', branch.id)]))
      .executeTakeFirst(),
  ]);
  const day = DateTime.fromISO(date, { zone: branch.timezone }).startOf('day');
  const open =
    hours && !hours.isClosed && hours.openTime && hours.closeTime && !holiday
      ? { start: zoned(date, hours.openTime, branch.timezone).toMillis(), end: zoned(date, hours.closeTime, branch.timezone).toMillis() }
      : null;
  return {
    date,
    timezone: branch.timezone,
    branchOpen: open,
    holiday: holiday?.name ?? null,
    dayStart: day.toMillis(),
    dayEnd: day.plus({ days: 1 }).toMillis(),
  };
}

export interface ServiceInfo {
  id: string;
  name: string;
  categoryColor: string;
  durationMinutes: number;
  bufferMinutes: number;
  price: number;
  taxRateBp: number | null;
}

export async function loadServicesForBranch(tx: Tx, orgId: string, branchId: string, serviceIds: string[]): Promise<Map<string, ServiceInfo>> {
  const ids = [...new Set(serviceIds)];
  const rows = await tx
    .selectFrom('services as s')
    .innerJoin('serviceCategories as c', 'c.id', 's.categoryId')
    .leftJoin('serviceBranches as sb', (join) => join.onRef('sb.serviceId', '=', 's.id').on('sb.branchId', '=', branchId))
    .select([
      's.id',
      's.name',
      's.durationMinutes',
      's.bufferMinutes',
      's.price',
      's.taxRateBp',
      's.allBranches',
      's.status',
      'c.color as categoryColor',
      'sb.priceOverride',
      'sb.branchId as offeredBranchId',
    ])
    .where('s.organizationId', '=', orgId)
    .where('s.id', 'in', ids.length ? ids : [NO_MATCH])
    .execute();
  const map = new Map<string, ServiceInfo>();
  for (const s of rows) {
    if (s.status !== 'active') throw new AppError(409, 'CONFLICT', `"${s.name}" is no longer offered. Remove it and choose another service.`);
    if (!s.allBranches && !s.offeredBranchId) throw new AppError(409, 'CONFLICT', `"${s.name}" is not offered at this branch.`);
    map.set(s.id, {
      id: s.id,
      name: s.name,
      categoryColor: s.categoryColor,
      durationMinutes: s.durationMinutes,
      bufferMinutes: s.bufferMinutes,
      price: s.priceOverride ?? s.price,
      taxRateBp: s.taxRateBp,
    });
  }
  for (const id of ids) if (!map.has(id)) throw new AppError(404, 'NOT_FOUND', 'One of the selected services could not be found.');
  return map;
}

export interface StaffServiceTerms {
  durationMinutes: number;
  price: number;
}

export interface StaffLoad {
  days: StaffDay[];
  /** Per staff → per service terms (only qualified combinations). */
  terms: Map<string, Map<string, StaffServiceTerms>>;
  staffRows: Map<string, { id: string; displayName: string; color: string; branchId: string; status: string }>;
}

export interface LoadStaffOptions {
  staffIds?: string[];
  serviceIds: string[];
  services: Map<string, ServiceInfo>;
  excludeAppointmentId?: string;
  preferredStaffId?: string | null;
  /** Bookings already accepted earlier in the same request (not yet in the database). */
  extraBusy?: Map<string, Interval[]>;
  includeUnqualified?: boolean;
  /** Include staff who are not bookable/active (to validate existing records). */
  includeInactive?: boolean;
}

/** Loads StaffDay records for one branch-day and one sequence of services performed back-to-back by one person. */
export async function loadStaffDays(tx: Tx, orgId: string, branch: BranchRow, day: DayContext, opts: LoadStaffOptions): Promise<StaffLoad> {
  let staffQuery = tx
    .selectFrom('staff')
    .select(['id', 'displayName', 'calendarColor', 'isBookable', 'employmentStatus', 'branchId', 'calendarOrder'])
    .where('organizationId', '=', orgId)
    .where('branchId', '=', branch.id);
  if (!opts.includeInactive) staffQuery = staffQuery.where('employmentStatus', 'in', ['active', 'on_notice']);
  if (opts.staffIds) staffQuery = staffQuery.where('id', 'in', opts.staffIds.length ? opts.staffIds : [NO_MATCH]);
  const staffRows = await staffQuery.orderBy('calendarOrder').orderBy('displayName').execute();
  const ids = staffRows.map((s) => s.id);
  const idList = ids.length ? ids : [NO_MATCH];
  const weekday = isoWeekday(day.date);

  const windowStart = new Date(day.dayStart - 12 * 60 * MINUTE);
  const windowEnd = new Date(day.dayEnd + 12 * 60 * MINUTE);

  const [mappings, shifts, breaks, overrides, leaves, blocks, busy] = await Promise.all([
    tx.selectFrom('staffServices').select(['staffId', 'serviceId', 'durationMinutes', 'priceOverride', 'isActive']).where('staffId', 'in', idList).where('serviceId', 'in', opts.serviceIds.length ? opts.serviceIds : [NO_MATCH]).execute(),
    tx.selectFrom('staffShifts').select(['staffId', 'startTime', 'endTime']).where('staffId', 'in', idList).where('weekday', '=', weekday).execute(),
    tx.selectFrom('staffBreaks').select(['staffId', 'startTime', 'endTime', 'label']).where('staffId', 'in', idList).where('weekday', '=', weekday).execute(),
    tx.selectFrom('staffScheduleOverrides').select(['staffId', 'isWorking', 'startTime', 'endTime']).where('staffId', 'in', idList).where('date', '=', day.date).execute(),
    tx.selectFrom('staffLeaves').select(['staffId', 'halfDay']).where('staffId', 'in', idList).where('status', '=', 'approved').where('startDate', '<=', day.date).where('endDate', '>=', day.date).execute(),
    tx.selectFrom('staffTimeBlocks').select(['staffId', 'startAt', 'endAt', 'reason']).where('staffId', 'in', idList).where('startAt', '<', windowEnd).where('endAt', '>', windowStart).execute(),
    (() => {
      let q = tx
        .selectFrom('appointmentItems')
        .select(['staffId', 'startAt', 'blockedUntil'])
        .where('staffId', 'in', idList)
        .where('blocksSchedule', '=', true)
        .where('startAt', '<', windowEnd)
        .where('blockedUntil', '>', windowStart);
      if (opts.excludeAppointmentId) q = q.where('appointmentId', '!=', opts.excludeAppointmentId);
      return q.execute();
    })(),
  ]);

  const terms = new Map<string, Map<string, StaffServiceTerms>>();
  const days: StaffDay[] = [];
  const rowsById = new Map<string, StaffLoad['staffRows'] extends Map<string, infer V> ? V : never>();

  for (const s of staffRows) {
    rowsById.set(s.id, { id: s.id, displayName: s.displayName, color: s.calendarColor, branchId: s.branchId, status: s.employmentStatus });

    const own = mappings.filter((m) => m.staffId === s.id && m.isActive);
    const qualified = opts.serviceIds.length > 0 && opts.serviceIds.every((sid) => own.some((m) => m.serviceId === sid));
    const perService = new Map<string, StaffServiceTerms>();
    let duration = 0;
    let price = 0;
    for (const sid of opts.serviceIds) {
      const info = opts.services.get(sid)!;
      const m = own.find((x) => x.serviceId === sid);
      const term = { durationMinutes: m?.durationMinutes ?? info.durationMinutes, price: m?.priceOverride ?? info.price };
      perService.set(sid, term);
      duration += term.durationMinutes;
      price += term.price;
    }
    terms.set(s.id, perService);
    if (!qualified && !opts.includeUnqualified) continue;

    const override = overrides.find((o) => o.staffId === s.id);
    let working: Interval[];
    if (override) {
      working = override.isWorking && override.startTime && override.endTime
        ? [{ start: zoned(day.date, override.startTime, day.timezone).toMillis(), end: zoned(day.date, override.endTime, day.timezone).toMillis() }]
        : [];
    } else {
      working = mergeIntervals(shifts.filter((x) => x.staffId === s.id).map((x) => ({ start: zoned(day.date, x.startTime, day.timezone).toMillis(), end: zoned(day.date, x.endTime, day.timezone).toMillis() })));
    }

    const leaveRows = leaves.filter((l) => l.staffId === s.id);
    const fullLeave = leaveRows.some((l) => l.halfDay === 'none');
    const halfIntervals: Interval[] = [];
    if (!fullLeave && working.length) {
      const spanStart = working[0]!.start;
      const spanEnd = working[working.length - 1]!.end;
      const mid = spanStart + Math.floor((spanEnd - spanStart) / 2);
      for (const l of leaveRows) {
        if (l.halfDay === 'first_half') halfIntervals.push({ start: spanStart, end: mid });
        if (l.halfDay === 'second_half') halfIntervals.push({ start: mid, end: spanEnd });
      }
    }

    const busyIntervals: Interval[] = busy
      .filter((b) => b.staffId === s.id && b.startAt && b.blockedUntil)
      .map((b) => ({ start: b.startAt!.getTime(), end: b.blockedUntil!.getTime() }));
    busyIntervals.push(...(opts.extraBusy?.get(s.id) ?? []));

    days.push({
      staffId: s.id,
      displayName: s.displayName,
      color: s.calendarColor,
      qualified,
      bookable: s.isBookable && ['active', 'on_notice'].includes(s.employmentStatus),
      durationMinutes: duration,
      price,
      working,
      breaks: breaks.filter((b) => b.staffId === s.id).map((b) => ({ start: zoned(day.date, b.startTime, day.timezone).toMillis(), end: zoned(day.date, b.endTime, day.timezone).toMillis(), label: b.label })),
      leave: { full: fullLeave, intervals: halfIntervals },
      blocks: blocks.filter((b) => b.staffId === s.id).map((b) => ({ start: b.startAt.getTime(), end: b.endAt.getTime(), reason: b.reason })),
      busy: busyIntervals,
      isPreferred: opts.preferredStaffId === s.id,
    });
  }
  return { days, terms, staffRows: rowsById };
}

export function effectiveBuffer(services: ServiceInfo[], settings: OrgSettings): number {
  const last = services[services.length - 1];
  return Math.max(last?.bufferMinutes ?? 0, settings.defaultBufferMinutes);
}
