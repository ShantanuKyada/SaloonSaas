import { changeDecisionSchema, changeRequestSchema, leaveRequestSchema, type ChangeRequestDto, type MyScheduleDay } from '@salon/shared';
import { sql } from 'kysely';
import { DateTime } from 'luxon';
import { z } from 'zod';
import { audit } from '../../core/audit.js';
import { assertBranchAccess, branchFilter, requireOrgId, type AuthContext } from '../../core/auth-context.js';
import { AppError, notFound } from '../../core/errors.js';
import { createRouter } from '../../core/router.js';
import { addDays, daysBetween, eachDate, localDateOf, localRangeToUtc, todayIn } from '../../core/time.js';
import { zDate } from '@salon/shared';
import { loadBranch, type BranchRow } from '../../core/validation.js';
import type { Tx } from '../../db/tenant.js';
import { moveAppointment } from '../appointments/service.js';
import { loadAttendanceDays, recomputeBranch } from '../attendance/service.js';
import { computeDayAvailability } from '../scheduling/routes.js';
import { loadDayContext, loadStaffDays } from '../scheduling/loader.js';
import { leaveConflicts } from '../staff/routes.js';

// Self-service for team members (the Staff role): their schedule, leave requests, attendance and requests to move
// their own appointments. Everything here is scoped to the team member the login is linked to. The front desk answers
// time-change requests through /change-requests; managers answer leave requests through /staff-leaves.

const OWN = ['appointments.view_own', 'appointments.view'] as const;
const MOVABLE = ['scheduled', 'confirmed'];

interface Me {
  orgId: string;
  staffId: string;
  displayName: string;
  branch: BranchRow;
}

async function me(t: Tx, auth: AuthContext): Promise<Me> {
  const orgId = requireOrgId(auth);
  if (!auth.staffId) throw new AppError(404, 'NOT_FOUND', 'Your login is not linked to a team member profile. Ask your manager to link it.');
  const row = await t.selectFrom('staff').select(['id', 'branchId', 'displayName']).where('organizationId', '=', orgId).where('id', '=', auth.staffId).executeTakeFirst();
  if (!row) throw notFound('Team member');
  return { orgId, staffId: row.id, displayName: row.displayName, branch: await loadBranch(t, orgId, row.branchId) };
}

const hhmm = (ms: number, tz: string) => DateTime.fromMillis(ms, { zone: tz }).toFormat('HH:mm');

// ───────────── Change requests: shared loading ─────────────
async function changeRequestDtos(t: Tx, orgId: string, where: { ids?: string[]; staffId?: string; branchIds?: string[]; status?: string }, limit = 100): Promise<ChangeRequestDto[]> {
  let q = t
    .selectFrom('appointmentChangeRequests as r')
    .innerJoin('appointments as a', 'a.id', 'r.appointmentId')
    .innerJoin('customers as c', 'c.id', 'a.customerId')
    .innerJoin('branches as b', 'b.id', 'r.branchId')
    .innerJoin('staff as s', 's.id', 'r.staffId')
    .innerJoin('users as u', 'u.id', 'r.requestedBy')
    .leftJoin('users as d', 'd.id', 'r.decidedBy')
    .select([
      'r.id', 'r.appointmentId', 'a.bookingNumber', 'r.branchId', 'b.name as branchName', 'r.staffId', 's.displayName as staffName', 'c.fullName as customerName',
      'a.status as appointmentStatus', 'r.status', 'r.currentStartAt', 'r.proposedStartAt', 'r.reason', 'u.fullName as requestedByName', 'd.fullName as decidedByName',
      'r.decidedAt', 'r.decisionNote', 'r.createdAt',
      sql<string>`(select string_agg(sv.name, ', ' order by ai.sort_order) from appointment_items ai join services sv on sv.id = ai.service_id where ai.appointment_id = r.appointment_id and ai.staff_id = r.staff_id and ai.status <> 'cancelled')`.as('services'),
    ])
    .where('r.organizationId', '=', orgId);
  if (where.ids) q = q.where('r.id', 'in', where.ids.length ? where.ids : ['00000000-0000-0000-0000-000000000000']);
  if (where.staffId) q = q.where('r.staffId', '=', where.staffId);
  if (where.branchIds) q = q.where('r.branchId', 'in', where.branchIds.length ? where.branchIds : ['00000000-0000-0000-0000-000000000000']);
  if (where.status) q = q.where('r.status', '=', where.status);
  const rows = await q.orderBy('r.createdAt', 'desc').limit(limit).execute();
  return rows.map((r) => ({
    ...r,
    appointmentStatus: r.appointmentStatus as ChangeRequestDto['appointmentStatus'],
    status: r.status as ChangeRequestDto['status'],
    services: r.services ?? '',
    currentStartAt: r.currentStartAt.toISOString(),
    proposedStartAt: r.proposedStartAt.toISOString(),
    decidedAt: r.decidedAt?.toISOString() ?? null,
    createdAt: r.createdAt.toISOString(),
  }));
}

