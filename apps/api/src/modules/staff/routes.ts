import {
  leaveDecisionSchema,
  leaveSchema,
  paginationQuery,
  scheduleOverrideSchema,
  staffSchema,
  staffServicesSchema,
  staffWeeklyScheduleSchema,
  timeBlockSchema,
  zDate,
  type StaffListItem,
} from '@salon/shared';
import { sql } from 'kysely';
import { z } from 'zod';
import { audit } from '../../core/audit.js';
import { assertBranchAccess, branchFilter, hasPermission, requireOrgId, type AuthContext } from '../../core/auth-context.js';
import { AppError, notFound } from '../../core/errors.js';
import { createRouter, paged } from '../../core/router.js';
import { localRangeToUtc } from '../../core/time.js';
import { loadBranch, loadOrg, optionalPhone } from '../../core/validation.js';
import { advisoryLock, type Tx } from '../../db/tenant.js';

const r = createRouter('/staff', 'Staff');

async function loadStaff(tx: Tx, auth: AuthContext, staffId: string) {
  const orgId = requireOrgId(auth);
  const staff = await tx.selectFrom('staff').selectAll().where('organizationId', '=', orgId).where('id', '=', staffId).executeTakeFirst();
  if (!staff) throw notFound('Team member');
  assertBranchAccess(auth, staff.branchId);
  return staff;
}

const listQuery = paginationQuery.extend({
  branchId: z.uuid().optional(),
  status: z.enum(['active', 'all', 'inactive']).default('active'),
  expertiseId: z.uuid().optional(),
  serviceId: z.uuid().optional(),
  bookableOnly: z.enum(['true', 'false']).optional(),
});

r.get('/', { summary: 'Team members', permissions: ['staff.view', 'appointments.create', 'billing.create'], query: listQuery }, async ({ tx, auth, query }) =>
  tx(async (t) => {
    const orgId = requireOrgId(auth);
    const branches = branchFilter(auth, query.branchId);
    let base = t.selectFrom('staff as s').innerJoin('branches as b', 'b.id', 's.branchId').where('s.organizationId', '=', orgId).where('s.branchId', 'in', branches);
    if (query.status === 'active') base = base.where('s.employmentStatus', 'in', ['active', 'on_notice']);
    if (query.status === 'inactive') base = base.where('s.employmentStatus', 'in', ['inactive', 'terminated']);
    if (query.bookableOnly === 'true') base = base.where('s.isBookable', '=', true);
    if (query.search) {
      const term = `%${query.search}%`;
      base = base.where((eb) => eb.or([eb('s.fullName', 'ilike', term), eb('s.displayName', 'ilike', term), eb('s.employeeCode', 'ilike', term), eb('s.mobile', 'ilike', term)]));
    }
    if (query.expertiseId) {
      const id = query.expertiseId;
      base = base.where((eb) => eb.exists(eb.selectFrom('staffExpertise as se').select('se.staffId').whereRef('se.staffId', '=', 's.id').where('se.expertiseId', '=', id)));
    }
    if (query.serviceId) {
      const id = query.serviceId;
      base = base.where((eb) =>
        eb.exists(eb.selectFrom('staffServices as ss').select('ss.staffId').whereRef('ss.staffId', '=', 's.id').where('ss.serviceId', '=', id).where('ss.isActive', '=', true)),
      );
    }
    const { n } = await base.select((eb) => eb.fn.countAll<number>().as('n')).executeTakeFirstOrThrow();
    const rows = await base
      .select([
        's.id',
        's.employeeCode',
        's.fullName',
        's.displayName',
        's.branchId',
        'b.name as branchName',
        's.designation',
        's.mobile',
        's.employmentStatus',
        's.isBookable',
        's.calendarColor',
        's.photoUrl',
        's.userId',
        's.biometricPunchId',
      ])
      .select((eb) => eb.selectFrom('staffServices').select(eb.fn.countAll<number>().as('n')).whereRef('staffId', '=', 's.id').where('isActive', '=', true).as('serviceCount'))
      .orderBy('s.calendarOrder')
      .orderBy('s.displayName')
      .limit(query.pageSize)
      .offset((query.page - 1) * query.pageSize)
      .execute();
    const expertise = rows.length
      ? await t
          .selectFrom('staffExpertise as se')
          .innerJoin('expertise as e', 'e.id', 'se.expertiseId')
          .select(['se.staffId', 'e.id', 'e.name'])
          .where('se.staffId', 'in', rows.map((s) => s.id))
          .where('e.status', '=', 'active')
          .execute()
      : [];
    const items: StaffListItem[] = rows.map((s) => ({
      id: s.id,
      employeeCode: s.employeeCode,
      fullName: s.fullName,
      displayName: s.displayName,
      branchId: s.branchId,
      branchName: s.branchName,
      designation: s.designation,
      mobile: s.mobile,
      employmentStatus: s.employmentStatus as StaffListItem['employmentStatus'],
      isBookable: s.isBookable,
      calendarColor: s.calendarColor,
      photoUrl: s.photoUrl,
      expertise: expertise.filter((e) => e.staffId === s.id).map((e) => ({ id: e.id, name: e.name })),
      serviceCount: Number(s.serviceCount ?? 0),
      hasLogin: s.userId !== null,
      biometricPunchId: s.biometricPunchId,
    }));
    return paged(items, n, query.page, query.pageSize);
  }),
);

