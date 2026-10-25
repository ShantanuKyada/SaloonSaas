import { branchHoursSchema, branchSchema, holidaySchema, zDate } from '@salon/shared';
import { z } from 'zod';
import { audit } from '../../core/audit.js';
import { assertBranchAccess, invalidatePrincipal, requireOrgId } from '../../core/auth-context.js';
import { AppError, notFound } from '../../core/errors.js';
import { createRouter } from '../../core/router.js';
import { loadOrg, optionalPhone } from '../../core/validation.js';
import type { Tx } from '../../db/tenant.js';

const r = createRouter('/branches', 'Branches');

async function branchWithHours(tx: Tx, orgId: string, branchId: string) {
  const branch = await tx
    .selectFrom('branches as b')
    .leftJoin('users as m', 'm.id', 'b.managerUserId')
    .selectAll('b')
    .select('m.fullName as managerName')
    .where('b.organizationId', '=', orgId)
    .where('b.id', '=', branchId)
    .executeTakeFirst();
  if (!branch) throw notFound('Branch');
  const hours = await tx
    .selectFrom('branchHours')
    .select(['weekday', 'isClosed', 'openTime', 'closeTime'])
    .where('branchId', '=', branchId)
    .orderBy('weekday')
    .execute();
  return { ...branch, hours: hours.map((h) => ({ ...h, openTime: h.openTime?.slice(0, 5) ?? null, closeTime: h.closeTime?.slice(0, 5) ?? null })) };
}

r.get('/', { summary: 'Branches the current user can access, with opening hours' }, async ({ tx, auth }) =>
  tx(async (t) => {
    const orgId = requireOrgId(auth);
    if (!auth.branchIds.length) return [];
    const rows = await t
      .selectFrom('branches as b')
      .leftJoin('users as m', 'm.id', 'b.managerUserId')
      .selectAll('b')
      .select('m.fullName as managerName')
      .where('b.organizationId', '=', orgId)
      .where('b.id', 'in', auth.branchIds)
      .orderBy('b.name')
      .execute();
    const hours = await t
      .selectFrom('branchHours')
      .select(['branchId', 'weekday', 'isClosed', 'openTime', 'closeTime'])
      .where('branchId', 'in', rows.map((b) => b.id))
      .orderBy('weekday')
      .execute();
    return rows.map((b) => ({
      ...b,
      hours: hours
        .filter((h) => h.branchId === b.id)
        .map((h) => ({ weekday: h.weekday, isClosed: h.isClosed, openTime: h.openTime?.slice(0, 5) ?? null, closeTime: h.closeTime?.slice(0, 5) ?? null })),
    }));
  }),
);

r.get('/:id', { summary: 'Branch details' }, async ({ tx, auth, params }) => {
  assertBranchAccess(auth, params.id!);
  return tx((t) => branchWithHours(t, requireOrgId(auth), params.id!));
});

r.post('/', { summary: 'Open a new branch', permissions: ['branches.manage'], body: branchSchema }, async ({ tx, auth, body }) =>
  tx(async (t) => {
    const orgId = requireOrgId(auth);
    const org = await loadOrg(t, orgId);
    const limits = await t.selectFrom('organizations').select('maxBranches').where('id', '=', orgId).executeTakeFirstOrThrow();
    if (limits.maxBranches) {
      const count = await t
        .selectFrom('branches')
        .select((eb) => eb.fn.countAll<number>().as('n'))
        .where('organizationId', '=', orgId)
        .where('status', '!=', 'archived')
        .executeTakeFirstOrThrow();
      if (count.n >= limits.maxBranches) {
        throw new AppError(409, 'CONFLICT', `Your plan allows ${limits.maxBranches} branches. Contact support to upgrade.`);
      }
    }
    const branch = await t
      .insertInto('branches')
      .values({ ...body, organizationId: orgId, phone: optionalPhone(body.phone, org.callingCode, 'phone') })
      .returningAll()
      .executeTakeFirstOrThrow();
    // Copy opening hours from the oldest branch so the new one is bookable immediately.
    const template = await t
      .selectFrom('branchHours as h')
      .innerJoin('branches as b', 'b.id', 'h.branchId')
      .select(['h.weekday', 'h.isClosed', 'h.openTime', 'h.closeTime', 'b.createdAt'])
      .where('b.organizationId', '=', orgId)
      .where('b.id', '!=', branch.id)
      .orderBy('b.createdAt')
      .limit(7)
      .execute();
    const hours = template.length === 7
      ? template.map((h) => ({ weekday: h.weekday, isClosed: h.isClosed, openTime: h.openTime, closeTime: h.closeTime }))
      : [1, 2, 3, 4, 5, 6, 7].map((weekday) => ({ weekday, isClosed: false, openTime: '10:00', closeTime: '20:00' }));
    await t.insertInto('branchHours').values(hours.map((h) => ({ ...h, organizationId: orgId, branchId: branch.id }))).execute();
    invalidatePrincipal();
    await audit(t, auth, { action: 'branch.created', entityType: 'branch', entityId: branch.id, branchId: branch.id, summary: `Branch ${branch.name} created`, after: branch });
    return branchWithHours(t, orgId, branch.id);
  }),
);