/** The team member's own services in a booking, in order; the first is the one that moves to the proposed time. */
async function myItems(t: Tx, orgId: string, appointmentId: string, staffId: string) {
  const appt = await t.selectFrom('appointments').select(['id', 'branchId', 'status', 'version', 'bookingNumber']).where('organizationId', '=', orgId).where('id', '=', appointmentId).executeTakeFirst();
  if (!appt) throw notFound('Appointment');
  const items = await t.selectFrom('appointmentItems').select(['id', 'serviceId', 'startAt']).where('appointmentId', '=', appt.id).where('staffId', '=', staffId).where('status', '!=', 'cancelled').orderBy('sortOrder').execute();
  if (!items.length) throw notFound('Appointment'); // not one of theirs: as if it did not exist
  return { appt, items };
}

// ───────────── /me: the team member's own view ─────────────
const mine = createRouter('/me', 'Team self-service');

mine.get(
  '/schedule',
  { summary: 'My working days: hours, breaks, blocked time, leave and holidays, with how many appointments each day', permissions: [...OWN], query: z.object({ from: zDate.optional(), to: zDate.optional() }) },
  async ({ tx, auth, query }) =>
    tx(async (t) => {
      const m = await me(t, auth);
      const tz = m.branch.timezone;
      const from = query.from ?? todayIn(tz);
      const to = query.to ?? addDays(from, 13);
      if (to < from || daysBetween(from, to) > 41) throw new AppError(400, 'VALIDATION_ERROR', 'Choose up to six weeks at a time.');
      const leaves = await t.selectFrom('staffLeaves').select(['startDate', 'endDate', 'leaveType']).where('staffId', '=', m.staffId).where('status', '=', 'approved').where('startDate', '<=', to).where('endDate', '>=', from).execute();
      const { start, end } = localRangeToUtc(from, to, tz);
      const booked = await t
        .selectFrom('appointmentItems as ai')
        .innerJoin('appointments as a', 'a.id', 'ai.appointmentId')
        .select(['ai.startAt'])
        .where('ai.staffId', '=', m.staffId)
        .where('ai.status', '!=', 'cancelled')
        .where('a.status', 'not in', ['cancelled', 'no_show'])
        .where('ai.startAt', '>=', start)
        .where('ai.startAt', '<', end)
        .execute();
      const perDay = new Map<string, number>();
      for (const b of booked) if (b.startAt) perDay.set(localDateOf(b.startAt, tz), (perDay.get(localDateOf(b.startAt, tz)) ?? 0) + 1);

      const days: MyScheduleDay[] = [];
      for (const date of eachDate(from, to)) {
        const day = await loadDayContext(t, m.orgId, m.branch, date);
        const load = await loadStaffDays(t, m.orgId, m.branch, day, { staffIds: [m.staffId], serviceIds: [], services: new Map(), includeUnqualified: true, includeInactive: true });
        const sd = load.days[0];
        const leave = leaves.find((l) => l.startDate <= date && l.endDate >= date);
        const status: MyScheduleDay['status'] = day.holiday ? 'holiday' : sd?.leave.full ? 'leave' : !sd || sd.working.length === 0 ? (day.branchOpen ? 'day_off' : 'branch_closed') : sd.leave.intervals.length ? 'half_leave' : 'working';
        days.push({
          date,
          status,
          hours: (sd?.working ?? []).map((w) => ({ start: hhmm(w.start, tz), end: hhmm(w.end, tz) })),
          breaks: (sd?.breaks ?? []).map((b) => ({ start: hhmm(b.start, tz), end: hhmm(b.end, tz), label: b.label })),
          blocks: (sd?.blocks ?? []).map((b) => ({ start: hhmm(b.start, tz), end: hhmm(b.end, tz), reason: b.reason })),
          leaveType: leave?.leaveType ?? null,
          holiday: day.holiday,
          appointments: perDay.get(date) ?? 0,
        });
      }
      return { staff: { id: m.staffId, displayName: m.displayName, branchName: m.branch.name }, timezone: tz, days };
    }),
);