async function staffDetail(tx: Tx, auth: AuthContext, staffId: string) {
  const staff = await loadStaff(tx, auth, staffId);
  const [expertise, services, shifts, breaks, login, branch] = await Promise.all([
    tx
      .selectFrom('staffExpertise as se')
      .innerJoin('expertise as e', 'e.id', 'se.expertiseId')
      .select(['e.id', 'e.name'])
      .where('se.staffId', '=', staffId)
      .execute(),
    tx
      .selectFrom('staffServices as ss')
      .innerJoin('services as s', 's.id', 'ss.serviceId')
      .innerJoin('serviceCategories as c', 'c.id', 's.categoryId')
      .select([
        'ss.serviceId',
        's.name as serviceName',
        'c.name as categoryName',
        's.durationMinutes as defaultDuration',
        's.price as defaultPrice',
        'ss.durationMinutes',
        'ss.priceOverride',
        'ss.commissionType',
        'ss.commissionValue',
        'ss.isActive',
      ])
      .where('ss.staffId', '=', staffId)
      .where('s.status', '!=', 'archived')
      .orderBy('c.sortOrder')
      .orderBy('s.name')
      .execute(),
    tx.selectFrom('staffShifts').select(['id', 'weekday', 'startTime', 'endTime']).where('staffId', '=', staffId).orderBy('weekday').orderBy('startTime').execute(),
    tx.selectFrom('staffBreaks').select(['id', 'weekday', 'startTime', 'endTime', 'label']).where('staffId', '=', staffId).orderBy('weekday').orderBy('startTime').execute(),
    staff.userId ? tx.selectFrom('users').select(['id', 'email', 'phone', 'status', 'lastLoginAt']).where('id', '=', staff.userId).executeTakeFirst() : Promise.resolve(undefined),
    tx.selectFrom('branches').select(['id', 'name', 'timezone']).where('id', '=', staff.branchId).executeTakeFirstOrThrow(),
  ]);
  const canSeePrivate = hasPermission(auth, 'staff.manage');
  const trim = (v: string) => v.slice(0, 5);
  return {
    ...staff,
    dateOfBirth: canSeePrivate ? staff.dateOfBirth : null,
    address: canSeePrivate ? staff.address : null,
    commissionType: canSeePrivate ? staff.commissionType : null,
    commissionValue: canSeePrivate ? staff.commissionValue : null,
    branch,
    expertise,
    services,
    weeklySchedule: {
      shifts: shifts.map((s) => ({ ...s, startTime: trim(s.startTime), endTime: trim(s.endTime) })),
      breaks: breaks.map((b) => ({ ...b, startTime: trim(b.startTime), endTime: trim(b.endTime) })),
    },
    weeklyOffDays: [1, 2, 3, 4, 5, 6, 7].filter((d) => !shifts.some((s) => s.weekday === d)),
    login: login ?? null,
  };
}

r.get('/:id', { summary: 'Team member profile', permissions: ['staff.view'] }, async ({ tx, auth, params }) => tx((t) => staffDetail(t, auth, params.id!)));

