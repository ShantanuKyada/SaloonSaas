import type { AppointmentItemInput } from '@salon/shared';
import { DateTime } from 'luxon';
import { AppError } from '../../core/errors.js';
import { localDateOf } from '../../core/time.js';
import type { BranchRow, OrgSettings } from '../../core/validation.js';
import { advisoryLock, type Tx } from '../../db/tenant.js';
import { checkBooking, type Interval } from '../scheduling/engine.js';
import { effectiveBuffer, loadDayContext, loadServicesForBranch, loadStaffDays, type DayContext } from '../scheduling/loader.js';

const MINUTE = 60_000;

export interface ItemPlan {
  serviceId: string;
  staffId: string | null;
  startAt: Date | null;
  endAt: Date | null;
  blockedUntil: Date | null;
  durationMinutes: number;
  bufferMinutes: number;
  price: number;
  customerPackageItemId: string | null;
  sortOrder: number;
}

export interface ExistingItem {
  serviceId: string;
  staffId: string | null;
  startAt: Date | null;
}

export interface PlanOptions {
  orgId: string;
  branch: BranchRow;
  settings: OrgSettings;
  customerId: string;
  excludeAppointmentId?: string;
  allowOutsideHours: boolean;
  /** Whole booking may be in the past (restoring, editing something already in progress). */
  allowPast?: boolean;
  /** Items identical to these are not rejected for being in the past. */
  existing?: ExistingItem[];
}

function problemStatus(code: string): number {
  return code === 'APPOINTMENT_CONFLICT' ? 409 : 422;
}

/**
 * Turns the requested lines into validated, priced plans. Takes a per-staff advisory lock first so two receptionists
 * booking the same person at the same time are serialised; the exclusion constraint on appointment_items is the
 * final database-level guarantee if anything here is ever bypassed.
 */
