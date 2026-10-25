import { categorySchema, expertiseSchema, paginationQuery, serviceSchema, type ServiceDto } from '@salon/shared';
import { sql } from 'kysely';
import { z } from 'zod';
import { audit } from '../../core/audit.js';
import { assertBranchAccess, requireOrgId } from '../../core/auth-context.js';
import { AppError, notFound } from '../../core/errors.js';
import { createRouter } from '../../core/router.js';
import type { Tx } from '../../db/tenant.js';

// ───────────── Expertise master ─────────────
const expertise = createRouter('/expertise', 'Services & expertise');

expertise.get('/', { summary: 'Expertise list with staff counts', permissions: ['services.view', 'staff.view'] }, async ({ tx, auth }) =>
  tx((t) =>
    t
      .selectFrom('expertise as e')
      .select(['e.id', 'e.name', 'e.description', 'e.status'])
      .select((eb) => eb.selectFrom('staffExpertise').select(eb.fn.countAll<number>().as('n')).whereRef('expertiseId', '=', 'e.id').as('staffCount'))
      .select((eb) => eb.selectFrom('serviceExpertise').select(eb.fn.countAll<number>().as('n')).whereRef('expertiseId', '=', 'e.id').as('serviceCount'))
      .where('e.organizationId', '=', requireOrgId(auth))
      .where('e.status', '=', 'active')
      .orderBy('e.name')
      .execute(),
  ),
);

expertise.post('/', { summary: 'Add an expertise', permissions: ['services.manage'], body: expertiseSchema }, async ({ tx, auth, body }) =>
  tx(async (t) => {
    const row = await t.insertInto('expertise').values({ organizationId: requireOrgId(auth), ...body }).returningAll().executeTakeFirstOrThrow();
    await audit(t, auth, { action: 'expertise.created', entityType: 'expertise', entityId: row.id, after: row });
    return row;
  }),
);

expertise.put('/:id', { summary: 'Rename an expertise', permissions: ['services.manage'], body: expertiseSchema }, async ({ tx, auth, params, body }) =>
  tx(async (t) => {
    const orgId = requireOrgId(auth);
    const before = await t.selectFrom('expertise').selectAll().where('organizationId', '=', orgId).where('id', '=', params.id!).executeTakeFirst();
    if (!before) throw notFound('Expertise');
    const after = await t.updateTable('expertise').set(body).where('id', '=', before.id).returningAll().executeTakeFirstOrThrow();
    await audit(t, auth, { action: 'expertise.updated', entityType: 'expertise', entityId: after.id, before, after });
    return after;
  }),
);

expertise.delete('/:id', { summary: 'Archive an expertise (history is kept)', permissions: ['services.manage'], status: 204 }, async ({ tx, auth, params }) =>
  tx(async (t) => {
    const orgId = requireOrgId(auth);
    const row = await t.updateTable('expertise').set({ status: 'archived' }).where('organizationId', '=', orgId).where('id', '=', params.id!).returningAll().executeTakeFirst();
    if (!row) throw notFound('Expertise');
    await t.deleteFrom('staffExpertise').where('expertiseId', '=', row.id).execute();
    await t.deleteFrom('serviceExpertise').where('expertiseId', '=', row.id).execute();
    await audit(t, auth, { action: 'expertise.archived', entityType: 'expertise', entityId: row.id, before: { name: row.name } });
    return undefined;
  }),
);

// ───────────── Service categories ─────────────
const categories = createRouter('/service-categories', 'Services & expertise');

categories.get('/', { summary: 'Service categories', permissions: ['services.view'] }, async ({ tx, auth }) =>
  tx((t) =>
    t
      .selectFrom('serviceCategories as c')
      .select(['c.id', 'c.name', 'c.description', 'c.color', 'c.sortOrder', 'c.status'])
      .select((eb) =>
        eb.selectFrom('services').select(eb.fn.countAll<number>().as('n')).whereRef('categoryId', '=', 'c.id').where('status', '!=', 'archived').as('serviceCount'),
      )
      .where('c.organizationId', '=', requireOrgId(auth))
      .where('c.status', '=', 'active')
      .orderBy('c.sortOrder')
      .orderBy('c.name')
      .execute(),
  ),
);

