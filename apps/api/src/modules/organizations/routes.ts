import {
  createOrganizationSchema,
  ONBOARDING_STEPS,
  onboardingStepSchema,
  organizationProfileSchema,
  organizationSettingsSchema,
  paginationQuery,
  updateOrganizationStatusSchema,
} from '@salon/shared';
import { sql } from 'kysely';
import { audit } from '../../core/audit.js';
import { invalidatePrincipal, requireOrgId } from '../../core/auth-context.js';
import { AppError, notFound } from '../../core/errors.js';
import { createRouter, paged } from '../../core/router.js';
import { loadOrg, optionalPhone } from '../../core/validation.js';
import { provisionOrganization } from './provision.js';

// ───────────── Platform (super admin) ─────────────
const platform = createRouter('/platform', 'Platform administration');

platform.get('/overview', { summary: 'Platform-wide tenant counts', auth: 'platform' }, async ({ tx }) =>
  tx(async (t) => {
    const row = await t
      .selectNoFrom([
        sql<number>`(select count(*) from organizations where status = 'active')`.as('activeOrganizations'),
        sql<number>`(select count(*) from organizations where status = 'suspended')`.as('suspendedOrganizations'),
        sql<number>`(select count(*) from branches where status = 'active')`.as('activeBranches'),
        sql<number>`(select count(*) from users where status = 'active' and organization_id is not null)`.as('activeUsers'),
        sql<number>`(select count(*) from customers where status <> 'archived')`.as('customers'),
        sql<number>`(select count(*) from appointments where created_at > now() - interval '30 days')`.as('appointmentsLast30Days'),
      ])
      .executeTakeFirstOrThrow();
    return row;
  }),
);

platform.get(
  '/organizations',
  { summary: 'List salon organizations', auth: 'platform', query: paginationQuery },
  async ({ tx, query }) =>
    tx(async (t) => {
      let base = t.selectFrom('organizations as o');
      if (query.search) {
        const term = `%${query.search}%`;
        base = base.where((eb) => eb.or([eb('o.name', 'ilike', term), eb('o.code', 'ilike', term), eb('o.email', 'ilike', term)]));
      }
      const total = await base.select((eb) => eb.fn.countAll<number>().as('n')).executeTakeFirstOrThrow();
      const rows = await base
        .select([
          'o.id',
          'o.code',
          'o.name',
          'o.email',
          'o.phone',
          'o.status',
          'o.subscriptionPlan',
          'o.subscriptionStatus',
          'o.trialEndsAt',
          'o.createdAt',
          'o.onboardingCompletedAt',
          (eb) => eb.selectFrom('branches').select(eb.fn.countAll<number>().as('n')).whereRef('organizationId', '=', 'o.id').as('branchCount'),
          (eb) => eb.selectFrom('users').select(eb.fn.countAll<number>().as('n')).whereRef('organizationId', '=', 'o.id').as('userCount'),
          (eb) => eb.selectFrom('customers').select(eb.fn.countAll<number>().as('n')).whereRef('organizationId', '=', 'o.id').as('customerCount'),
          (eb) =>
            eb.selectFrom('appointments').select(eb.fn.max('createdAt').as('m')).whereRef('organizationId', '=', 'o.id').as('lastActivityAt'),
        ])
        .orderBy('o.createdAt', 'desc')
        .limit(query.pageSize)
        .offset((query.page - 1) * query.pageSize)
        .execute();
      return paged(rows, total.n, query.page, query.pageSize);
    }),
);

platform.post(
  '/organizations',
  { summary: 'Onboard a new salon organization with its owner and first branch', auth: 'platform', body: createOrganizationSchema },
  async ({ tx, auth, body }) => tx((t) => provisionOrganization(t, body, auth)),
);

