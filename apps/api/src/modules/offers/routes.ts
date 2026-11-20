import { offerSchema, packageSchema, paginationQuery } from '@salon/shared';
import { z } from 'zod';
import { audit } from '../../core/audit.js';
import { assertBranchAccess, requireOrgId } from '../../core/auth-context.js';
import { AppError, notFound } from '../../core/errors.js';
import { createRouter } from '../../core/router.js';
import { todayIn } from '../../core/time.js';
import { loadOrg } from '../../core/validation.js';
import type { Tx } from '../../db/tenant.js';

type OfferOut = z.output<typeof offerSchema>;
type PackageOut = z.output<typeof packageSchema>;

// ───────────── Offers ─────────────
const offers = createRouter('/offers', 'Offers & packages');

async function offerDto(tx: Tx, orgId: string, id: string, today: string) {
  const o = await tx.selectFrom('offers').selectAll().where('organizationId', '=', orgId).where('id', '=', id).executeTakeFirst();
  if (!o) throw notFound('Offer');
  const [services, categories, branches, customers] = await Promise.all([
    tx.selectFrom('offerServices').select('serviceId').where('offerId', '=', id).execute(),
    tx.selectFrom('offerCategories').select('categoryId').where('offerId', '=', id).execute(),
    tx.selectFrom('offerBranches').select('branchId').where('offerId', '=', id).execute(),
    tx.selectFrom('offerCustomers as oc').innerJoin('customers as c', 'c.id', 'oc.customerId').select(['c.id', 'c.fullName']).where('oc.offerId', '=', id).execute(),
  ]);
  const state = o.status === 'archived' ? 'archived' : o.status !== 'active' ? 'inactive' : today < o.validFrom ? 'scheduled' : today > o.validTo ? 'expired' : o.usageLimitTotal !== null && o.usageCount >= o.usageLimitTotal ? 'used_up' : 'running';
  return { ...o, state, serviceIds: services.map((s) => s.serviceId), categoryIds: categories.map((c) => c.categoryId), branchIds: branches.map((b) => b.branchId), customers };
}

async function writeOfferRelations(tx: Tx, orgId: string, id: string, body: OfferOut): Promise<void> {
  await Promise.all([
    tx.deleteFrom('offerServices').where('offerId', '=', id).execute(),
    tx.deleteFrom('offerCategories').where('offerId', '=', id).execute(),
    tx.deleteFrom('offerBranches').where('offerId', '=', id).execute(),
    tx.deleteFrom('offerCustomers').where('offerId', '=', id).execute(),
  ]);
  const unique = (ids: string[]) => [...new Set(ids)];
  if (['services', 'combo'].includes(body.appliesTo) && body.serviceIds.length) await tx.insertInto('offerServices').values(unique(body.serviceIds).map((serviceId) => ({ organizationId: orgId, offerId: id, serviceId }))).execute();
  if (body.appliesTo === 'categories' && body.categoryIds.length) await tx.insertInto('offerCategories').values(unique(body.categoryIds).map((categoryId) => ({ organizationId: orgId, offerId: id, categoryId }))).execute();
  if (!body.allBranches && body.branchIds.length) await tx.insertInto('offerBranches').values(unique(body.branchIds).map((branchId) => ({ organizationId: orgId, offerId: id, branchId }))).execute();
  if (body.eligibility === 'specific_customers' && body.customerIds.length) await tx.insertInto('offerCustomers').values(unique(body.customerIds).map((customerId) => ({ organizationId: orgId, offerId: id, customerId }))).execute();
}

const offerColumns = (b: OfferOut) => ({
  name: b.name,
  description: b.description,
  code: b.code,
  discountType: b.discountType,
  discountValue: b.discountValue,
  maxDiscountAmount: b.maxDiscountAmount ?? null,
  minBillAmount: b.minBillAmount ?? null,
  appliesTo: b.appliesTo,
  eligibility: b.eligibility,
  loyaltyMinVisits: b.loyaltyMinVisits ?? null,
  loyaltyMinSpend: b.loyaltyMinSpend ?? null,
  birthdayWindowDays: b.birthdayWindowDays,
  validFrom: b.validFrom,
  validTo: b.validTo,
  validWeekdays: b.validWeekdays?.length ? b.validWeekdays : null,
  allBranches: b.allBranches,
  autoApply: b.autoApply,
  usageLimitTotal: b.usageLimitTotal ?? null,
  usageLimitPerCustomer: b.usageLimitPerCustomer ?? null,
  status: b.status,
});