categories.post('/', { summary: 'Add a category', permissions: ['services.manage'], body: categorySchema }, async ({ tx, auth, body }) =>
  tx(async (t) => {
    const row = await t.insertInto('serviceCategories').values({ organizationId: requireOrgId(auth), ...body }).returningAll().executeTakeFirstOrThrow();
    await audit(t, auth, { action: 'category.created', entityType: 'service_category', entityId: row.id, after: row });
    return row;
  }),
);

categories.put('/:id', { summary: 'Edit a category', permissions: ['services.manage'], body: categorySchema }, async ({ tx, auth, params, body }) =>
  tx(async (t) => {
    const orgId = requireOrgId(auth);
    const before = await t.selectFrom('serviceCategories').selectAll().where('organizationId', '=', orgId).where('id', '=', params.id!).executeTakeFirst();
    if (!before) throw notFound('Category');
    const after = await t.updateTable('serviceCategories').set(body).where('id', '=', before.id).returningAll().executeTakeFirstOrThrow();
    await audit(t, auth, { action: 'category.updated', entityType: 'service_category', entityId: after.id, before, after });
    return after;
  }),
);

categories.delete('/:id', { summary: 'Archive an empty category', permissions: ['services.manage'], status: 204 }, async ({ tx, auth, params }) =>
  tx(async (t) => {
    const orgId = requireOrgId(auth);
    const used = await t.selectFrom('services').select('id').where('categoryId', '=', params.id!).where('status', '!=', 'archived').limit(1).executeTakeFirst();
    if (used) throw new AppError(409, 'CONFLICT', 'Move or archive the services in this category first.');
    const row = await t.updateTable('serviceCategories').set({ status: 'archived' }).where('organizationId', '=', orgId).where('id', '=', params.id!).returningAll().executeTakeFirst();
    if (!row) throw notFound('Category');
    await audit(t, auth, { action: 'category.archived', entityType: 'service_category', entityId: row.id, before: { name: row.name } });
    return undefined;
  }),
);

// ───────────── Services ─────────────
const services = createRouter('/services', 'Services & expertise');

export async function loadServices(tx: Tx, orgId: string, filter: { ids?: string[]; branchId?: string; includeInactive?: boolean; search?: string; categoryId?: string } = {}): Promise<ServiceDto[]> {
  let q = tx
    .selectFrom('services as s')
    .innerJoin('serviceCategories as c', 'c.id', 's.categoryId')
    .selectAll('s')
    .select(['c.name as categoryName', 'c.color as categoryColor'])
    .select((eb) =>
      eb
        .selectFrom('staffServices as ss')
        .innerJoin('staff as st', 'st.id', 'ss.staffId')
        .select(eb.fn.countAll<number>().as('n'))
        .whereRef('ss.serviceId', '=', 's.id')
        .where('ss.isActive', '=', true)
        .where('st.employmentStatus', 'in', ['active', 'on_notice'])
        .as('qualifiedStaffCount'),
    )
    .select((eb) =>
      eb
        .selectFrom('appointmentItems as ai')
        .select(eb.fn.countAll<number>().as('n'))
        .whereRef('ai.serviceId', '=', 's.id')
        .where('ai.createdAt', '>', sql<Date>`now() - interval '30 days'`)
        .where('ai.status', '!=', 'cancelled')
        .as('bookingsLast30Days'),
    )
    .where('s.organizationId', '=', orgId);
  if (filter.ids) q = q.where('s.id', 'in', filter.ids.length ? filter.ids : ['00000000-0000-0000-0000-000000000000']);
  if (!filter.includeInactive) q = q.where('s.status', '=', 'active');
  else q = q.where('s.status', '!=', 'archived');
  if (filter.categoryId) q = q.where('s.categoryId', '=', filter.categoryId);
  if (filter.search) {
    const term = `%${filter.search}%`;
    q = q.where((eb) => eb.or([eb('s.name', 'ilike', term), eb('s.code', 'ilike', term)]));
  }
  if (filter.branchId) {
    const branchId = filter.branchId;
    q = q.where((eb) =>
      eb.or([eb('s.allBranches', '=', true), eb.exists(eb.selectFrom('serviceBranches as sb').select('sb.serviceId').whereRef('sb.serviceId', '=', 's.id').where('sb.branchId', '=', branchId))]),
    );
  }
  const rows = await q.orderBy('c.sortOrder').orderBy('s.sortOrder').orderBy('s.name').execute();
  if (!rows.length) return [];
  const ids = rows.map((r) => r.id);
  const [branchRows, expertiseRows] = await Promise.all([
    tx.selectFrom('serviceBranches').select(['serviceId', 'branchId', 'priceOverride']).where('serviceId', 'in', ids).execute(),
    tx.selectFrom('serviceExpertise').select(['serviceId', 'expertiseId']).where('serviceId', 'in', ids).execute(),
  ]);
  return rows.map((s) => {
    const branches = branchRows.filter((b) => b.serviceId === s.id).map((b) => ({ branchId: b.branchId, priceOverride: b.priceOverride }));
    const branchPrice = filter.branchId ? branches.find((b) => b.branchId === filter.branchId)?.priceOverride : null;
    return {
      id: s.id,
      categoryId: s.categoryId,
      categoryName: s.categoryName,
      categoryColor: s.categoryColor,
      code: s.code,
      name: s.name,
      description: s.description,
      durationMinutes: s.durationMinutes,
      bufferMinutes: s.bufferMinutes,
      price: branchPrice ?? s.price,
      taxRateBp: s.taxRateBp,
      gender: s.gender,
      allBranches: s.allBranches,
      branches,
      expertiseIds: expertiseRows.filter((e) => e.serviceId === s.id).map((e) => e.expertiseId),
      onlineBookable: s.onlineBookable,
      sortOrder: s.sortOrder,
      status: s.status,
      qualifiedStaffCount: Number(s.qualifiedStaffCount ?? 0),
      bookingsLast30Days: Number(s.bookingsLast30Days ?? 0),
    };
  });
}