platform.get('/organizations/:id', { summary: 'Organization details', auth: 'platform' }, async ({ tx, params }) =>
  tx(async (t) => {
    const org = await t.selectFrom('organizations').selectAll().where('id', '=', params.id!).executeTakeFirst();
    if (!org) throw notFound('Organization');
    const branches = await t.selectFrom('branches').select(['id', 'code', 'name', 'city', 'status']).where('organizationId', '=', org.id).execute();
    const owners = await t
      .selectFrom('users as u')
      .innerJoin('roles as r', 'r.id', 'u.roleId')
      .select(['u.id', 'u.fullName', 'u.email', 'u.phone', 'u.lastLoginAt', 'u.status'])
      .where('u.organizationId', '=', org.id)
      .where('r.key', '=', 'owner')
      .execute();
    return { ...org, branches, owners };
  }),
);

platform.patch(
  '/organizations/:id',
  { summary: 'Suspend/reactivate a salon or change its plan', auth: 'platform', body: updateOrganizationStatusSchema },
  async ({ tx, auth, params, body }) =>
    tx(async (t) => {
      const before = await t.selectFrom('organizations').selectAll().where('id', '=', params.id!).executeTakeFirst();
      if (!before) throw notFound('Organization');
      const after = await t
        .updateTable('organizations')
        .set({
          updatedAt: new Date(),
          ...(body.status ? { status: body.status } : {}),
          ...(body.subscriptionPlan ? { subscriptionPlan: body.subscriptionPlan } : {}),
          ...(body.subscriptionStatus ? { subscriptionStatus: body.subscriptionStatus } : {}),
          ...(body.maxBranches !== undefined ? { maxBranches: body.maxBranches } : {}),
        })
        .where('id', '=', params.id!)
        .returningAll()
        .executeTakeFirstOrThrow();
      if (body.status && body.status !== before.status) invalidatePrincipal();
      await audit(t, auth, {
        organizationId: after.id,
        action: 'organization.updated',
        entityType: 'organization',
        entityId: after.id,
        summary: `Platform updated salon "${after.name}"`,
        before: { status: before.status, subscriptionPlan: before.subscriptionPlan, subscriptionStatus: before.subscriptionStatus, maxBranches: before.maxBranches },
        after: { status: after.status, subscriptionPlan: after.subscriptionPlan, subscriptionStatus: after.subscriptionStatus, maxBranches: after.maxBranches },
      });
      return after;
    }),
);

// ───────────── Organization (owner) ─────────────
const org = createRouter('/organization', 'Salon profile & settings');

org.get('/', { summary: 'Salon profile', permissions: ['settings.manage'] }, async ({ tx, auth }) =>
  tx(async (t) => {
    const row = await t.selectFrom('organizations').selectAll().where('id', '=', requireOrgId(auth)).executeTakeFirstOrThrow();
    return row;
  }),
);

org.put('/', { summary: 'Update salon profile', permissions: ['settings.manage'], body: organizationProfileSchema }, async ({ tx, auth, body }) =>
  tx(async (t) => {
    const orgId = requireOrgId(auth);
    const ctx = await loadOrg(t, orgId);
    const before = await t.selectFrom('organizations').selectAll().where('id', '=', orgId).executeTakeFirstOrThrow();
    const after = await t
      .updateTable('organizations')
      .set({ ...body, phone: optionalPhone(body.phone, ctx.callingCode, 'phone') })
      .where('id', '=', orgId)
      .returningAll()
      .executeTakeFirstOrThrow();
    await audit(t, auth, { action: 'organization.profile_updated', entityType: 'organization', entityId: orgId, before, after });
    return after;
  }),
);

org.get('/settings', { summary: 'Salon settings', permissions: ['settings.manage'] }, async ({ tx, auth }) =>
  tx((t) => t.selectFrom('organizationSettings').selectAll().where('organizationId', '=', requireOrgId(auth)).executeTakeFirstOrThrow()),
);