async function syncExpertise(tx: Tx, orgId: string, staffId: string, expertiseIds: string[]): Promise<void> {
  await tx.deleteFrom('staffExpertise').where('staffId', '=', staffId).execute();
  const ids = [...new Set(expertiseIds)];
  if (ids.length) await tx.insertInto('staffExpertise').values(ids.map((expertiseId) => ({ organizationId: orgId, staffId, expertiseId }))).execute();
}

/** Qualifies the team member for every active service whose required expertise they have. */
async function autoMapServices(tx: Tx, orgId: string, staffId: string): Promise<number> {
  const result = await tx
    .insertInto('staffServices')
    .columns(['organizationId', 'staffId', 'serviceId'])
    .expression((eb) =>
      eb
        .selectFrom('serviceExpertise as sx')
        .innerJoin('staffExpertise as se', 'se.expertiseId', 'sx.expertiseId')
        .innerJoin('services as s', 's.id', 'sx.serviceId')
        .select([sql<string>`${orgId}::uuid`.as('organizationId'), sql<string>`${staffId}::uuid`.as('staffId'), 'sx.serviceId'])
        .where('se.staffId', '=', staffId)
        .where('s.status', '=', 'active')
        .distinct(),
    )
    .onConflict((oc) => oc.columns(['staffId', 'serviceId']).doUpdateSet({ isActive: true }))
    .executeTakeFirst();
  return Number(result.numInsertedOrUpdatedRows ?? 0);
}

function staffColumns(body: z.output<typeof staffSchema>, callingCode: string) {
  const { expertiseIds: _expertiseIds, ...columns } = body;
  return {
    ...columns,
    employeeCode: columns.employeeCode.toUpperCase(),
    mobile: optionalPhone(columns.mobile, callingCode, 'mobile'),
    isBookable: columns.employmentStatus === 'terminated' || columns.employmentStatus === 'inactive' ? false : columns.isBookable,
  };
}

r.post('/', { summary: 'Add a team member (working hours default to branch hours)', permissions: ['staff.manage'], body: staffSchema }, async ({ tx, auth, body }) => {
  assertBranchAccess(auth, body.branchId);
  return tx(async (t) => {
    const orgId = requireOrgId(auth);
    const org = await loadOrg(t, orgId);
    const staff = await t
      .insertInto('staff')
      .values({ organizationId: orgId, ...staffColumns(body, org.callingCode), createdBy: auth.userId })
      .returning('id')
      .executeTakeFirstOrThrow();
    await syncExpertise(t, orgId, staff.id, body.expertiseIds);
    await autoMapServices(t, orgId, staff.id);
    const hours = await t.selectFrom('branchHours').selectAll().where('branchId', '=', body.branchId).where('isClosed', '=', false).execute();
    if (hours.length) {
      await t
        .insertInto('staffShifts')
        .values(hours.map((h) => ({ organizationId: orgId, staffId: staff.id, weekday: h.weekday, startTime: h.openTime!, endTime: h.closeTime! })))
        .execute();
    }
    const detail = await staffDetail(t, auth, staff.id);
    await audit(t, auth, { action: 'staff.created', entityType: 'staff', entityId: staff.id, branchId: body.branchId, summary: `${body.fullName} added to the team`, after: body });
    return detail;
  });
});

r.put('/:id', { summary: 'Edit a team member', permissions: ['staff.manage'], body: staffSchema }, async ({ tx, auth, params, body }) => {
  assertBranchAccess(auth, body.branchId);
  return tx(async (t) => {
    const orgId = requireOrgId(auth);
    const org = await loadOrg(t, orgId);
    const before = await loadStaff(t, auth, params.id!);
    const leaving = ['terminated', 'inactive'].includes(body.employmentStatus) && !['terminated', 'inactive'].includes(before.employmentStatus);
    if (leaving || body.branchId !== before.branchId) {
      const future = await t
        .selectFrom('appointmentItems')
        .select((eb) => eb.fn.countAll<number>().as('n'))
        .where('staffId', '=', before.id)
        .where('blocksSchedule', '=', true)
        .where('startAt', '>', new Date())
        .where('status', '=', 'pending')
        .executeTakeFirstOrThrow();
      if (future.n > 0) {
        throw new AppError(
          409,
          'CONFLICT',
          `${before.displayName} has ${future.n} upcoming appointment(s). Reassign them before ${leaving ? 'marking this team member as left' : 'moving them to another branch'}.`,
          { upcomingAppointments: future.n },
        );
      }
    }
    await t.updateTable('staff').set(staffColumns(body, org.callingCode)).where('organizationId', '=', orgId).where('id', '=', before.id).execute();
    await syncExpertise(t, orgId, before.id, body.expertiseIds);
    if (leaving && before.userId) {
      await t.updateTable('users').set({ status: 'disabled' }).where('id', '=', before.userId).execute();
      await t.updateTable('refreshTokens').set({ revokedAt: new Date(), revokedReason: 'staff_left' }).where('userId', '=', before.userId).where('revokedAt', 'is', null).execute();
    }
    const after = await staffDetail(t, auth, before.id);
    await audit(t, auth, { action: 'staff.updated', entityType: 'staff', entityId: before.id, branchId: body.branchId, before, after: { ...after, expertiseIds: body.expertiseIds } });
    return after;
  });
});