offers.get('/', { summary: 'Offers with their current state (running, scheduled, expired); archived=true lists only archived ones', permissions: ['offers.manage', 'billing.create'], query: paginationQuery.extend({ includeArchived: z.enum(['true', 'false']).optional(), archived: z.enum(['true', 'false']).optional() }) }, async ({ tx, auth, query }) =>
  tx(async (t) => {
    const orgId = requireOrgId(auth);
    const today = todayIn((await loadOrg(t, orgId)).timezone);
    let q = t.selectFrom('offers').select('id').where('organizationId', '=', orgId).orderBy('validTo', 'desc').orderBy('name');
    if (query.archived === 'true') q = q.where('status', '=', 'archived');
    else if (query.includeArchived !== 'true') q = q.where('status', '!=', 'archived');
    if (query.search) q = q.where('name', 'ilike', `%${query.search}%`);
    const ids = await q.limit(500).execute();
    return Promise.all(ids.map((o) => offerDto(t, orgId, o.id, today)));
  }),
);

offers.get('/:id', { summary: 'Offer details', permissions: ['offers.manage'] }, async ({ tx, auth, params }) =>
  tx(async (t) => {
    const orgId = requireOrgId(auth);
    return offerDto(t, orgId, params.id!, todayIn((await loadOrg(t, orgId)).timezone));
  }),
);

offers.post('/', { summary: 'Create an offer', permissions: ['offers.manage'], body: offerSchema }, async ({ tx, auth, body }) =>
  tx(async (t) => {
    const orgId = requireOrgId(auth);
    for (const b of body.branchIds) assertBranchAccess(auth, b);
    const row = await t.insertInto('offers').values({ organizationId: orgId, ...offerColumns(body), createdBy: auth.userId }).returning('id').executeTakeFirstOrThrow();
    await writeOfferRelations(t, orgId, row.id, body);
    await audit(t, auth, { action: 'offer.created', entityType: 'offer', entityId: row.id, summary: `Offer "${body.name}" created`, after: offerColumns(body) });
    return offerDto(t, orgId, row.id, todayIn((await loadOrg(t, orgId)).timezone));
  }),
);

offers.put('/:id', { summary: 'Edit an offer (past redemptions are unaffected)', permissions: ['offers.manage'], body: offerSchema }, async ({ tx, auth, params, body }) =>
  tx(async (t) => {
    const orgId = requireOrgId(auth);
    const today = todayIn((await loadOrg(t, orgId)).timezone);
    const before = await offerDto(t, orgId, params.id!, today);
    if (body.usageLimitTotal != null && body.usageLimitTotal < before.usageCount) throw new AppError(400, 'VALIDATION_ERROR', `This offer has already been used ${before.usageCount} times; the limit cannot be lower.`);
    await t.updateTable('offers').set({ ...offerColumns(body), updatedAt: new Date() }).where('organizationId', '=', orgId).where('id', '=', params.id!).execute();
    await writeOfferRelations(t, orgId, params.id!, body);
    await audit(t, auth, { action: 'offer.updated', entityType: 'offer', entityId: params.id!, before: before as unknown as Record<string, unknown>, after: offerColumns(body) });
    return offerDto(t, orgId, params.id!, today);
  }),
);

offers.delete('/:id', { summary: 'Archive an offer', permissions: ['offers.manage'], status: 204 }, async ({ tx, auth, params }) =>
  tx(async (t) => {
    const row = await t.updateTable('offers').set({ status: 'archived' }).where('organizationId', '=', requireOrgId(auth)).where('id', '=', params.id!).returning(['id', 'name']).executeTakeFirst();
    if (!row) throw notFound('Offer');
    await audit(t, auth, { action: 'offer.archived', entityType: 'offer', entityId: row.id, summary: `Offer "${row.name}" archived` });
    return undefined;
  }),
);

offers.post('/:id/restore', { summary: 'Bring back an archived offer (it applies again within its dates)', permissions: ['offers.manage'], status: 200 }, async ({ tx, auth, params }) =>
  tx(async (t) => {
    const orgId = requireOrgId(auth);
    const row = await t.updateTable('offers').set({ status: 'active', updatedAt: new Date() }).where('organizationId', '=', orgId).where('id', '=', params.id!).where('status', '=', 'archived').returning(['id', 'name']).executeTakeFirst();
    if (!row) throw notFound('Archived offer');
    await audit(t, auth, { action: 'offer.restored', entityType: 'offer', entityId: row.id, summary: `Offer "${row.name}" restored` });
    return offerDto(t, orgId, row.id, todayIn((await loadOrg(t, orgId)).timezone));
  }),
);

// ───────────── Packages ─────────────
const packages = createRouter('/packages', 'Offers & packages');

/**
 * Whether a package can be sold today: archived, paused, not on sale yet, past its last sale day, sold out, or on sale.
 * Billing enforces the same rules (see assertPackageSellable); this lets every screen show it.
 */
