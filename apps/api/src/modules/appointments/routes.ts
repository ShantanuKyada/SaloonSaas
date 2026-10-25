import {
  appointmentListQuery,
  appointmentStatusSchema,
  assignWalkInSchema,
  calendarQuery,
  createAppointmentSchema,
  createWalkInSchema,
  moveAppointmentSchema,
  updateAppointmentSchema,
  zDate,
  type AppointmentDto,
  type CalendarData,
  type CalendarResource,
} from '@salon/shared';
import { z } from 'zod';
import { assertBranchAccess, branchFilter, isOwnScopeOnly, nonEmpty, requireOrgId, type AuthContext } from '../../core/auth-context.js';
import { AppError, notFound } from '../../core/errors.js';
import { createRouter, paged } from '../../core/router.js';
import { eachDate, isoWeekday, localRangeToUtc, todayIn } from '../../core/time.js';
import { loadBranch, loadSettings } from '../../core/validation.js';
import type { Tx } from '../../db/tenant.js';
import { loadAppointmentDtos, visibleToOwnScope } from './dto.js';
import { assignWalkIn, changeStatus, createAppointment, createWalkIn, moveAppointment, updateAppointment } from './service.js';

const r = createRouter('/appointments', 'Appointments');
const VIEW = ['appointments.view', 'appointments.view_own'] as const;

async function oneDto(tx: Tx, auth: AuthContext, id: string): Promise<AppointmentDto> {
  const orgId = requireOrgId(auth);
  const settings = await loadSettings(tx, orgId);
  const [dto] = await loadAppointmentDtos(tx, auth, orgId, [id], settings);
  if (!dto) throw notFound('Appointment');
  assertBranchAccess(auth, dto.branchId);
  if (isOwnScopeOnly(auth) && !visibleToOwnScope(dto, auth.staffId)) throw notFound('Appointment');
  return dto;
}

r.get('/', { summary: 'Appointment list with filters (server-side pagination)', permissions: [...VIEW], query: appointmentListQuery }, async ({ tx, auth, query }) =>
  tx(async (t) => {
    const orgId = requireOrgId(auth);
    const settings = await loadSettings(t, orgId);
    let base = t
      .selectFrom('appointments as a')
      .innerJoin('customers as c', 'c.id', 'a.customerId')
      .where('a.organizationId', '=', orgId)
      .where('a.branchId', 'in', branchFilter(auth, query.branchId));
    if (isOwnScopeOnly(auth)) {
      const staffId = auth.staffId ?? '00000000-0000-0000-0000-000000000000';
      base = base.where((eb) => eb.exists(eb.selectFrom('appointmentItems as ai').select('ai.id').whereRef('ai.appointmentId', '=', 'a.id').where('ai.staffId', '=', staffId)));
    }
    if (query.from) base = base.where('a.localDate', '>=', query.from);
    if (query.to) base = base.where('a.localDate', '<=', query.to);
    if (query.status.length) base = base.where('a.status', 'in', query.status);
    if (query.source) base = base.where('a.source', '=', query.source);
    if (query.customerId) base = base.where('a.customerId', '=', query.customerId);
    if (query.staffId) {
      const id = query.staffId;
      base = base.where((eb) => eb.exists(eb.selectFrom('appointmentItems as ai').select('ai.id').whereRef('ai.appointmentId', '=', 'a.id').where('ai.staffId', '=', id)));
    }
    if (query.serviceId) {
      const id = query.serviceId;
      base = base.where((eb) => eb.exists(eb.selectFrom('appointmentItems as ai').select('ai.id').whereRef('ai.appointmentId', '=', 'a.id').where('ai.serviceId', '=', id)));
    }
    if (query.search) {
      const like = `%${query.search}%`;
      const digits = query.search.replace(/\D/g, '');
      base = base.where((eb) =>
        eb.or([
          eb('a.bookingNumber', 'ilike', like),
          eb('c.fullName', 'ilike', like),
          eb('c.customerCode', 'ilike', like),
          ...(digits.length >= 3 ? [eb('c.mobile', 'like', `%${digits}%`)] : []),
        ]),
      );
    }
    const { n } = await base.select((eb) => eb.fn.countAll<number>().as('n')).executeTakeFirstOrThrow();
    const asc = query.sortDir === 'asc';
    const rows = await base
      .select('a.id')
      .orderBy('a.startAt', (o) => (asc ? o.asc().nullsFirst() : o.desc().nullsFirst()))
      .orderBy('a.id')
      .limit(query.pageSize)
      .offset((query.page - 1) * query.pageSize)
      .execute();
    const dtos = await loadAppointmentDtos(t, auth, orgId, rows.map((x) => x.id), settings);
    return paged(dtos, n, query.page, query.pageSize);
  }),
);