r.put('/:id/services', { summary: 'Set the services this team member is qualified for', permissions: ['staff.manage'], body: staffServicesSchema }, async ({ tx, auth, params, body }) =>
  tx(async (t) => {
    const orgId = requireOrgId(auth);
    const staff = await loadStaff(t, auth, params.id!);
    const serviceIds = [...new Set(body.services.map((s) => s.serviceId))];
    if (serviceIds.length) {
      // A service's required expertise must be held by the team member (business rule: no unqualified assignment).
      const required = await t
        .selectFrom('serviceExpertise as sx')
        .innerJoin('services as s', 's.id', 'sx.serviceId')
        .select(['sx.serviceId', 'sx.expertiseId', 's.name'])
        .where('sx.serviceId', 'in', serviceIds)
        .execute();
      const held = new Set((await t.selectFrom('staffExpertise').select('expertiseId').where('staffId', '=', staff.id).execute()).map((e) => e.expertiseId));
      const unqualified = new Map<string, string>();
      for (const sid of serviceIds) {
        const reqs = required.filter((r) => r.serviceId === sid);
        if (reqs.length && !reqs.some((r) => held.has(r.expertiseId))) unqualified.set(sid, reqs[0]!.name);
      }
      const active = body.services.filter((s) => s.isActive && unqualified.has(s.serviceId));
      if (active.length) {
        throw new AppError(
          422,
          'STAFF_NOT_QUALIFIED',
          `${staff.displayName} needs the right expertise for: ${active.map((s) => unqualified.get(s.serviceId)).join(', ')}. Add the expertise first.`,
          { serviceIds: active.map((s) => s.serviceId) },
        );
      }
    }
    const before = await t.selectFrom('staffServices').selectAll().where('staffId', '=', staff.id).execute();
    await t.deleteFrom('staffServices').where('staffId', '=', staff.id).execute();
    if (body.services.length) {
      await t
        .insertInto('staffServices')
        .values(
          body.services.map((s) => ({
            organizationId: orgId,
            staffId: staff.id,
            serviceId: s.serviceId,
            durationMinutes: s.durationMinutes ?? null,
            priceOverride: s.priceOverride ?? null,
            commissionType: s.commissionType ?? null,
            commissionValue: s.commissionValue ?? null,
            isActive: s.isActive,
          })),
        )
        .execute();
    }
    await audit(t, auth, {
      action: 'staff.services_updated',
      entityType: 'staff',
      entityId: staff.id,
      branchId: staff.branchId,
      summary: `Service list updated for ${staff.displayName}`,
      before: { services: before.map((s) => s.serviceId).sort() },
      after: { services: body.services.filter((s) => s.isActive).map((s) => s.serviceId).sort() },
    });
    return staffDetail(t, auth, staff.id);
  }),
);

r.post('/:id/services/auto-map', { summary: 'Qualify for all services matching this team member’s expertise', permissions: ['staff.manage'], status: 200 }, async ({ tx, auth, params }) =>
  tx(async (t) => {
    const staff = await loadStaff(t, auth, params.id!);
    const count = await autoMapServices(t, requireOrgId(auth), staff.id);
    await audit(t, auth, { action: 'staff.services_auto_mapped', entityType: 'staff', entityId: staff.id, summary: `${count} services mapped by expertise` });
    return staffDetail(t, auth, staff.id);
  }),
);