export function packageState(p: { status: string; saleStartsOn: string | null; saleEndsOn: string | null; saleLimitTotal: number | null; soldCount: number }, today: string) {
  if (p.status === 'archived') return 'archived' as const;
  if (p.status !== 'active') return 'paused' as const;
  if (p.saleStartsOn && today < p.saleStartsOn) return 'scheduled' as const;
  if (p.saleEndsOn && today > p.saleEndsOn) return 'ended' as const;
  if (p.saleLimitTotal !== null && p.soldCount >= p.saleLimitTotal) return 'sold_out' as const;
  return 'on_sale' as const;
}

const orgToday = async (t: Tx, orgId: string) => todayIn((await loadOrg(t, orgId)).timezone);

async function packageDto(tx: Tx, orgId: string, id: string, today: string) {
  const p = await tx.selectFrom('packages').selectAll().where('organizationId', '=', orgId).where('id', '=', id).executeTakeFirst();
  if (!p) throw notFound('Package');
  const [items, branches] = await Promise.all([
    tx.selectFrom('packageItems as pi').innerJoin('services as s', 's.id', 'pi.serviceId').select(['pi.serviceId', 'pi.quantity', 's.name as serviceName', 's.price as servicePrice']).where('pi.packageId', '=', id).execute(),
    tx.selectFrom('packageBranches').select('branchId').where('packageId', '=', id).execute(),
  ]);
  // "Original value" vs package price, so the receptionist can show the saving.
  const originalValue = items.reduce((a, i) => a + i.servicePrice * i.quantity, 0);
  return { ...p, state: packageState(p, today), items, originalValue, savings: Math.max(originalValue - p.price, 0), branchIds: branches.map((b) => b.branchId) };
}

async function writePackageRelations(tx: Tx, orgId: string, id: string, body: PackageOut): Promise<void> {
  await tx.deleteFrom('packageItems').where('packageId', '=', id).execute();
  await tx.deleteFrom('packageBranches').where('packageId', '=', id).execute();
  await tx.insertInto('packageItems').values(body.items.map((i) => ({ organizationId: orgId, packageId: id, serviceId: i.serviceId, quantity: i.quantity }))).execute();
  if (!body.allBranches && body.branchIds.length) await tx.insertInto('packageBranches').values([...new Set(body.branchIds)].map((branchId) => ({ organizationId: orgId, packageId: id, branchId }))).execute();
}

const packageColumns = (b: PackageOut) => ({
  code: b.code.toUpperCase(),
  name: b.name,
  description: b.description,
  price: b.price,
  taxRateBp: b.taxRateBp ?? null,
  validityDays: b.validityDays,
  allBranches: b.allBranches,
  customerSegment: b.customerSegment,
  maxPerCustomer: b.maxPerCustomer ?? null,
  saleLimitTotal: b.saleLimitTotal ?? null,
  saleStartsOn: b.saleStartsOn,
  saleEndsOn: b.saleEndsOn,
  status: b.status,
});

packages.get('/', { summary: 'Packages and combos with whether each is on sale today; archived=true lists only archived ones', permissions: ['packages.manage', 'billing.create', 'appointments.create', 'walkins.manage'], query: z.object({ archived: z.enum(['true', 'false']).optional() }) }, async ({ tx, auth, query }) =>
  tx(async (t) => {
    const orgId = requireOrgId(auth);
    const today = await orgToday(t, orgId);
    const ids = await t.selectFrom('packages').select('id').where('organizationId', '=', orgId).where('status', query.archived === 'true' ? '=' : '!=', 'archived').orderBy('name').execute();
    return Promise.all(ids.map((p) => packageDto(t, orgId, p.id, today)));
  }),
);

packages.get('/:id', { summary: 'Package details', permissions: ['packages.manage', 'billing.create', 'appointments.create', 'walkins.manage'] }, async ({ tx, auth, params }) =>
  tx(async (t) => {
    const orgId = requireOrgId(auth);
    return packageDto(t, orgId, params.id!, await orgToday(t, orgId));
  }),
);

packages.post('/', { summary: 'Create a package', permissions: ['packages.manage'], body: packageSchema }, async ({ tx, auth, body }) =>
  tx(async (t) => {
    const orgId = requireOrgId(auth);
    const row = await t.insertInto('packages').values({ organizationId: orgId, ...packageColumns(body), createdBy: auth.userId }).returning('id').executeTakeFirstOrThrow();
    await writePackageRelations(t, orgId, row.id, body);
    await audit(t, auth, { action: 'package.created', entityType: 'package', entityId: row.id, summary: `Package "${body.name}" created`, after: packageColumns(body) });
    return packageDto(t, orgId, row.id, await orgToday(t, orgId));
  }),
);