mine.get('/leaves', { summary: 'My leave: requests and their answers', permissions: [...OWN] }, async ({ tx, auth }) =>
  tx(async (t) => {
    const m = await me(t, auth);
    return t
      .selectFrom('staffLeaves as l')
      .leftJoin('users as d', 'd.id', 'l.decidedBy')
      .select(['l.id', 'l.leaveType', 'l.startDate', 'l.endDate', 'l.halfDay', 'l.reason', 'l.status', 'l.decidedAt', 'l.createdAt', 'd.fullName as decidedByName'])
      .where('l.organizationId', '=', m.orgId)
      .where('l.staffId', '=', m.staffId)
      .orderBy('l.startDate', 'desc')
      .limit(100)
      .execute();
  }),
);

mine.post('/leaves', { summary: 'Ask for leave (waits for a manager); lists my bookings in those dates', permissions: [...OWN], body: leaveRequestSchema }, async ({ tx, auth, body }) =>
  tx(async (t) => {
    const m = await me(t, auth);
    if (body.startDate < todayIn(m.branch.timezone)) throw new AppError(400, 'VALIDATION_ERROR', 'Leave can only be asked for today or later.', { issues: [{ path: 'startDate', message: 'Choose today or a later date' }] });
    const overlapping = await t.selectFrom('staffLeaves').select('id').where('staffId', '=', m.staffId).where('status', 'in', ['pending', 'approved']).where('startDate', '<=', body.endDate).where('endDate', '>=', body.startDate).executeTakeFirst();
    if (overlapping) throw new AppError(409, 'CONFLICT', 'You already have leave asked for or approved on some of these dates.');
    const row = await t
      .insertInto('staffLeaves')
      .values({ organizationId: m.orgId, staffId: m.staffId, leaveType: body.leaveType, startDate: body.startDate, endDate: body.endDate, halfDay: body.halfDay, reason: body.reason, status: 'pending', createdBy: auth.userId })
      .returningAll()
      .executeTakeFirstOrThrow();
    const bookings = await leaveConflicts(t, m.staffId, body.startDate, body.endDate, m.branch.timezone);
    await audit(t, auth, { action: 'staff.leave_requested', entityType: 'staff_leave', entityId: row.id, branchId: m.branch.id, summary: `${m.displayName} asked for leave ${body.startDate} – ${body.endDate}`, after: row });
    return { leave: row, bookings };
  }),
);

mine.post('/leaves/:id/cancel', { summary: 'Withdraw a leave request that has not been answered yet', permissions: [...OWN], status: 200 }, async ({ tx, auth, params }) =>
  tx(async (t) => {
    const m = await me(t, auth);
    const row = await t.updateTable('staffLeaves').set({ status: 'cancelled', updatedAt: new Date() }).where('organizationId', '=', m.orgId).where('id', '=', params.id!).where('staffId', '=', m.staffId).where('status', '=', 'pending').returningAll().executeTakeFirst();
    if (!row) throw new AppError(409, 'CONFLICT', 'Only a request that is still waiting can be withdrawn. Ask your manager to change approved leave.');
    await audit(t, auth, { action: 'staff.leave_withdrawn', entityType: 'staff_leave', entityId: row.id, branchId: m.branch.id, summary: `${m.displayName} withdrew a leave request` });
    return row;
  }),
);

mine.get('/attendance', { summary: 'My attendance: days present, late, absent or on leave', permissions: [...OWN], query: z.object({ from: zDate.optional(), to: zDate.optional() }) }, async ({ tx, auth, query }) =>
  tx(async (t) => {
    const m = await me(t, auth);
    const to = query.to ?? todayIn(m.branch.timezone);
    const from = query.from ?? addDays(to, -29);
    if (to < from || daysBetween(from, to) > 62) throw new AppError(400, 'VALIDATION_ERROR', 'Choose up to two months at a time.');
    await recomputeBranch(t, m.orgId, m.branch, from, to);
    return loadAttendanceDays(t, m.orgId, [m.branch.id], { from, to, staffId: m.staffId });
  }),
);