r.put('/:id/schedule', { summary: 'Set weekly working hours and breaks', permissions: ['staff.schedule'], body: staffWeeklyScheduleSchema }, async ({ tx, auth, params, body }) =>
  tx(async (t) => {
    const orgId = requireOrgId(auth);
    const staff = await loadStaff(t, auth, params.id!);
    for (const br of body.breaks) {
      const inside = body.shifts.some((s) => s.weekday === br.weekday && s.startTime <= br.startTime && s.endTime >= br.endTime);
      if (!inside) throw new AppError(400, 'VALIDATION_ERROR', 'Each break must fall inside a working shift on the same day.', { issues: [{ path: 'breaks', message: 'Break outside working hours' }] });
    }
    const before = await t.selectFrom('staffShifts').select(['weekday', 'startTime', 'endTime']).where('staffId', '=', staff.id).execute();
    await t.deleteFrom('staffShifts').where('staffId', '=', staff.id).execute();
    await t.deleteFrom('staffBreaks').where('staffId', '=', staff.id).execute();
    if (body.shifts.length) await t.insertInto('staffShifts').values(body.shifts.map((s) => ({ organizationId: orgId, staffId: staff.id, ...s }))).execute();
    if (body.breaks.length) await t.insertInto('staffBreaks').values(body.breaks.map((b) => ({ organizationId: orgId, staffId: staff.id, ...b }))).execute();
    await audit(t, auth, {
      action: 'staff.schedule_updated',
      entityType: 'staff',
      entityId: staff.id,
      branchId: staff.branchId,
      summary: `Working hours updated for ${staff.displayName}`,
      before: { shifts: before },
      after: { shifts: body.shifts, breaks: body.breaks },
    });
    return staffDetail(t, auth, staff.id);
  }),
);

// ───────────── Date-specific schedule changes ─────────────
r.get(
  '/:id/overrides',
  { summary: 'Date-specific schedule changes', permissions: ['staff.view'], query: z.object({ from: zDate, to: zDate }) },
  async ({ tx, auth, params, query }) =>
    tx(async (t) => {
      await loadStaff(t, auth, params.id!);
      return t.selectFrom('staffScheduleOverrides').selectAll().where('staffId', '=', params.id!).where('date', '>=', query.from).where('date', '<=', query.to).orderBy('date').execute();
    }),
);

r.post('/:id/overrides', { summary: 'Change working hours for one day (extra day, early leave, day off)', permissions: ['staff.schedule'], body: scheduleOverrideSchema }, async ({ tx, auth, params, body }) =>
  tx(async (t) => {
    const staff = await loadStaff(t, auth, params.id!);
    const row = await t
      .insertInto('staffScheduleOverrides')
      .values({
        organizationId: requireOrgId(auth),
        staffId: staff.id,
        date: body.date,
        isWorking: body.isWorking,
        startTime: body.isWorking ? body.startTime! : null,
        endTime: body.isWorking ? body.endTime! : null,
        reason: body.reason,
        createdBy: auth.userId,
      })
      .onConflict((oc) =>
        oc.columns(['staffId', 'date']).doUpdateSet({
          isWorking: body.isWorking,
          startTime: body.isWorking ? body.startTime! : null,
          endTime: body.isWorking ? body.endTime! : null,
          reason: body.reason,
        }),
      )
      .returningAll()
      .executeTakeFirstOrThrow();
    await audit(t, auth, { action: 'staff.override_set', entityType: 'staff', entityId: staff.id, branchId: staff.branchId, summary: `Schedule change for ${staff.displayName} on ${body.date}`, after: row });
    return row;
  }),
);

r.delete('/:id/overrides/:overrideId', { summary: 'Remove a one-day schedule change', permissions: ['staff.schedule'], status: 204 }, async ({ tx, auth, params }) =>
  tx(async (t) => {
    const staff = await loadStaff(t, auth, params.id!);
    const row = await t.deleteFrom('staffScheduleOverrides').where('staffId', '=', staff.id).where('id', '=', params.overrideId!).returningAll().executeTakeFirst();
    if (!row) throw notFound('Schedule change');
    await audit(t, auth, { action: 'staff.override_removed', entityType: 'staff', entityId: staff.id, branchId: staff.branchId, before: row });
    return undefined;
  }),
);

// ───────────── Leave ─────────────
const leaves = createRouter('/staff-leaves', 'Staff');