packages.put('/:id', { summary: 'Edit a package (customers who already bought it keep what they bought)', permissions: ['packages.manage'], body: packageSchema }, async ({ tx, auth, params, body }) =>
  tx(async (t) => {
    const orgId = requireOrgId(auth);
    const today = await orgToday(t, orgId);
    const before = await packageDto(t, orgId, params.id!, today);
    if (body.saleLimitTotal != null && body.saleLimitTotal < before.soldCount) throw new AppError(400, 'VALIDATION_ERROR', `${before.soldCount} have already been sold; the limit cannot be lower.`);
    await t.updateTable('packages').set({ ...packageColumns(body), updatedAt: new Date() }).where('organizationId', '=', orgId).where('id', '=', params.id!).execute();
    await writePackageRelations(t, orgId, params.id!, body);
    await audit(t, auth, { action: 'package.updated', entityType: 'package', entityId: params.id!, before: before as unknown as Record<string, unknown>, after: packageColumns(body) });
    return packageDto(t, orgId, params.id!, today);
  }),
);

packages.delete('/:id', { summary: 'Archive a package', permissions: ['packages.manage'], status: 204 }, async ({ tx, auth, params }) =>
  tx(async (t) => {
    const row = await t.updateTable('packages').set({ status: 'archived' }).where('organizationId', '=', requireOrgId(auth)).where('id', '=', params.id!).returning(['id', 'name']).executeTakeFirst();
    if (!row) throw notFound('Package');
    await audit(t, auth, { action: 'package.archived', entityType: 'package', entityId: row.id, summary: `Package "${row.name}" archived` });
    return undefined;
  }),
);

packages.post('/:id/restore', { summary: 'Bring back an archived package (on sale again within its dates)', permissions: ['packages.manage'], status: 200 }, async ({ tx, auth, params }) =>
  tx(async (t) => {
    const orgId = requireOrgId(auth);
    const row = await t.updateTable('packages').set({ status: 'active', updatedAt: new Date() }).where('organizationId', '=', orgId).where('id', '=', params.id!).where('status', '=', 'archived').returning(['id', 'name']).executeTakeFirst();
    if (!row) throw notFound('Archived package');
    await audit(t, auth, { action: 'package.restored', entityType: 'package', entityId: row.id, summary: `Package "${row.name}" restored` });
    return packageDto(t, orgId, row.id, await orgToday(t, orgId));
  }),
);

// Packages a customer already owns (shown while booking so unused sessions are used first).
const customerPackages = createRouter('/customers', 'Offers & packages');

customerPackages.get('/:id/packages', { summary: 'Packages owned by a customer with remaining sessions', permissions: ['customers.view'], query: z.object({ serviceId: z.uuid().optional(), activeOnly: z.enum(['true', 'false']).optional() }) }, async ({ tx, auth, params, query }) =>
  tx(async (t) => {
    const orgId = requireOrgId(auth);
    let q = t
      .selectFrom('customerPackages as cp')
      .innerJoin('packages as p', 'p.id', 'cp.packageId')
      .select(['cp.id', 'cp.packageId', 'p.name as packageName', 'cp.purchasedAt', 'cp.expiresAt', 'cp.status', 'cp.pricePaid'])
      .where('cp.organizationId', '=', orgId)
      .where('cp.customerId', '=', params.id!)
      .orderBy('cp.expiresAt');
    if (query.activeOnly === 'true') q = q.where('cp.status', '=', 'active').where('cp.expiresAt', '>', new Date());
    const pkgs = await q.execute();
    if (!pkgs.length) return [];
    let iq = t
      .selectFrom('customerPackageItems as cpi')
      .innerJoin('services as s', 's.id', 'cpi.serviceId')
      .select(['cpi.id', 'cpi.customerPackageId', 'cpi.serviceId', 's.name as serviceName', 'cpi.quantityTotal', 'cpi.quantityUsed'])
      .where('cpi.customerPackageId', 'in', pkgs.map((p) => p.id));
    if (query.serviceId) iq = iq.where('cpi.serviceId', '=', query.serviceId);
    const items = await iq.execute();
    return pkgs
      .map((p) => ({
        id: p.id,
        packageId: p.packageId,
        packageName: p.packageName,
        purchasedAt: p.purchasedAt.toISOString(),
        expiresAt: p.expiresAt.toISOString(),
        status: p.status,
        pricePaid: p.pricePaid,
        items: items.filter((i) => i.customerPackageId === p.id).map((i) => ({ id: i.id, serviceId: i.serviceId, serviceName: i.serviceName, quantityTotal: i.quantityTotal, quantityUsed: i.quantityUsed, remaining: i.quantityTotal - i.quantityUsed })),
      }))
      .filter((p) => !query.serviceId || p.items.length > 0);
  }),
);

export const offerRoutes = offers;
export const packageRoutes = packages;
export const customerPackageRoutes = customerPackages;