org.patch('/settings', { summary: 'Update salon settings', permissions: ['settings.manage'], body: organizationSettingsSchema }, async ({ tx, auth, body }) =>
  tx(async (t) => {
    const orgId = requireOrgId(auth);
    const before = await t.selectFrom('organizationSettings').selectAll().where('organizationId', '=', orgId).executeTakeFirstOrThrow();
    const policyChanged = body.twoFactorRequirement !== undefined && body.twoFactorRequirement !== before.twoFactorRequirement;
    if (policyChanged && auth.roleKey !== 'owner') {
      throw new AppError(403, 'FORBIDDEN', 'Only an owner can change who must use two-step sign-in.');
    }
    const after = await t
      .updateTable('organizationSettings')
      .set({
        ...body,
        ...(body.reminderOffsetsMinutes ? { reminderOffsetsMinutes: [...new Set(body.reminderOffsetsMinutes)].sort((a, b) => b - a) } : {}),
      })
      .where('organizationId', '=', orgId)
      .returningAll()
      .executeTakeFirstOrThrow();
    // Who must use two-step sign-in is decided when the principal is loaded, so every cached principal is now out of date.
    if (policyChanged) invalidatePrincipal();
    await audit(t, auth, { action: 'organization.settings_updated', entityType: 'organization_settings', entityId: orgId, before, after });
    return after;
  }),
);

org.get('/onboarding', { summary: 'Onboarding checklist with progress', permissions: ['settings.manage'] }, async ({ tx, auth }) =>
  tx(async (t) => {
    const orgId = requireOrgId(auth);
    const row = await t.selectFrom('organizations').select(['onboardingState', 'onboardingCompletedAt']).where('id', '=', orgId).executeTakeFirstOrThrow();
    const state = (row.onboardingState ?? {}) as Record<string, string>;
    const counts = await t
      .selectNoFrom([
        sql<number>`(select count(*) from branches where organization_id = ${orgId} and status = 'active')`.as('branches'),
        sql<number>`(select count(*) from services where organization_id = ${orgId} and status = 'active')`.as('services'),
        sql<number>`(select count(*) from staff where organization_id = ${orgId} and employment_status = 'active')`.as('staff'),
        sql<number>`(select count(*) from staff_services where organization_id = ${orgId} and is_active)`.as('mappings'),
        sql<number>`(select count(*) from staff_shifts where organization_id = ${orgId})`.as('shifts'),
        sql<number>`(select count(*) from organization_integrations where organization_id = ${orgId} and kind in ('whatsapp','email','sms') and status = 'active')`.as('messaging'),
      ])
      .executeTakeFirstOrThrow();
    const detected: Record<string, boolean> = {
      salon: true,
      branches: counts.branches > 0,
      services: counts.services > 0,
      staff: counts.staff > 0,
      expertise: counts.mappings > 0,
      hours: counts.shifts > 0,
      messaging: counts.messaging > 0,
      ready: row.onboardingCompletedAt !== null,
    };
    const steps = ONBOARDING_STEPS.map((step) => ({
      step,
      status: detected[step] ? 'done' : (state[step] as 'done' | 'skipped' | undefined) ?? 'pending',
    }));
    return { steps, completed: steps.filter((s) => s.status !== 'pending').length, total: steps.length, completedAt: row.onboardingCompletedAt, counts };
  }),
);

org.post('/onboarding/step', { summary: 'Mark an onboarding step done or skipped', permissions: ['settings.manage'], body: onboardingStepSchema, status: 204 }, async ({ tx, auth, body }) =>
  tx(async (t) => {
    const orgId = requireOrgId(auth);
    await t
      .updateTable('organizations')
      .set({
        onboardingState: sql`onboarding_state || jsonb_build_object(${body.step}::text, ${body.status}::text)`,
        ...(body.step === 'ready' ? { onboardingCompletedAt: new Date() } : {}),
      })
      .where('id', '=', orgId)
      .execute();
    await audit(t, auth, { action: 'organization.onboarding_step', entityType: 'organization', entityId: orgId, summary: `Onboarding: ${body.step} ${body.status}` });
    return undefined;
  }),
);

export const platformRoutes = platform;
export const organizationRoutes = org;