async function leaveConflicts(tx: Tx, staffId: string, startDate: string, endDate: string, timezone: string) {
  const { start, end } = localRangeToUtc(startDate, endDate, timezone);
  return tx
    .selectFrom('appointmentItems as ai')
    .innerJoin('appointments as a', 'a.id', 'ai.appointmentId')
    .innerJoin('customers as c', 'c.id', 'a.customerId')
    .innerJoin('services as s', 's.id', 'ai.serviceId')
    .select(['a.id as appointmentId', 'a.bookingNumber', 'ai.startAt', 'c.fullName as customerName', 's.name as serviceName'])
    .where('ai.staffId', '=', staffId)
    .where('ai.blocksSchedule', '=', true)
    .where('ai.status', '=', 'pending')
    .where('ai.startAt', '>=', start)
    .where('ai.startAt', '<', end)
    .orderBy('ai.startAt')
    .execute();
}

leaves.get(
  '/',
  {
    summary: 'Leave records',
    permissions: ['staff.view'],
    query: z.object({ branchId: z.uuid().optional(), staffId: z.uuid().optional(), from: zDate.optional(), to: zDate.optional(), status: z.enum(['pending', 'approved', 'rejected', 'cancelled']).optional() }),
  },
  async ({ tx, auth, query }) =>
    tx(async (t) => {
      const orgId = requireOrgId(auth);
      let q = t
        .selectFrom('staffLeaves as l')
        .innerJoin('staff as s', 's.id', 'l.staffId')
        .leftJoin('users as d', 'd.id', 'l.decidedBy')
        .selectAll('l')
        .select(['s.displayName as staffName', 's.branchId', 'd.fullName as decidedByName'])
        .where('l.organizationId', '=', orgId)
        .where('s.branchId', 'in', branchFilter(auth, query.branchId));
      if (query.staffId) q = q.where('l.staffId', '=', query.staffId);
      if (query.from) q = q.where('l.endDate', '>=', query.from);
      if (query.to) q = q.where('l.startDate', '<=', query.to);
      if (query.status) q = q.where('l.status', '=', query.status);
      return q.orderBy('l.startDate', 'desc').limit(500).execute();
    }),
);

leaves.post('/', { summary: 'Record leave (returns bookings that need reassignment)', permissions: ['staff.schedule'], body: leaveSchema }, async ({ tx, auth, body }) =>
  tx(async (t) => {
    const orgId = requireOrgId(auth);
    const staff = await loadStaff(t, auth, body.staffId);
    const branch = await loadBranch(t, orgId, staff.branchId);
    const overlapping = await t
      .selectFrom('staffLeaves')
      .select('id')
      .where('staffId', '=', staff.id)
      .where('status', 'in', ['pending', 'approved'])
      .where('startDate', '<=', body.endDate)
      .where('endDate', '>=', body.startDate)
      .executeTakeFirst();
    if (overlapping) throw new AppError(409, 'CONFLICT', 'Leave already exists for some of these dates.');
    const row = await t
      .insertInto('staffLeaves')
      .values({
        organizationId: orgId,
        staffId: staff.id,
        leaveType: body.leaveType,
        startDate: body.startDate,
        endDate: body.endDate,
        halfDay: body.halfDay,
        reason: body.reason,
        status: body.status,
        decidedBy: body.status === 'approved' ? auth.userId : null,
        decidedAt: body.status === 'approved' ? new Date() : null,
        createdBy: auth.userId,
      })
      .returningAll()
      .executeTakeFirstOrThrow();
    const conflicts = body.status === 'approved' && body.halfDay === 'none' ? await leaveConflicts(t, staff.id, body.startDate, body.endDate, branch.timezone) : [];
    await audit(t, auth, { action: 'staff.leave_recorded', entityType: 'staff_leave', entityId: row.id, branchId: staff.branchId, summary: `${staff.displayName} on leave ${body.startDate} – ${body.endDate}`, after: row });
    return { leave: row, conflicts };
  }),
);