r.get('/calendar', { summary: 'Calendar data: staff columns, working hours, leave, blocks and appointments for a date range', permissions: [...VIEW], query: calendarQuery }, async ({ tx, auth, query }) => {
  assertBranchAccess(auth, query.branchId);
  return tx(async (t): Promise<CalendarData> => {
    const orgId = requireOrgId(auth);
    const [branch, settings] = await Promise.all([loadBranch(t, orgId, query.branchId), loadSettings(t, orgId)]);
    const dates = eachDate(query.from, query.to);
    if (dates.length > 42) throw new AppError(400, 'BAD_REQUEST', 'Choose a range of at most six weeks.');
    const { start, end } = localRangeToUtc(query.from, query.to, branch.timezone);
    const ownOnly = isOwnScopeOnly(auth);

    const apptRows = await t
      .selectFrom('appointments as a')
      .select('a.id')
      .where('a.organizationId', '=', orgId)
      .where('a.branchId', '=', branch.id)
      .where('a.startAt', '<', end)
      .where('a.endAt', '>', start)
      .where('a.status', 'not in', ['cancelled', 'no_show', 'waiting'])
      .$if(ownOnly, (q) =>
        q.where((eb) => eb.exists(eb.selectFrom('appointmentItems as ai').select('ai.id').whereRef('ai.appointmentId', '=', 'a.id').where('ai.staffId', '=', auth.staffId ?? '00000000-0000-0000-0000-000000000000'))),
      )
      .orderBy('a.startAt')
      .limit(2000)
      .execute();
    const appointments = await loadAppointmentDtos(t, auth, orgId, apptRows.map((x) => x.id), settings);

    const usedStaff = new Set(appointments.flatMap((a) => a.items.map((i) => i.staffId)).filter((v): v is string => !!v));
    let staffQ = t
      .selectFrom('staff')
      .select(['id', 'displayName', 'calendarColor', 'photoUrl', 'isBookable', 'employmentStatus'])
      .where('organizationId', '=', orgId)
      .where('branchId', '=', branch.id)
      .where((eb) => eb.or([eb.and([eb('employmentStatus', 'in', ['active', 'on_notice']), eb('isBookable', '=', true)]), ...(usedStaff.size ? [eb('id', 'in', [...usedStaff])] : [])]));
    if (ownOnly) staffQ = staffQ.where('id', '=', auth.staffId ?? '00000000-0000-0000-0000-000000000000');
    if (query.staffIds.length) staffQ = staffQ.where('id', 'in', query.staffIds);
    const staffRows = await staffQ.orderBy('calendarOrder').orderBy('displayName').execute();
    const ids = nonEmpty(staffRows.map((s) => s.id));

    const [shifts, breaks, overrides, leaves, blocks, attendance, hours, holidays] = await Promise.all([
      t.selectFrom('staffShifts').select(['staffId', 'weekday', 'startTime', 'endTime']).where('staffId', 'in', ids).execute(),
      t.selectFrom('staffBreaks').select(['staffId', 'weekday', 'startTime', 'endTime', 'label']).where('staffId', 'in', ids).execute(),
      t.selectFrom('staffScheduleOverrides').select(['staffId', 'date', 'isWorking', 'startTime', 'endTime']).where('staffId', 'in', ids).where('date', '>=', query.from).where('date', '<=', query.to).execute(),
      t.selectFrom('staffLeaves').select(['staffId', 'startDate', 'endDate', 'halfDay', 'leaveType']).where('staffId', 'in', ids).where('status', '=', 'approved').where('startDate', '<=', query.to).where('endDate', '>=', query.from).execute(),
      t.selectFrom('staffTimeBlocks').select(['id', 'staffId', 'startAt', 'endAt', 'reason']).where('staffId', 'in', ids).where('startAt', '<', end).where('endAt', '>', start).execute(),
      query.from === query.to
        ? t.selectFrom('attendanceDays').select(['staffId', 'status']).where('branchId', '=', branch.id).where('date', '=', query.from).execute()
        : Promise.resolve([] as Array<{ staffId: string; status: string }>),
      t.selectFrom('branchHours').select(['weekday', 'isClosed', 'openTime', 'closeTime']).where('branchId', '=', branch.id).orderBy('weekday').execute(),
      t.selectFrom('holidays').select(['date', 'name']).where('organizationId', '=', orgId).where((eb) => eb.or([eb('branchId', 'is', null), eb('branchId', '=', branch.id)])).where('date', '>=', query.from).where('date', '<=', query.to).execute(),
    ]);
    const hm = (v: string) => v.slice(0, 5);

    const resources: CalendarResource[] = staffRows.map((s) => {
      const dayShifts: CalendarResource['shifts'] = [];
      const dayBreaks: CalendarResource['breaks'] = [];
      for (const date of dates) {
        const weekday = isoWeekday(date);
        const override = overrides.find((o) => o.staffId === s.id && o.date === date);
        if (override) {
          if (override.isWorking && override.startTime && override.endTime) dayShifts.push({ date, start: hm(override.startTime), end: hm(override.endTime) });
        } else {
          for (const sh of shifts.filter((x) => x.staffId === s.id && x.weekday === weekday)) dayShifts.push({ date, start: hm(sh.startTime), end: hm(sh.endTime) });
        }
        if (!override || override.isWorking) {
          for (const b of breaks.filter((x) => x.staffId === s.id && x.weekday === weekday)) dayBreaks.push({ date, start: hm(b.startTime), end: hm(b.endTime), label: b.label });
        }
      }
      const leaveDays: CalendarResource['leave'] = [];
      for (const l of leaves.filter((x) => x.staffId === s.id)) {
        for (const date of dates) if (date >= l.startDate && date <= l.endDate) leaveDays.push({ date, halfDay: l.halfDay, leaveType: l.leaveType });
      }
      return {
        staffId: s.id,
        displayName: s.displayName,
        color: s.calendarColor,
        photoUrl: s.photoUrl,
        shifts: dayShifts,
        breaks: dayBreaks,
        blocks: blocks.filter((b) => b.staffId === s.id).map((b) => ({ id: b.id, start: b.startAt.toISOString(), end: b.endAt.toISOString(), reason: b.reason })),
        leave: leaveDays,
        attendance: (attendance.find((a) => a.staffId === s.id)?.status as CalendarResource['attendance']) ?? null,
      };
    });

    return {
      branchId: branch.id,
      timezone: branch.timezone,
      from: query.from,
      to: query.to,
      branchHours: hours.map((h) => ({ weekday: h.weekday, isClosed: h.isClosed, openTime: h.openTime ? hm(h.openTime) : null, closeTime: h.closeTime ? hm(h.closeTime) : null })),
      holidays,
      resources,
      appointments,
    };
  });
});