mine.get('/appointments/:id/slots', { summary: 'Times I am free to move one of my appointments to, on a given day', permissions: [...OWN], query: z.object({ date: zDate }) }, async ({ tx, auth, params, query }) =>
  tx(async (t) => {
    const m = await me(t, auth);
    const { appt, items } = await myItems(t, m.orgId, params.id!, m.staffId);
    const result = await computeDayAvailability(t, m.orgId, { branchId: appt.branchId, date: query.date, serviceIds: items.map((i) => i.serviceId), staffId: m.staffId, excludeAppointmentId: appt.id });
    const mineToday = result.staff.find((s) => s.staffId === m.staffId);
    return { date: result.date, timezone: result.timezone, holiday: result.holiday, branchOpen: result.branchOpen, label: mineToday?.label ?? null, slots: mineToday?.slots ?? [] };
  }),
);

mine.get('/change-requests', { summary: 'My requests to move appointments, and their answers', permissions: [...OWN] }, async ({ tx, auth }) =>
  tx(async (t) => {
    const m = await me(t, auth);
    return changeRequestDtos(t, m.orgId, { staffId: m.staffId }, 50);
  }),
);

mine.post('/change-requests', { summary: 'Ask the front desk to move one of my appointments to a new time', permissions: [...OWN], body: changeRequestSchema }, async ({ tx, auth, body }) =>
  tx(async (t) => {
    const m = await me(t, auth);
    const { appt, items } = await myItems(t, m.orgId, body.appointmentId, m.staffId);
    if (!MOVABLE.includes(appt.status)) throw new AppError(409, 'INVALID_STATUS_TRANSITION', 'Only a booking that has not started can be moved.');
    const first = items[0]!;
    if (!first.startAt) throw new AppError(409, 'CONFLICT', 'This booking has no time yet; the front desk will give it one.');
    const proposed = new Date(body.proposedStartAt);
    if (proposed.getTime() < Date.now() + 5 * 60_000) throw new AppError(400, 'VALIDATION_ERROR', 'Choose a time later than now.', { issues: [{ path: 'proposedStartAt', message: 'Choose a later time' }] });
    if (proposed.getTime() === first.startAt.getTime()) throw new AppError(400, 'VALIDATION_ERROR', 'That is the time it is booked for already.', { issues: [{ path: 'proposedStartAt', message: 'Choose a different time' }] });
    const waiting = await t.selectFrom('appointmentChangeRequests').select('id').where('appointmentId', '=', appt.id).where('status', '=', 'pending').executeTakeFirst();
    if (waiting) throw new AppError(409, 'CONFLICT', 'A request to move this booking is already waiting for the front desk.');
    // Only offer what the calendar would accept: the proposed start must be one of my free times that day.
    const free = await computeDayAvailability(t, m.orgId, { branchId: appt.branchId, date: localDateOf(proposed, m.branch.timezone), serviceIds: items.map((i) => i.serviceId), staffId: m.staffId, excludeAppointmentId: appt.id });
    const slots = free.staff.find((s) => s.staffId === m.staffId)?.slots ?? [];
    if (!slots.includes(proposed.toISOString())) throw new AppError(422, 'STAFF_UNAVAILABLE', 'You are not free for this booking at that time. Choose one of the times offered.');
    const row = await t
      .insertInto('appointmentChangeRequests')
      .values({ organizationId: m.orgId, branchId: appt.branchId, appointmentId: appt.id, staffId: m.staffId, requestedBy: auth.userId, currentStartAt: first.startAt, proposedStartAt: proposed, reason: body.reason ?? null })
      .returning('id')
      .executeTakeFirstOrThrow();
    await audit(t, auth, { action: 'appointment.change_requested', entityType: 'appointment', entityId: appt.id, branchId: appt.branchId, summary: `${m.displayName} asked to move ${appt.bookingNumber}`, after: { proposedStartAt: proposed, reason: body.reason ?? null } });
    return (await changeRequestDtos(t, m.orgId, { ids: [row.id] }))[0]!;
  }),
);