services.get(
  '/',
  {
    summary: 'Services (optionally only those offered at a branch, most-booked first when sort=popular)',
    permissions: ['services.view', 'appointments.create', 'billing.create'],
    query: paginationQuery.extend({
      branchId: z.uuid().optional(),
      categoryId: z.uuid().optional(),
      includeInactive: z.enum(['true', 'false']).optional(),
      sort: z.enum(['category', 'popular']).optional(),
    }),
  },
  async ({ tx, auth, query }) => {
    if (query.branchId) assertBranchAccess(auth, query.branchId);
    return tx(async (t) => {
      const rows = await loadServices(t, requireOrgId(auth), {
        branchId: query.branchId,
        categoryId: query.categoryId,
        includeInactive: query.includeInactive === 'true',
        search: query.search,
      });
      return query.sort === 'popular' ? [...rows].sort((a, b) => (b.bookingsLast30Days ?? 0) - (a.bookingsLast30Days ?? 0)) : rows;
    });
  },
);

services.get('/:id', { summary: 'Service details with qualified staff', permissions: ['services.view'] }, async ({ tx, auth, params }) =>
  tx(async (t) => {
    const orgId = requireOrgId(auth);
    const [service] = await loadServices(t, orgId, { ids: [params.id!], includeInactive: true });
    if (!service) throw notFound('Service');
    const staff = await t
      .selectFrom('staffServices as ss')
      .innerJoin('staff as s', 's.id', 'ss.staffId')
      .innerJoin('branches as b', 'b.id', 's.branchId')
      .select(['s.id', 's.displayName', 's.fullName', 'b.name as branchName', 'ss.durationMinutes', 'ss.priceOverride', 'ss.isActive'])
      .where('ss.serviceId', '=', service.id)
      .where('s.employmentStatus', 'in', ['active', 'on_notice'])
      .orderBy('s.displayName')
      .execute();
    return { ...service, staff };
  }),
);