r.get('/:id', { summary: 'Appointment details', permissions: [...VIEW] }, async ({ tx, auth, params }) => tx((t) => oneDto(t, auth, params.id!)));

r.get('/:id/events', { summary: 'Appointment timeline (created, moved, status changes)', permissions: [...VIEW] }, async ({ tx, auth, params }) =>
  tx(async (t) => {
    await oneDto(t, auth, params.id!);
    const rows = await t
      .selectFrom('appointmentEvents as e')
      .leftJoin('users as u', 'u.id', 'e.actorUserId')
      .select(['e.id', 'e.eventType', 'e.fromStatus', 'e.toStatus', 'e.data', 'u.fullName as actorName', 'e.createdAt'])
      .where('e.organizationId', '=', requireOrgId(auth))
      .where('e.appointmentId', '=', params.id!)
      .orderBy('e.id')
      .execute();
    return rows.map((e) => ({ ...e, data: (e.data as Record<string, unknown> | null) ?? null, createdAt: e.createdAt.toISOString() }));
  }),
);

r.post('/', { summary: 'Book an appointment', description: 'Validates qualification, working hours, leave, breaks and double-booking under a per-staff lock; queues the confirmation and reminders.', permissions: ['appointments.create'], body: createAppointmentSchema }, async ({ tx, auth, body }) =>
  tx(async (t) => {
    const id = await createAppointment(t, auth, body);
    return oneDto(t, auth, id);
  }),
);

