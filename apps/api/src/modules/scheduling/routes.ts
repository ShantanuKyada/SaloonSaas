import { availabilityQuery, type AvailabilityResult } from '@salon/shared';
import { DateTime } from 'luxon';
import { assertBranchAccess, hasPermission, requireOrgId } from '../../core/auth-context.js';
import { createRouter } from '../../core/router.js';
import { loadBranch, loadSettings } from '../../core/validation.js';
import type { Tx } from '../../db/tenant.js';
import type { AuthContext } from '../../core/auth-context.js';
import { computeAvailability } from './engine.js';
import { effectiveBuffer, loadDayContext, loadServicesForBranch, loadStaffDays } from './loader.js';
import type { AvailabilityQuery } from '@salon/shared';

const r = createRouter('/scheduling', 'Scheduling');

/** Shared by the staff booking screen, walk-in assignment and the public booking page. */
export async function computeDayAvailability(tx: Tx, orgId: string, query: AvailabilityQuery, opts: { onlineOnly?: boolean; allowOutsideHours?: boolean; hidePrivate?: boolean } = {}): Promise<AvailabilityResult> {
  const [branch, settings] = await Promise.all([loadBranch(tx, orgId, query.branchId), loadSettings(tx, orgId)]);
  const services = await loadServicesForBranch(tx, orgId, branch.id, query.serviceIds);
  const orderedServices = query.serviceIds.map((id) => services.get(id)!);
  const day = await loadDayContext(tx, orgId, branch, query.date);

  let preferredStaffId: string | null = null;
  if (query.customerId) {
    const c = await tx.selectFrom('customers').select('preferredStaffId').where('organizationId', '=', orgId).where('id', '=', query.customerId).executeTakeFirst();
    preferredStaffId = c?.preferredStaffId ?? null;
  }

  const load = await loadStaffDays(tx, orgId, branch, day, {
    serviceIds: query.serviceIds,
    services,
    staffIds: query.staffId ? [query.staffId] : undefined,
    excludeAppointmentId: query.excludeAppointmentId,
    preferredStaffId,
  });
  if (opts.onlineOnly) {
    const online = await tx.selectFrom('staff').select('id').where('organizationId', '=', orgId).where('branchId', '=', branch.id).where('onlineBookable', '=', true).execute();
    const allowed = new Set(online.map((s) => s.id));
    load.days = load.days.filter((d) => allowed.has(d.staffId));
  }

  const fmt = (ms: number) => DateTime.fromMillis(ms, { zone: branch.timezone }).toFormat('h:mm a');
  const result = computeAvailability({
    branchOpen: day.branchOpen,
    holiday: day.holiday,
    now: Date.now(),
    minNoticeMinutes: settings.minBookingNoticeMinutes,
    slotIntervalMinutes: settings.slotIntervalMinutes,
    bufferMinutes: effectiveBuffer(orderedServices, settings),
    allowOutsideHours: opts.allowOutsideHours ?? false,
    staff: load.days,
    requestedStart: query.startAt ? new Date(query.startAt).getTime() : undefined,
    formatTime: fmt,
  });

  const iso = (ms: number) => new Date(ms).toISOString();
  // Times past the booking window are never offered, so the screen cannot propose something the server will refuse.
  const latest = Date.now() + settings.maxAdvanceBookingDays * 86_400_000;
  const dayStart = DateTime.fromISO(query.date, { zone: branch.timezone }).startOf('day').toMillis();
  const beyondWindow = dayStart > latest;
  const withinWindow = (ms: number) => ms <= latest;
  return {
    date: query.date,
    timezone: branch.timezone,
    slotIntervalMinutes: settings.slotIntervalMinutes,
    branchOpen: day.branchOpen !== null,
    branchHours: day.branchOpen ? { open: DateTime.fromMillis(day.branchOpen.start, { zone: branch.timezone }).toFormat('HH:mm'), close: DateTime.fromMillis(day.branchOpen.end, { zone: branch.timezone }).toFormat('HH:mm') } : null,
    holiday: day.holiday,
    beyondBookingWindowDays: beyondWindow ? settings.maxAdvanceBookingDays : null,
    totalDurationMinutes: orderedServices.reduce((a, s) => a + s.durationMinutes, 0),
    staff: (beyondWindow ? [] : result.staff).map((s) => ({
      staffId: s.staffId,
      displayName: s.displayName,
      color: s.color,
      state: s.state,
      label: s.label,
      nextFreeAt: s.nextFreeAt ? iso(s.nextFreeAt) : null,
      isPreferred: s.isPreferred,
      slots: s.slots.filter(withinWindow).map(iso),
      durationMinutes: s.durationMinutes,
      price: s.price,
    })),
    slots: result.slots.filter((s) => withinWindow(s.startAt)).map((s) => ({ startAt: iso(s.startAt), staffIds: s.staffIds })),
  };
}

export function mayOverrideHours(auth: AuthContext, requested: boolean | undefined): boolean {
  return !!requested && hasPermission(auth, 'appointments.override_hours');
}

r.get(
  '/availability',
  {
    summary: 'Who can do these services, and when?',
    description:
      'Returns only team members qualified for every requested service, each with a plain-language status ("Available", "Busy until 11:30", "On leave") and their bookable start times. Pass `startAt` to check a specific time.',
    permissions: ['appointments.create', 'appointments.update', 'walkins.manage'],
    query: availabilityQuery,
  },
  async ({ tx, auth, query }) => {
    assertBranchAccess(auth, query.branchId);
    return tx((t) => computeDayAvailability(t, requireOrgId(auth), query, { allowOutsideHours: mayOverrideHours(auth, query.allowOutsideHours) }));
  },
);

export const schedulingRoutes = r;