leaves.patch('/:id', { summary: 'Approve, reject or cancel leave', permissions: ['staff.schedule'], body: leaveDecisionSchema }, async ({ tx, auth, params, body }) =>
  tx(async (t) => {
    const orgId = requireOrgId(auth);
    const before = await t.selectFrom('staffLeaves').selectAll().where('organizationId', '=', orgId).where('id', '=', params.id!).executeTakeFirst();
    if (!before) throw notFound('Leave');
    const staff = await loadStaff(t, auth, before.staffId);
    const branch = await loadBranch(t, orgId, staff.branchId);
    const after = await t
      .updateTable('staffLeaves')
      .set({ status: body.status, decidedBy: auth.userId, decidedAt: new Date() })
      .where('id', '=', before.id)
      .returningAll()
      .executeTakeFirstOrThrow();
    const conflicts = body.status === 'approved' && after.halfDay === 'none' ? await leaveConflicts(t, staff.id, after.startDate, after.endDate, branch.timezone) : [];
    await audit(t, auth, { action: `staff.leave_${body.status}`, entityType: 'staff_leave', entityId: after.id, branchId: staff.branchId, before, after });
    return { leave: after, conflicts };
  }),
);

// ───────────── Blocked time ─────────────
const blocks = createRouter('/staff-time-blocks', 'Staff');

blocks.get(
  '/',
  { summary: 'Blocked time (training, personal work, etc.)', permissions: ['staff.view', 'appointments.view'], query: z.object({ branchId: z.uuid(), from: zDate, to: zDate }) },
  async ({ tx, auth, query }) => {
    assertBranchAccess(auth, query.branchId);
    return tx(async (t) => {
      const orgId = requireOrgId(auth);
      const branch = await loadBranch(t, orgId, query.branchId);
      const { start, end } = localRangeToUtc(query.from, query.to, branch.timezone);
      return t
        .selectFrom('staffTimeBlocks as b')
        .innerJoin('staff as s', 's.id', 'b.staffId')
        .selectAll('b')
        .select('s.displayName as staffName')
        .where('b.organizationId', '=', orgId)
        .where('b.branchId', '=', query.branchId)
        .where('b.startAt', '<', end)
        .where('b.endAt', '>', start)
        .orderBy('b.startAt')
        .execute();
    });
  },
);

blocks.post('/', { summary: 'Block a team member’s time', permissions: ['staff.schedule'], body: timeBlockSchema }, async ({ tx, auth, body }) =>
  tx(async (t) => {
    const orgId = requireOrgId(auth);
    const staff = await loadStaff(t, auth, body.staffId);
    await advisoryLock(t, 'staff-schedule', staff.id);
    const clash = await t
      .selectFrom('appointmentItems as ai')
      .innerJoin('appointments as a', 'a.id', 'ai.appointmentId')
      .select(['a.bookingNumber', 'ai.startAt'])
      .where('ai.staffId', '=', staff.id)
      .where('ai.blocksSchedule', '=', true)
      .where('ai.startAt', '<', new Date(body.endAt))
      .where('ai.blockedUntil', '>', new Date(body.startAt))
      .limit(5)
      .execute();
    if (clash.length) {
      throw new AppError(409, 'APPOINTMENT_CONFLICT', `${staff.displayName} has appointments in this period. Move them first, then block the time.`, { bookings: clash.map((c) => c.bookingNumber) });
    }
    const row = await t
      .insertInto('staffTimeBlocks')
      .values({ organizationId: orgId, branchId: staff.branchId, staffId: staff.id, startAt: new Date(body.startAt), endAt: new Date(body.endAt), reason: body.reason, createdBy: auth.userId })
      .returningAll()
      .executeTakeFirstOrThrow();
    await audit(t, auth, { action: 'staff.time_blocked', entityType: 'staff_time_block', entityId: row.id, branchId: staff.branchId, summary: `Blocked time for ${staff.displayName}: ${body.reason}`, after: row });
    return row;
  }),
);

blocks.delete('/:id', { summary: 'Remove blocked time', permissions: ['staff.schedule'], status: 204 }, async ({ tx, auth, params }) =>
  tx(async (t) => {
    const orgId = requireOrgId(auth);
    const row = await t.selectFrom('staffTimeBlocks').selectAll().where('organizationId', '=', orgId).where('id', '=', params.id!).executeTakeFirst();
    if (!row) throw notFound('Blocked time');
    assertBranchAccess(auth, row.branchId);
    await t.deleteFrom('staffTimeBlocks').where('id', '=', row.id).execute();
    await audit(t, auth, { action: 'staff.time_unblocked', entityType: 'staff_time_block', entityId: row.id, branchId: row.branchId, before: row });
    return undefined;
  }),
);

export const staffRoutes = r;
export const leaveRoutes = leaves;
export const timeBlockRoutes = blocks;