r.put('/:id', { summary: 'Update branch details', permissions: ['branches.manage'], body: branchSchema }, async ({ tx, auth, params, body }) => {
  assertBranchAccess(auth, params.id!);
  return tx(async (t) => {
    const orgId = requireOrgId(auth);
    const org = await loadOrg(t, orgId);
    const before = await t.selectFrom('branches').selectAll().where('organizationId', '=', orgId).where('id', '=', params.id!).executeTakeFirst();
    if (!before) throw notFound('Branch');
    const after = await t
      .updateTable('branches')
      .set({ ...body, phone: optionalPhone(body.phone, org.callingCode, 'phone') })
      .where('organizationId', '=', orgId)
      .where('id', '=', params.id!)
      .returningAll()
      .executeTakeFirstOrThrow();
    if (before.status !== after.status) invalidatePrincipal();
    await audit(t, auth, { action: 'branch.updated', entityType: 'branch', entityId: after.id, branchId: after.id, before, after });
    return branchWithHours(t, orgId, after.id);
  });
});

r.put('/:id/hours', { summary: 'Set weekly opening hours', permissions: ['branches.manage'], body: branchHoursSchema }, async ({ tx, auth, params, body }) => {
  assertBranchAccess(auth, params.id!);
  const weekdays = new Set(body.hours.map((h) => h.weekday));
  if (weekdays.size !== 7) throw new AppError(400, 'VALIDATION_ERROR', 'Provide each day of the week once.');
  return tx(async (t) => {
    const orgId = requireOrgId(auth);
    const before = await t.selectFrom('branchHours').selectAll().where('branchId', '=', params.id!).orderBy('weekday').execute();
    await t.deleteFrom('branchHours').where('branchId', '=', params.id!).execute();
    await t
      .insertInto('branchHours')
      .values(
        body.hours.map((h) => ({
          organizationId: orgId,
          branchId: params.id!,
          weekday: h.weekday,
          isClosed: h.isClosed,
          openTime: h.isClosed ? null : h.openTime!,
          closeTime: h.isClosed ? null : h.closeTime!,
        })),
      )
      .execute();
    await audit(t, auth, {
      action: 'branch.hours_updated',
      entityType: 'branch',
      entityId: params.id!,
      branchId: params.id!,
      before: { hours: before },
      after: { hours: body.hours },
    });
    return branchWithHours(t, orgId, params.id!);
  });
});

// ───────────── Holidays ─────────────
const holidays = createRouter('/holidays', 'Branches');

holidays.get(
  '/',
  { summary: 'Holidays (organization-wide and per branch)', query: z.object({ from: zDate.optional(), to: zDate.optional(), branchId: z.uuid().optional() }) },
  async ({ tx, auth, query }) =>
    tx(async (t) => {
      const orgId = requireOrgId(auth);
      let q = t
        .selectFrom('holidays as h')
        .leftJoin('branches as b', 'b.id', 'h.branchId')
        .select(['h.id', 'h.date', 'h.name', 'h.branchId', 'b.name as branchName'])
        .where('h.organizationId', '=', orgId)
        .where((eb) => eb.or([eb('h.branchId', 'is', null), eb('h.branchId', 'in', auth.branchIds.length ? auth.branchIds : ['00000000-0000-0000-0000-000000000000'])]));
      if (query.branchId) q = q.where((eb) => eb.or([eb('h.branchId', 'is', null), eb('h.branchId', '=', query.branchId!)]));
      if (query.from) q = q.where('h.date', '>=', query.from);
      if (query.to) q = q.where('h.date', '<=', query.to);
      return q.orderBy('h.date').limit(500).execute();
    }),
);

holidays.post('/', { summary: 'Add a holiday (closes the branch for bookings)', permissions: ['branches.manage'], body: holidaySchema }, async ({ tx, auth, body }) => {
  if (body.branchId) assertBranchAccess(auth, body.branchId);
  return tx(async (t) => {
    const row = await t
      .insertInto('holidays')
      .values({ organizationId: requireOrgId(auth), branchId: body.branchId, date: body.date, name: body.name })
      .returningAll()
      .executeTakeFirstOrThrow();
    await audit(t, auth, { action: 'holiday.created', entityType: 'holiday', entityId: row.id, branchId: row.branchId, after: row });
    return row;
  });
});

holidays.delete('/:id', { summary: 'Remove a holiday', permissions: ['branches.manage'], status: 204 }, async ({ tx, auth, params }) =>
  tx(async (t) => {
    const row = await t.deleteFrom('holidays').where('organizationId', '=', requireOrgId(auth)).where('id', '=', params.id!).returningAll().executeTakeFirst();
    if (!row) throw notFound('Holiday');
    if (row.branchId) assertBranchAccess(auth, row.branchId);
    await audit(t, auth, { action: 'holiday.deleted', entityType: 'holiday', entityId: row.id, branchId: row.branchId, before: row });
    return undefined;
  }),
);

export const branchRoutes = r;
export const holidayRoutes = holidays;
