import { DEFAULT_TEMPLATES, ROLE_TEMPLATES, type createOrganizationSchema } from '@salon/shared';
import type { z } from 'zod';
import { audit } from '../../core/audit.js';
import type { AuthContext } from '../../core/auth-context.js';
import { hashPassword } from '../../core/passwords.js';
import type { Tx } from '../../db/tenant.js';
import { callingCodeFor, normalizePhoneOrThrow } from '../../core/validation.js';

// Editable starter data so a new salon is usable immediately (requirement 86.22). Nothing here is hard-coded
// business logic: every row can be renamed, archived or extended by the owner.
const DEFAULT_CATEGORIES = [
  { name: 'Hair', color: '#8b5cf6' },
  { name: 'Skin', color: '#ec4899' },
  { name: 'Makeup', color: '#f43f5e' },
  { name: 'Massage', color: '#14b8a6' },
  { name: 'Nails', color: '#f59e0b' },
  { name: 'Spa', color: '#06b6d4' },
  { name: 'Grooming', color: '#3b82f6' },
  { name: 'Bridal', color: '#d946ef' },
  { name: 'Packages', color: '#64748b' },
];

const DEFAULT_EXPERTISE = [
  'Hair Artist',
  'Senior Hair Artist',
  'Hair Stylist',
  'Colorist',
  'Barber',
  'Masseuse',
  'Makeup Artist',
  'Nail Artist',
  'Skin Specialist',
  'Facial Specialist',
];

const DEFAULT_HOURS = [1, 2, 3, 4, 5, 6, 7].map((weekday) => ({
  weekday,
  isClosed: false,
  openTime: '10:00',
  closeTime: weekday === 7 ? '18:00' : '20:00',
}));

export type ProvisionInput = z.output<typeof createOrganizationSchema>;

export interface ProvisionResult {
  organizationId: string;
  ownerUserId: string;
  branchId: string;
  roleIds: Record<string, string>;
}

/** Creates a fully isolated tenant. Must run in a platform-scoped transaction. */
export async function provisionOrganization(tx: Tx, input: ProvisionInput, actor: AuthContext): Promise<ProvisionResult> {
  const callingCode = callingCodeFor(input.country);
  const org = await tx
    .insertInto('organizations')
    .values({
      code: input.code,
      name: input.name,
      legalName: input.legalName,
      contactPerson: input.contactPerson ?? input.owner.fullName,
      email: input.email ?? input.owner.email,
      phone: input.phone ? normalizePhoneOrThrow(input.phone, callingCode, 'phone') : null,
      country: input.country,
      currency: input.currency,
      timezone: input.timezone,
      taxId: input.taxId,
      subscriptionPlan: input.subscriptionPlan,
      subscriptionStatus: input.subscriptionPlan === 'trial' ? 'trialing' : 'active',
      trialEndsAt: input.subscriptionPlan === 'trial' ? new Date(Date.now() + 30 * 86400_000) : null,
      maxBranches: input.maxBranches ?? null,
      onboardingState: JSON.stringify({ salon: 'done', branches: 'done' }),
    })
    .returning('id')
    .executeTakeFirstOrThrow();
  const organizationId = org.id;

  await tx.insertInto('organizationSettings').values({ organizationId }).execute();

  const roleIds: Record<string, string> = {};
  for (const template of ROLE_TEMPLATES) {
    const role = await tx
      .insertInto('roles')
      .values({
        organizationId,
        key: template.key,
        name: template.name,
        description: template.description,
        isSystem: true,
        isLocked: template.locked,
        homeScreen: template.homeScreen,
      })
      .returning('id')
      .executeTakeFirstOrThrow();
    roleIds[template.key] = role.id;
    if (template.permissions.length) {
      await tx
        .insertInto('rolePermissions')
        .values(template.permissions.map((permissionKey) => ({ organizationId, roleId: role.id, permissionKey })))
        .execute();
    }
  }

  const branch = await tx
    .insertInto('branches')
    .values({
      organizationId,
      code: input.firstBranch.code,
      name: input.firstBranch.name,
      city: input.firstBranch.city,
      timezone: input.timezone,
      phone: input.phone ? normalizePhoneOrThrow(input.phone, callingCode, 'phone') : null,
    })
    .returning('id')
    .executeTakeFirstOrThrow();
  await tx
    .insertInto('branchHours')
    .values(DEFAULT_HOURS.map((h) => ({ organizationId, branchId: branch.id, ...h })))
    .execute();

  const owner = await tx
    .insertInto('users')
    .values({
      organizationId,
      roleId: roleIds.owner!,
      email: input.owner.email.toLowerCase(),
      phone: input.owner.phone ? normalizePhoneOrThrow(input.owner.phone, callingCode, 'owner.phone') : null,
      fullName: input.owner.fullName,
      passwordHash: await hashPassword(input.owner.password),
      allBranches: true,
      createdBy: actor.userId || null,
    })
    .returning('id')
    .executeTakeFirstOrThrow();

  await tx
    .insertInto('serviceCategories')
    .values(DEFAULT_CATEGORIES.map((c, i) => ({ organizationId, name: c.name, color: c.color, sortOrder: i })))
    .execute();
  await tx
    .insertInto('expertise')
    .values(DEFAULT_EXPERTISE.map((name) => ({ organizationId, name })))
    .execute();
  await tx
    .insertInto('notificationTemplates')
    .values(
      DEFAULT_TEMPLATES.map((t) => ({
        organizationId,
        eventType: t.eventType,
        channel: t.channel,
        name: t.name,
        subject: t.subject,
        body: t.body,
      })),
    )
    .execute();

  await audit(tx, actor, {
    organizationId,
    action: 'organization.created',
    entityType: 'organization',
    entityId: organizationId,
    summary: `Salon "${input.name}" onboarded with branch ${input.firstBranch.name}`,
    after: { code: input.code, name: input.name, plan: input.subscriptionPlan, ownerEmail: input.owner.email },
  });

  return { organizationId, ownerUserId: owner.id, branchId: branch.id, roleIds };
}