async function writeServiceRelations(tx: Tx, orgId: string, serviceId: string, body: z.output<typeof serviceSchema>): Promise<void> {
  await tx.deleteFrom('serviceBranches').where('serviceId', '=', serviceId).execute();
  if (body.branches.length) {
    await tx
      .insertInto('serviceBranches')
      .values(body.branches.map((b) => ({ organizationId: orgId, serviceId, branchId: b.branchId, priceOverride: b.priceOverride ?? null })))
      .execute();
  }
  await tx.deleteFrom('serviceExpertise').where('serviceId', '=', serviceId).execute();
  if (body.expertiseIds.length) {
    await tx
      .insertInto('serviceExpertise')
      .values([...new Set(body.expertiseIds)].map((expertiseId) => ({ organizationId: orgId, serviceId, expertiseId })))
      .execute();
  }
}

function serviceColumns(body: z.output<typeof serviceSchema>) {
  const { branches: _branches, expertiseIds: _expertiseIds, ...columns } = body;
  return { ...columns, code: columns.code.toUpperCase(), taxRateBp: columns.taxRateBp ?? null };
}

services.post('/', { summary: 'Add a service', permissions: ['services.manage'], body: serviceSchema }, async ({ tx, auth, body }) =>
  tx(async (t) => {
    const orgId = requireOrgId(auth);
    const row = await t
      .insertInto('services')
      .values({ organizationId: orgId, ...serviceColumns(body), createdBy: auth.userId })
      .returning('id')
      .executeTakeFirstOrThrow();
    await writeServiceRelations(t, orgId, row.id, body);
    // Auto-qualify staff who already have a required expertise: fewer clicks during setup (requirement 86.2).
    if (body.expertiseIds.length) {
      await t
        .insertInto('staffServices')
        .columns(['organizationId', 'staffId', 'serviceId'])
        .expression((eb) =>
          eb
            .selectFrom('staffExpertise as se')
            .innerJoin('staff as s', 's.id', 'se.staffId')
            .select([sql<string>`${orgId}::uuid`.as('organizationId'), 'se.staffId', sql<string>`${row.id}::uuid`.as('serviceId')])
            .where('se.expertiseId', 'in', body.expertiseIds)
            .where('s.employmentStatus', 'in', ['active', 'on_notice'])
            .distinct(),
        )
        .onConflict((oc) => oc.doNothing())
        .execute();
    }
    const [service] = await loadServices(t, orgId, { ids: [row.id], includeInactive: true });
    await audit(t, auth, { action: 'service.created', entityType: 'service', entityId: row.id, summary: `Service ${body.name} added`, after: service as unknown as Record<string, unknown> });
    return service;
  }),
);

services.put('/:id', { summary: 'Edit a service', permissions: ['services.manage'], body: serviceSchema }, async ({ tx, auth, params, body }) =>
  tx(async (t) => {
    const orgId = requireOrgId(auth);
    const [before] = await loadServices(t, orgId, { ids: [params.id!], includeInactive: true });
    if (!before) throw notFound('Service');
    await t.updateTable('services').set(serviceColumns(body)).where('organizationId', '=', orgId).where('id', '=', params.id!).execute();
    await writeServiceRelations(t, orgId, params.id!, body);
    const [after] = await loadServices(t, orgId, { ids: [params.id!], includeInactive: true });
    await audit(t, auth, {
      action: 'service.updated',
      entityType: 'service',
      entityId: params.id!,
      before: before as unknown as Record<string, unknown>,
      after: after as unknown as Record<string, unknown>,
    });
    return after;
  }),
);

services.delete('/:id', { summary: 'Archive a service (past bookings and bills keep it)', permissions: ['services.manage'], status: 204 }, async ({ tx, auth, params }) =>
  tx(async (t) => {
    const orgId = requireOrgId(auth);
    const row = await t.updateTable('services').set({ status: 'archived' }).where('organizationId', '=', orgId).where('id', '=', params.id!).returningAll().executeTakeFirst();
    if (!row) throw notFound('Service');
    await t.updateTable('staffServices').set({ isActive: false }).where('serviceId', '=', row.id).execute();
    await audit(t, auth, { action: 'service.archived', entityType: 'service', entityId: row.id, summary: `Service ${row.name} archived` });
    return undefined;
  }),
);

export const expertiseRoutes = expertise;
export const categoryRoutes = categories;
export const serviceRoutes = services;