mine.post('/change-requests/:id/cancel', { summary: 'Withdraw a request that the front desk has not answered yet', permissions: [...OWN], status: 200 }, async ({ tx, auth, params }) =>
  tx(async (t) => {
    const m = await me(t, auth);
    const row = await t.updateTable('appointmentChangeRequests').set({ status: 'cancelled', decidedAt: new Date(), decidedBy: auth.userId }).where('organizationId', '=', m.orgId).where('id', '=', params.id!).where('staffId', '=', m.staffId).where('status', '=', 'pending').returning('id').executeTakeFirst();
    if (!row) throw new AppError(409, 'CONFLICT', 'This request has already been answered.');
    return (await changeRequestDtos(t, m.orgId, { ids: [row.id] }))[0]!;
  }),
);

// ───────────── /change-requests: the front desk answers ─────────────
const desk = createRouter('/change-requests', 'Team self-service');

desk.get('/', { summary: 'Requests from team members to move their appointments', permissions: ['appointments.update'], query: z.object({ branchId: z.uuid().optional(), status: z.enum(['pending', 'approved', 'declined', 'cancelled']).optional() }) }, async ({ tx, auth, query }) =>
  tx((t) => changeRequestDtos(t, requireOrgId(auth), { branchIds: branchFilter(auth, query.branchId), status: query.status ?? 'pending' })),
);

async function pendingRequest(t: Tx, auth: AuthContext, id: string) {
  const orgId = requireOrgId(auth);
  const r = await t.selectFrom('appointmentChangeRequests').selectAll().where('organizationId', '=', orgId).where('id', '=', id).forUpdate().executeTakeFirst();
  if (!r) throw notFound('Request');
  assertBranchAccess(auth, r.branchId);
  if (r.status !== 'pending') throw new AppError(409, 'CONFLICT', 'This request has already been answered.');
  return { orgId, r };
}

desk.post('/:id/approve', { summary: 'Approve: move the booking to the proposed time and tell the customer', permissions: ['appointments.update'], body: changeDecisionSchema, status: 200 }, async ({ tx, auth, params, body }) =>
  tx(async (t) => {
    const { orgId, r } = await pendingRequest(t, auth, params.id!);
    const { appt, items } = await myItems(t, orgId, r.appointmentId, r.staffId).catch(() => {
      throw new AppError(409, 'CONFLICT', 'The team member no longer has a service in this booking. Decline the request.');
    });
    const first = items[0]!;
    if (!MOVABLE.includes(appt.status) || first.startAt?.getTime() !== r.currentStartAt.getTime()) {
      throw new AppError(409, 'CONFLICT', 'This booking has changed since the request was sent. Decline it and ask for a new request if needed.');
    }
    await moveAppointment(t, auth, appt.id, { version: appt.version, itemId: first.id, startAt: r.proposedStartAt.toISOString(), notifyCustomer: body.notifyCustomer, allowOutsideHours: false });
    await t.updateTable('appointmentChangeRequests').set({ status: 'approved', decidedBy: auth.userId, decidedAt: new Date(), decisionNote: body.note ?? null }).where('id', '=', r.id).execute();
    return (await changeRequestDtos(t, orgId, { ids: [r.id] }))[0]!;
  }),
);

desk.post('/:id/decline', { summary: 'Decline: the booking stays as it is', permissions: ['appointments.update'], body: changeDecisionSchema, status: 200 }, async ({ tx, auth, params, body }) =>
  tx(async (t) => {
    const { orgId, r } = await pendingRequest(t, auth, params.id!);
    await t.updateTable('appointmentChangeRequests').set({ status: 'declined', decidedBy: auth.userId, decidedAt: new Date(), decisionNote: body.note ?? null }).where('id', '=', r.id).execute();
    await audit(t, auth, { action: 'appointment.change_declined', entityType: 'appointment', entityId: r.appointmentId, branchId: r.branchId, summary: 'Request to move a booking declined', after: { note: body.note ?? null } });
    return (await changeRequestDtos(t, orgId, { ids: [r.id] }))[0]!;
  }),
);

export const meRoutes = mine;
export const changeRequestRoutes = desk;