export async function planItems(tx: Tx, items: AppointmentItemInput[], o: PlanOptions): Promise<ItemPlan[]> {
  const staffIds = [...new Set(items.map((i) => i.staffId))].sort();
  for (const id of staffIds) await advisoryLock(tx, 'staff-schedule', id);

  const services = await loadServicesForBranch(tx, o.orgId, o.branch.id, items.map((i) => i.serviceId));
  const tz = o.branch.timezone;
  const fmtTime = (ms: number) => DateTime.fromMillis(ms, { zone: tz }).toFormat('h:mm a');
  const fmtDate = (ms: number) => DateTime.fromMillis(ms, { zone: tz }).toFormat('cccc, d LLLL');
  const dayCache = new Map<string, DayContext>();
  const extraBusy = new Map<string, Interval[]>();
  const now = Date.now();
  const plans: ItemPlan[] = [];

  // Package lines: lock the balance row so concurrent bookings cannot overspend a package.
  const packageIds = [...new Set(items.map((i) => i.customerPackageItemId).filter((v): v is string => !!v))];
  const reserved = new Map<string, number>();
  const packageInfo = new Map<string, { serviceId: string; expiresAt: number }>();
  for (const pid of packageIds) {
    const row = await tx
      .selectFrom('customerPackageItems as cpi')
      .innerJoin('customerPackages as cp', 'cp.id', 'cpi.customerPackageId')
      .select(['cpi.id', 'cpi.serviceId', 'cpi.quantityTotal', 'cpi.quantityUsed', 'cp.customerId', 'cp.status', 'cp.expiresAt', 'cp.branchId'])
      .where('cpi.organizationId', '=', o.orgId)
      .where('cpi.id', '=', pid)
      .forUpdate()
      .executeTakeFirst();
    if (!row || row.customerId !== o.customerId) throw new AppError(422, 'PACKAGE_UNAVAILABLE', 'This package does not belong to the selected customer.');
    if (row.status !== 'active') throw new AppError(422, 'PACKAGE_UNAVAILABLE', 'This package is no longer active.');
    let q = tx
      .selectFrom('appointmentItems')
      .select((eb) => eb.fn.countAll<number>().as('n'))
      .where('customerPackageItemId', '=', pid)
      .where('status', '!=', 'cancelled');
    if (o.excludeAppointmentId) q = q.where('appointmentId', '!=', o.excludeAppointmentId);
    // Items already invoiced consumed quantity_used; count only bookings that have not been billed yet.
    const pending = await q.where((eb) => eb.not(eb.exists(eb.selectFrom('invoiceItems as ii').select('ii.id').whereRef('ii.appointmentItemId', '=', 'appointmentItems.id')))).executeTakeFirstOrThrow();
    reserved.set(pid, row.quantityTotal - row.quantityUsed - pending.n);
    packageInfo.set(pid, { serviceId: row.serviceId, expiresAt: row.expiresAt.getTime() });
  }

  for (const [index, item] of items.entries()) {
    const service = services.get(item.serviceId)!;
    let start: number;
    if (item.startAt) {
      start = new Date(item.startAt).getTime();
    } else if (index === 0) {
      throw new AppError(400, 'VALIDATION_ERROR', 'Choose a start time for the first service.', { issues: [{ path: 'items.0.startAt', message: 'Required' }] });
    } else {
      // Chained service: right after the previous one (plus its cleaning buffer when the same person continues).
      const prev = plans[index - 1]!;
      start = (prev.staffId === item.staffId ? prev.blockedUntil! : prev.endAt!).getTime();
    }
    const date = localDateOf(new Date(start), tz);
    let day = dayCache.get(date);
    if (!day) {
      day = await loadDayContext(tx, o.orgId, o.branch, date);
      dayCache.set(date, day);
    }
    const load = await loadStaffDays(tx, o.orgId, o.branch, day, {
      staffIds: [item.staffId],
      serviceIds: [item.serviceId],
      services,
      excludeAppointmentId: o.excludeAppointmentId,
      extraBusy,
      includeUnqualified: true,
      includeInactive: true,
    });
    const staffDay = load.days[0];
    if (!staffDay) throw new AppError(422, 'STAFF_UNAVAILABLE', 'This team member does not work at this branch. Choose someone else.');
    const term = load.terms.get(item.staffId)!.get(item.serviceId)!;
    const duration = item.durationMinutes ?? term.durationMinutes;
    const buffer = effectiveBuffer([service], o.settings);

    let price = term.price;
    if (item.customerPackageItemId) {
      const left = reserved.get(item.customerPackageItemId) ?? 0;
      if (left <= 0) throw new AppError(422, 'PACKAGE_UNAVAILABLE', `No sessions of "${service.name}" are left in this package.`);
      reserved.set(item.customerPackageItemId, left - 1);
      const pkg = packageInfo.get(item.customerPackageItemId)!;
      if (pkg.serviceId !== item.serviceId) throw new AppError(422, 'PACKAGE_UNAVAILABLE', 'This package item is for a different service.');
      if (pkg.expiresAt < start) throw new AppError(422, 'PACKAGE_UNAVAILABLE', 'This package expires before the appointment date.');
      price = 0;
    }

    const unchanged = o.existing?.some((e) => e.serviceId === item.serviceId && e.staffId === item.staffId && e.startAt?.getTime() === start) ?? false;
    const problem = checkBooking({
      staff: staffDay,
      start,
      durationMinutes: duration,
      bufferMinutes: buffer,
      branchOpen: day.branchOpen,
      holiday: day.holiday,
      now,
      allowOutsideHours: o.allowOutsideHours,
      allowPast: !!o.allowPast || unchanged,
      formatTime: fmtTime,
      formatDate: fmtDate,
    });
    if (problem) {
      throw new AppError(problemStatus(problem.code), problem.code, problem.message, { staffId: item.staffId, serviceId: item.serviceId, itemIndex: index });
    }

    const end = start + duration * MINUTE;
    extraBusy.set(item.staffId, [...(extraBusy.get(item.staffId) ?? []), { start, end: end + buffer * MINUTE }]);
    plans.push({
      serviceId: item.serviceId,
      staffId: item.staffId,
      startAt: new Date(start),
      endAt: new Date(end),
      blockedUntil: new Date(end + buffer * MINUTE),
      durationMinutes: duration,
      bufferMinutes: buffer,
      price,
      customerPackageItemId: item.customerPackageItemId ?? null,
      sortOrder: index,
    });
  }
  return plans;
}

export function summarizePlans(plans: ItemPlan[]) {
  const starts = plans.map((p) => p.startAt!.getTime());
  const ends = plans.map((p) => p.endAt!.getTime());
  return {
    startAt: new Date(Math.min(...starts)),
    endAt: new Date(Math.max(...ends)),
    totalDurationMinutes: plans.reduce((a, p) => a + p.durationMinutes, 0),
    estimatedAmount: plans.reduce((a, p) => a + p.price, 0),
  };
}