r.put('/:id', { summary: 'Edit an appointment (services, staff, times, notes)', permissions: ['appointments.update'], body: updateAppointmentSchema }, async ({ tx, auth, params, body }) =>
  tx(async (t) => {
    await updateAppointment(t, auth, params.id!, body);
    return oneDto(t, auth, params.id!);
  }),
);

r.post('/:id/move', { summary: 'Drag-and-drop: move or reassign one service, or resize it', permissions: ['appointments.update'], body: moveAppointmentSchema, status: 200 }, async ({ tx, auth, params, body }) =>
  tx(async (t) => {
    await moveAppointment(t, auth, params.id!, body);
    return oneDto(t, auth, params.id!);
  }),
);

r.post('/:id/status', { summary: 'Update status: confirm, check in, start, complete, cancel, no-show, or restore', permissions: ['appointments.status', 'appointments.cancel'], body: appointmentStatusSchema, status: 200 }, async ({ tx, auth, params, body }) =>
  tx(async (t) => {
    await changeStatus(t, auth, params.id!, body);
    return oneDto(t, auth, params.id!);
  }),
);

// ───────────── Walk-ins ─────────────
const walkins = createRouter('/walkins', 'Appointments');

walkins.get('/', { summary: 'Walk-in board for a branch and day', permissions: ['walkins.manage', 'appointments.view'], query: z.object({ branchId: z.uuid(), date: zDate.optional() }) }, async ({ tx, auth, query }) => {
  assertBranchAccess(auth, query.branchId);
  return tx(async (t) => {
    const orgId = requireOrgId(auth);
    const branch = await loadBranch(t, orgId, query.branchId);
    const date = query.date ?? todayIn(branch.timezone);
    const rows = await t
      .selectFrom('appointments')
      .select('id')
      .where('organizationId', '=', orgId)
      .where('branchId', '=', branch.id)
      .where('source', '=', 'walk_in')
      .where('localDate', '=', date)
      .where('status', '!=', 'cancelled')
      .orderBy('queueNumber')
      .execute();
    // Walk-ins from earlier days still waiting or in service stay on the board until resolved.
    const stale = query.date
      ? []
      : await t
          .selectFrom('appointments')
          .select('id')
          .where('organizationId', '=', orgId)
          .where('branchId', '=', branch.id)
          .where('source', '=', 'walk_in')
          .where('localDate', '<', date)
          .where('status', 'in', ['waiting', 'checked_in', 'in_service'])
          .execute();
    return loadAppointmentDtos(t, auth, orgId, [...stale, ...rows].map((x) => x.id), await loadSettings(t, orgId));
  });
});

walkins.post('/', { summary: 'Register a walk-in (new or existing customer) and optionally start right away', permissions: ['walkins.manage'], body: createWalkInSchema }, async ({ tx, auth, body }) =>
  tx(async (t) => {
    const id = await createWalkIn(t, auth, body);
    return oneDto(t, auth, id);
  }),
);

walkins.post('/:id/assign', { summary: 'Assign team members to a waiting walk-in and start now or take the next free time', permissions: ['walkins.manage'], body: assignWalkInSchema, status: 200 }, async ({ tx, auth, params, body }) =>
  tx(async (t) => {
    await assignWalkIn(t, auth, params.id!, body);
    return oneDto(t, auth, params.id!);
  }),
);

export const appointmentRoutes = r;
export const walkInRoutes = walkins;
