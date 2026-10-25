import type { SalonNow } from '@salon/shared';
import { DateTime } from 'luxon';
import { nonEmpty } from '../../core/auth-context.js';
import { isoWeekday, zoned } from '../../core/time.js';
import type { Tx } from '../../db/tenant.js';

// "What is happening right now?" for one or many branches. Availability here is derived from the schedule, leave,
// breaks, blocked time and running services. Attendance only adds a warning ("not in yet"); a punch never makes
// someone available by itself.

type StaffState = SalonNow['staff'][number]['state'];

export interface BranchNow extends SalonNow {
  branchId: string;
  branchName: string;
}

const MINUTE = 60_000;

export async function loadSalonNow(tx: Tx, orgId: string, branchIds: string[], nowMs = Date.now()): Promise<BranchNow[]> {
  const branches = await tx.selectFrom('branches').select(['id', 'name', 'timezone']).where('organizationId', '=', orgId).where('id', 'in', nonEmpty(branchIds)).where('status', '=', 'active').orderBy('name').execute();
  if (!branches.length) return [];
  const bIds = branches.map((b) => b.id);
  const staff = await tx
    .selectFrom('staff')
    .select(['id', 'branchId', 'displayName', 'calendarColor'])
    .where('organizationId', '=', orgId)
    .where('branchId', 'in', bIds)
    .where('employmentStatus', 'in', ['active', 'on_notice'])
    .where('isBookable', '=', true)
    .orderBy('calendarOrder')
    .orderBy('displayName')
    .execute();
  const sIds = nonEmpty(staff.map((s) => s.id));
  const now = new Date(nowMs);
  const dates = [...new Set(branches.map((b) => DateTime.fromMillis(nowMs, { zone: b.timezone }).toISODate()!))];
  const minDate = dates.reduce((a, b) => (a < b ? a : b));
  const maxDate = dates.reduce((a, b) => (a > b ? a : b));
  const windowStart = new Date(nowMs - 12 * 60 * MINUTE);
  const windowEnd = new Date(nowMs + 14 * 60 * MINUTE);

  const [shifts, breaks, overrides, leaves, blocks, items, absent, appts, waiting, hours, holidays] = await Promise.all([
    tx.selectFrom('staffShifts').select(['staffId', 'weekday', 'startTime', 'endTime']).where('staffId', 'in', sIds).execute(),
    tx.selectFrom('staffBreaks').select(['staffId', 'weekday', 'startTime', 'endTime']).where('staffId', 'in', sIds).execute(),
    tx.selectFrom('staffScheduleOverrides').select(['staffId', 'date', 'isWorking', 'startTime', 'endTime']).where('staffId', 'in', sIds).where('date', '>=', minDate).where('date', '<=', maxDate).execute(),
    tx.selectFrom('staffLeaves').select(['staffId', 'startDate', 'endDate', 'halfDay']).where('staffId', 'in', sIds).where('status', '=', 'approved').where('startDate', '<=', maxDate).where('endDate', '>=', minDate).execute(),
    tx.selectFrom('staffTimeBlocks').select(['staffId', 'startAt', 'endAt']).where('staffId', 'in', sIds).where('startAt', '<=', now).where('endAt', '>', now).execute(),
    tx
      .selectFrom('appointmentItems as ai')
      .innerJoin('appointments as a', 'a.id', 'ai.appointmentId')
      .innerJoin('customers as c', 'c.id', 'a.customerId')
      .select(['ai.staffId', 'ai.startAt', 'ai.endAt', 'ai.blockedUntil', 'ai.status as itemStatus', 'a.id as appointmentId', 'a.status as appointmentStatus', 'c.fullName as customerName'])
      .where('ai.staffId', 'in', sIds)
      .where('ai.blocksSchedule', '=', true)
      .where('ai.startAt', '<', windowEnd)
      .where('ai.blockedUntil', '>', windowStart)
      .where('a.status', 'in', ['scheduled', 'confirmed', 'checked_in', 'in_service', 'completed'])
      .execute(),
    tx.selectFrom('attendanceDays').select(['staffId', 'status', 'date']).where('branchId', 'in', bIds).where('date', '>=', minDate).where('date', '<=', maxDate).execute(),
    tx
      .selectFrom('appointments')
      .select(['branchId', 'customerId', 'status', 'startAt', 'localDate'])
      .where('organizationId', '=', orgId)
      .where('branchId', 'in', bIds)
      .where('localDate', '>=', minDate)
      .where('localDate', '<=', maxDate)
      .execute(),
    tx.selectFrom('appointments').select(['branchId']).where('organizationId', '=', orgId).where('branchId', 'in', bIds).where('status', '=', 'waiting').execute(),
    tx.selectFrom('branchHours').select(['branchId', 'weekday', 'isClosed', 'openTime', 'closeTime']).where('branchId', 'in', bIds).execute(),
    tx.selectFrom('holidays').select(['branchId', 'date', 'name']).where('organizationId', '=', orgId).where('date', '>=', minDate).where('date', '<=', maxDate).execute(),
  ]);
  const fmt = (ms: number, tz: string) => DateTime.fromMillis(ms, { zone: tz }).toFormat('h:mm a');

  return branches.map((branch): BranchNow => {
    const tz = branch.timezone;
    const local = DateTime.fromMillis(nowMs, { zone: tz });
    const date = local.toISODate()!;
    const weekday = isoWeekday(date);
    const people = staff.filter((s) => s.branchId === branch.id);
    // Nobody is "free" while the salon itself is closed (outside opening hours or on a holiday): bookings are refused then.
    const todayHours = hours.find((h) => h.branchId === branch.id && h.weekday === weekday);
    const holiday = holidays.find((h) => h.date === date && (h.branchId === null || h.branchId === branch.id));
    const openWindow = todayHours && !todayHours.isClosed && todayHours.openTime && todayHours.closeTime ? { start: zoned(date, todayHours.openTime.slice(0, 5), tz).toMillis(), end: zoned(date, todayHours.closeTime.slice(0, 5), tz).toMillis() } : null;
    const salonOpen = !holiday && !!openWindow && openWindow.start <= nowMs && nowMs < openWindow.end;
    const states: SalonNow['staff'] = people.map((s) => {
      const base = { staffId: s.id, displayName: s.displayName, color: s.calendarColor, currentAppointmentId: null as string | null, nextAt: null as string | null };
      const leave = leaves.find((l) => l.staffId === s.id && date >= l.startDate && date <= l.endDate && l.halfDay === 'none');
      if (leave) return { ...base, state: 'on_leave' as StaffState, label: 'On leave today' };

      const override = overrides.find((o) => o.staffId === s.id && o.date === date);
      const windows = override
        ? override.isWorking && override.startTime && override.endTime
          ? [{ start: zoned(date, override.startTime, tz).toMillis(), end: zoned(date, override.endTime, tz).toMillis() }]
          : []
        : shifts.filter((x) => x.staffId === s.id && x.weekday === weekday).map((x) => ({ start: zoned(date, x.startTime, tz).toMillis(), end: zoned(date, x.endTime, tz).toMillis() }));
      const mine = items.filter((i) => i.staffId === s.id && i.startAt && i.endAt);
      const serving = mine.find((i) => i.itemStatus === 'in_service' || (i.appointmentStatus === 'in_service' && i.startAt!.getTime() <= nowMs && nowMs < i.endAt!.getTime()));
      if (serving) return { ...base, state: 'serving' as StaffState, label: `With ${serving.customerName.split(' ')[0]} until ${fmt(serving.endAt!.getTime(), tz)}`, currentAppointmentId: serving.appointmentId };

      if (!salonOpen) return { ...base, state: 'off' as StaffState, label: holiday ? `Closed for ${holiday.name}` : openWindow && nowMs < openWindow.start ? `Salon opens at ${fmt(openWindow.start, tz)}` : 'Salon is closed' };
      if (!windows.length) return { ...base, state: 'off' as StaffState, label: 'Day off' };
      const inShift = windows.some((w) => w.start <= nowMs && nowMs < w.end);
      if (!inShift) {
        const upcoming = windows.find((w) => w.start > nowMs);
        return { ...base, state: 'off' as StaffState, label: upcoming ? `Starts at ${fmt(upcoming.start, tz)}` : 'Finished for the day' };
      }
      const brk = breaks.find((b) => b.staffId === s.id && b.weekday === weekday && zoned(date, b.startTime, tz).toMillis() <= nowMs && nowMs < zoned(date, b.endTime, tz).toMillis());
      if (brk) return { ...base, state: 'break' as StaffState, label: `On break until ${fmt(zoned(date, brk.endTime, tz).toMillis(), tz)}` };
      if (blocks.some((b) => b.staffId === s.id)) return { ...base, state: 'blocked' as StaffState, label: 'Time blocked' };
      // A service that has just finished, and its clean-up time, still count as busy: nobody can be booked into it.
      const cleaning = mine.find((i) => i.blockedUntil && i.startAt!.getTime() <= nowMs && nowMs < i.blockedUntil.getTime());
      if (cleaning) return { ...base, state: 'blocked' as StaffState, label: `Cleaning up until ${fmt(cleaning.blockedUntil!.getTime(), tz)}` };
      const att = absent.find((a) => a.staffId === s.id && a.date === date);
      if (att?.status === 'absent') return { ...base, state: 'absent' as StaffState, label: 'Not in today' };
      const next = mine.filter((i) => i.startAt!.getTime() > nowMs).sort((a, b) => a.startAt!.getTime() - b.startAt!.getTime())[0];
      return { ...base, state: 'available' as StaffState, label: next ? `Free until ${fmt(next.startAt!.getTime(), tz)}` : 'Free', nextAt: next?.startAt?.toISOString() ?? null };
    });

    const today = appts.filter((a) => a.branchId === branch.id && a.localDate === date);
    const count = (s: StaffState) => states.filter((x) => x.state === s).length;
    return {
      branchId: branch.id,
      branchName: branch.name,
      timezone: tz,
      now: now.toISOString(),
      customersToday: new Set(today.filter((a) => !['cancelled', 'no_show'].includes(a.status)).map((a) => a.customerId)).size,
      staffAvailable: count('available'),
      staffServing: count('serving'),
      staffOnBreak: count('break'),
      staffAbsent: count('absent'),
      staffOnLeave: count('on_leave'),
      waitingCustomers: waiting.filter((w) => w.branchId === branch.id).length,
      upcomingAppointments: today.filter((a) => ['scheduled', 'confirmed', 'checked_in'].includes(a.status) && (a.startAt?.getTime() ?? 0) > nowMs).length,
      completedToday: today.filter((a) => a.status === 'completed').length,
      staff: states,
    };
  });
}

export function sumNow(rows: BranchNow[]): Omit<SalonNow, 'staff' | 'timezone' | 'now'> & { staffTotal: number } {
  const add = (pick: (r: BranchNow) => number) => rows.reduce((a, r) => a + pick(r), 0);
  return {
    customersToday: add((r) => r.customersToday),
    staffAvailable: add((r) => r.staffAvailable),
    staffServing: add((r) => r.staffServing),
    staffOnBreak: add((r) => r.staffOnBreak),
    staffAbsent: add((r) => r.staffAbsent),
    staffOnLeave: add((r) => r.staffOnLeave),
    waitingCustomers: add((r) => r.waitingCustomers),
    upcomingAppointments: add((r) => r.upcomingAppointments),
    completedToday: add((r) => r.completedToday),
    staffTotal: add((r) => r.staff.length),
  };
}
