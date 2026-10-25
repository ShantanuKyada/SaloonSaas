import {
  ALL_PERMISSIONS,
  createUserSchema,
  isPermission,
  paginationQuery,
  PERMISSIONS,
  resetPasswordSchema,
  roleSchema,
  updateUserSchema,
  type Permission,
} from '@salon/shared';
import { z } from 'zod';
import { audit } from '../../core/audit.js';
import { invalidatePrincipal, requireOrgId, type AuthContext } from '../../core/auth-context.js';
import { AppError, notFound } from '../../core/errors.js';
import { hashPassword } from '../../core/passwords.js';
import { createRouter, paged } from '../../core/router.js';
import { loadOrg, optionalPhone } from '../../core/validation.js';
import type { Tx } from '../../db/tenant.js';
import { clearTwoFactor } from '../auth/mfa.js';
import { revokeAllSessions } from '../auth/service.js';

// ───────────── Users ─────────────
const users = createRouter('/users', 'Users & roles');

async function assertBranchesInOrg(tx: Tx, orgId: string, branchIds: string[]): Promise<void> {
  if (!branchIds.length) return;
  const found = await tx.selectFrom('branches').select('id').where('organizationId', '=', orgId).where('id', 'in', branchIds).execute();
  if (found.length !== new Set(branchIds).size) throw new AppError(400, 'BAD_REQUEST', 'One of the selected branches does not exist.');
}

async function loadRole(tx: Tx, orgId: string, roleId: string) {
  const role = await tx.selectFrom('roles').selectAll().where('organizationId', '=', orgId).where('id', '=', roleId).executeTakeFirst();
  if (!role) throw new AppError(400, 'BAD_REQUEST', 'The selected role does not exist.');
  return role;
}

/** Only an owner can create or promote owners; nobody can hand out a role with permissions they lack. */
async function assertCanAssignRole(tx: Tx, auth: AuthContext, role: { id: string; key: string; isLocked: boolean }): Promise<void> {
  if (auth.roleKey === 'owner') return;
  if (role.isLocked || role.key === 'owner') throw new AppError(403, 'FORBIDDEN', 'Only an owner can assign the Owner role.');
  const perms = await tx.selectFrom('rolePermissions').select('permissionKey').where('roleId', '=', role.id).execute();
  const missing = perms.map((p) => p.permissionKey).filter((p) => isPermission(p) && !auth.permissions.has(p));
  if (missing.length) {
    throw new AppError(403, 'FORBIDDEN', 'You cannot assign a role with more access than your own.', { missing });
  }
}

async function userDto(tx: Tx, orgId: string, userId: string) {
  const user = await tx
    .selectFrom('users as u')
    .innerJoin('roles as r', 'r.id', 'u.roleId')
    .leftJoin('staff as s', 's.userId', 'u.id')
    .select([
      'u.id',
      'u.fullName',
      'u.email',
      'u.phone',
      'u.status',
      'u.allBranches',
      'u.lastLoginAt',
      'u.mustChangePassword',
      'u.lockedUntil',
      'u.createdAt',
      'u.totpEnabledAt',
      'r.id as roleId',
      'r.name as roleName',
      'r.key as roleKey',
      's.id as staffId',
      's.fullName as staffName',
    ])
    .where('u.organizationId', '=', orgId)
    .where('u.id', '=', userId)
    .executeTakeFirst();
  if (!user) throw notFound('User');
  const { totpEnabledAt, ...rest } = user;
  const branches = await tx
    .selectFrom('userBranches as ub')
    .innerJoin('branches as b', 'b.id', 'ub.branchId')
    .select(['b.id', 'b.name'])
    .where('ub.userId', '=', userId)
    .execute();
  return { ...rest, twoFactorEnabled: totpEnabledAt !== null, branches };
}

users.get(
  '/',
  { summary: 'List user accounts', permissions: ['users.manage'], query: paginationQuery.extend({ status: z.enum(['active', 'disabled']).optional(), roleId: z.uuid().optional() }) },
  async ({ tx, auth, query }) =>
    tx(async (t) => {
      const orgId = requireOrgId(auth);
      let base = t.selectFrom('users as u').innerJoin('roles as r', 'r.id', 'u.roleId').where('u.organizationId', '=', orgId);
      if (query.status) base = base.where('u.status', '=', query.status);
      if (query.roleId) base = base.where('u.roleId', '=', query.roleId);
      if (query.search) {
        const term = `%${query.search}%`;
        base = base.where((eb) => eb.or([eb('u.fullName', 'ilike', term), eb('u.email', 'ilike', term), eb('u.phone', 'ilike', term)]));
      }
      const { n } = await base.select((eb) => eb.fn.countAll<number>().as('n')).executeTakeFirstOrThrow();
      const rows = await base
        .leftJoin('staff as s', 's.userId', 'u.id')
        .select([
          'u.id',
          'u.fullName',
          'u.email',
          'u.phone',
          'u.status',
          'u.allBranches',
          'u.lastLoginAt',
          'u.lockedUntil',
          'u.totpEnabledAt',
          'r.id as roleId',
          'r.name as roleName',
          'r.key as roleKey',
          's.id as staffId',
          's.fullName as staffName',
        ])
        .orderBy('u.fullName')
        .limit(query.pageSize)
        .offset((query.page - 1) * query.pageSize)
        .execute();
      const branchRows = rows.length
        ? await t
            .selectFrom('userBranches as ub')
            .innerJoin('branches as b', 'b.id', 'ub.branchId')
            .select(['ub.userId', 'b.id', 'b.name'])
            .where('ub.userId', 'in', rows.map((u) => u.id))
            .execute()
        : [];
      return paged(
        rows.map(({ totpEnabledAt, ...u }) => ({
          ...u,
          twoFactorEnabled: totpEnabledAt !== null,
          branches: branchRows.filter((b) => b.userId === u.id).map((b) => ({ id: b.id, name: b.name })),
        })),
        n,
        query.page,
        query.pageSize,
      );
    }),
);

users.get('/:id', { summary: 'User account details', permissions: ['users.manage'] }, async ({ tx, auth, params }) =>
  tx((t) => userDto(t, requireOrgId(auth), params.id!)),
);

users.post('/', { summary: 'Create a user account', permissions: ['users.manage'], body: createUserSchema }, async ({ tx, auth, body }) =>
  tx(async (t) => {
    const orgId = requireOrgId(auth);
    const org = await loadOrg(t, orgId);
    const role = await loadRole(t, orgId, body.roleId);
    await assertCanAssignRole(t, auth, role);
    await assertBranchesInOrg(t, orgId, body.branchIds);
    if (body.allBranches && !auth.allBranches) throw new AppError(403, 'FORBIDDEN', 'You can only give access to branches you manage.');
    for (const b of body.branchIds) {
      if (!auth.branchIds.includes(b)) throw new AppError(403, 'BRANCH_ACCESS_DENIED', 'You can only give access to branches you manage.');
    }
    const user = await t
      .insertInto('users')
      .values({
        organizationId: orgId,
        roleId: role.id,
        email: body.email?.toLowerCase() ?? null,
        phone: optionalPhone(body.phone, org.callingCode, 'phone'),
        fullName: body.fullName,
        passwordHash: await hashPassword(body.password),
        allBranches: body.allBranches,
        mustChangePassword: true,
        createdBy: auth.userId,
      })
      .returning('id')
      .executeTakeFirstOrThrow();
    if (!body.allBranches && body.branchIds.length) {
      await t.insertInto('userBranches').values(body.branchIds.map((branchId) => ({ organizationId: orgId, userId: user.id, branchId }))).execute();
    }
    if (body.staffId) {
      const linked = await t.updateTable('staff').set({ userId: user.id }).where('organizationId', '=', orgId).where('id', '=', body.staffId).where('userId', 'is', null).executeTakeFirst();
      if (!linked.numUpdatedRows) throw new AppError(409, 'CONFLICT', 'This team member already has a login.');
    }
    await audit(t, auth, {
      action: 'user.created',
      entityType: 'user',
      entityId: user.id,
      summary: `Login created for ${body.fullName} (${role.name})`,
      after: { fullName: body.fullName, email: body.email, phone: body.phone, role: role.name, allBranches: body.allBranches, branchIds: body.branchIds },
    });
    return userDto(t, orgId, user.id);
  }),
);

users.patch('/:id', { summary: 'Update a user account', permissions: ['users.manage'], body: updateUserSchema }, async ({ tx, auth, params, body }) =>
  tx(async (t) => {
    const orgId = requireOrgId(auth);
    const org = await loadOrg(t, orgId);
    const before = await userDto(t, orgId, params.id!);
    const isSelf = params.id === auth.userId;
    if (isSelf && (body.status === 'disabled' || (body.roleId && body.roleId !== before.roleId))) {
      throw new AppError(400, 'BAD_REQUEST', 'You cannot disable your own account or change your own role.');
    }
    if (before.roleKey === 'owner' && auth.roleKey !== 'owner') throw new AppError(403, 'FORBIDDEN', 'Only an owner can change another owner.');
    if (body.roleId && body.roleId !== before.roleId) {
      const role = await loadRole(t, orgId, body.roleId);
      await assertCanAssignRole(t, auth, role);
    }
    // Never leave an organization without an active owner.
    if (before.roleKey === 'owner' && ((body.roleId && body.roleId !== before.roleId) || body.status === 'disabled')) {
      const owners = await t
        .selectFrom('users as u')
        .innerJoin('roles as r', 'r.id', 'u.roleId')
        .select((eb) => eb.fn.countAll<number>().as('n'))
        .where('u.organizationId', '=', orgId)
        .where('r.key', '=', 'owner')
        .where('u.status', '=', 'active')
        .executeTakeFirstOrThrow();
      if (owners.n <= 1) throw new AppError(409, 'CONFLICT', 'This is the only owner. Make someone else an owner first.');
    }
    if (body.branchIds) {
      await assertBranchesInOrg(t, orgId, body.branchIds);
      for (const b of body.branchIds) {
        if (!auth.branchIds.includes(b)) throw new AppError(403, 'BRANCH_ACCESS_DENIED', 'You can only give access to branches you manage.');
      }
    }
    if (body.allBranches && !auth.allBranches) throw new AppError(403, 'FORBIDDEN', 'You can only give access to branches you manage.');

    await t
      .updateTable('users')
      .set({
        updatedAt: new Date(),
        ...(body.fullName !== undefined ? { fullName: body.fullName } : {}),
        ...(body.email !== undefined ? { email: body.email?.toLowerCase() ?? null } : {}),
        ...(body.phone !== undefined ? { phone: optionalPhone(body.phone, org.callingCode, 'phone') } : {}),
        ...(body.roleId !== undefined ? { roleId: body.roleId } : {}),
        ...(body.allBranches !== undefined ? { allBranches: body.allBranches } : {}),
        ...(body.status !== undefined ? { status: body.status } : {}),
      })
      .where('organizationId', '=', orgId)
      .where('id', '=', params.id!)
      .execute();
    if (body.branchIds) {
      await t.deleteFrom('userBranches').where('userId', '=', params.id!).execute();
      if (body.branchIds.length) {
        await t.insertInto('userBranches').values(body.branchIds.map((branchId) => ({ organizationId: orgId, userId: params.id!, branchId }))).execute();
      }
    }
    if (body.staffId !== undefined) {
      await t.updateTable('staff').set({ userId: null }).where('organizationId', '=', orgId).where('userId', '=', params.id!).execute();
      if (body.staffId) {
        const linked = await t.updateTable('staff').set({ userId: params.id! }).where('organizationId', '=', orgId).where('id', '=', body.staffId).where('userId', 'is', null).executeTakeFirst();
        if (!linked.numUpdatedRows) throw new AppError(409, 'CONFLICT', 'This team member already has a login.');
      }
    }
    if (body.status === 'disabled') await revokeAllSessions(t, params.id!, 'disabled');
    invalidatePrincipal(params.id!);
    const after = await userDto(t, orgId, params.id!);
    await audit(t, auth, { action: 'user.updated', entityType: 'user', entityId: params.id!, before, after });
    return after;
  }),
);

users.post('/:id/reset-password', { summary: "Set a temporary password (user must change it at next sign-in)", permissions: ['users.manage'], body: resetPasswordSchema, status: 204 }, async ({ tx, auth, params, body }) =>
  tx(async (t) => {
    const orgId = requireOrgId(auth);
    const target = await userDto(t, orgId, params.id!);
    if (target.roleKey === 'owner' && auth.roleKey !== 'owner') throw new AppError(403, 'FORBIDDEN', "Only an owner can reset an owner's password.");
    await t
      .updateTable('users')
      .set({ passwordHash: await hashPassword(body.password), mustChangePassword: true, failedLoginCount: 0, lockedUntil: null, passwordChangedAt: new Date() })
      .where('organizationId', '=', orgId)
      .where('id', '=', params.id!)
      .execute();
    await revokeAllSessions(t, params.id!, 'password_reset');
    await audit(t, auth, { action: 'user.password_reset', entityType: 'user', entityId: params.id!, summary: `Password reset for ${target.fullName}` });
    return undefined;
  }),
);

users.post('/:id/reset-two-factor', { summary: "Switch off a person's two-step sign-in (lost phone and recovery codes)", permissions: ['users.manage'], status: 204 }, async ({ tx, auth, params }) =>
  tx(async (t) => {
    const orgId = requireOrgId(auth);
    const target = await userDto(t, orgId, params.id!);
    if (target.id === auth.userId) throw new AppError(400, 'BAD_REQUEST', 'To switch off your own two-step sign-in, use Account security.');
    if (target.roleKey === 'owner' && auth.roleKey !== 'owner') throw new AppError(403, 'FORBIDDEN', "Only an owner can reset an owner's two-step sign-in.");
    if (!target.twoFactorEnabled) throw new AppError(409, 'CONFLICT', 'Two-step sign-in is not switched on for this person.');
    await clearTwoFactor(t, params.id!);
    await revokeAllSessions(t, params.id!, 'two_factor_reset');
    await audit(t, auth, { action: 'user.two_factor_reset', entityType: 'user', entityId: params.id!, summary: `Two-step sign-in reset for ${target.fullName}` });
    return undefined;
  }),
);

// ───────────── Roles ─────────────
const roles = createRouter('/roles', 'Users & roles');

roles.get('/permissions', { summary: 'Permission catalogue grouped by module', permissions: ['roles.manage', 'users.manage'] }, async () => {
  const groups = new Map<string, Array<{ key: Permission; label: string }>>();
  for (const key of ALL_PERMISSIONS) {
    const def = PERMISSIONS[key];
    if (!groups.has(def.module)) groups.set(def.module, []);
    groups.get(def.module)!.push({ key, label: def.label });
  }
  return [...groups.entries()].map(([module, permissions]) => ({ module, permissions }));
});

roles.get('/', { summary: 'Roles with their permissions', permissions: ['roles.manage', 'users.manage'] }, async ({ tx, auth }) =>
  tx(async (t) => {
    const orgId = requireOrgId(auth);
    const rows = await t
      .selectFrom('roles as r')
      .selectAll('r')
      .select((eb) => eb.selectFrom('users').select(eb.fn.countAll<number>().as('n')).whereRef('roleId', '=', 'r.id').as('userCount'))
      .where('r.organizationId', '=', orgId)
      .orderBy('r.isSystem', 'desc')
      .orderBy('r.name')
      .execute();
    const perms = await t.selectFrom('rolePermissions').select(['roleId', 'permissionKey']).where('organizationId', '=', orgId).execute();
    return rows.map((role) => ({
      ...role,
      permissions: role.isLocked ? ALL_PERMISSIONS : perms.filter((p) => p.roleId === role.id).map((p) => p.permissionKey),
    }));
  }),
);

function slugify(name: string): string {
  const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 36);
  return /^[a-z]/.test(slug) ? slug : `role_${slug}`;
}

function assertGrantable(auth: AuthContext, permissions: string[]): void {
  if (auth.roleKey === 'owner') return;
  const missing = permissions.filter((p) => isPermission(p) && !auth.permissions.has(p));
  if (missing.length) throw new AppError(403, 'FORBIDDEN', 'You can only grant permissions you have yourself.', { missing });
}

roles.post('/', { summary: 'Create a custom role', permissions: ['roles.manage'], body: roleSchema }, async ({ tx, auth, body }) =>
  tx(async (t) => {
    const orgId = requireOrgId(auth);
    assertGrantable(auth, body.permissions);
    const role = await t
      .insertInto('roles')
      .values({ organizationId: orgId, key: `${slugify(body.name)}_${Date.now().toString(36).slice(-4)}`, name: body.name, description: body.description, homeScreen: body.homeScreen })
      .returningAll()
      .executeTakeFirstOrThrow();
    if (body.permissions.length) {
      await t.insertInto('rolePermissions').values([...new Set(body.permissions)].map((permissionKey) => ({ organizationId: orgId, roleId: role.id, permissionKey }))).execute();
    }
    await audit(t, auth, { action: 'role.created', entityType: 'role', entityId: role.id, after: { ...role, permissions: body.permissions } });
    return { ...role, permissions: body.permissions };
  }),
);

roles.put('/:id', { summary: "Edit a role's name and permissions", permissions: ['roles.manage'], body: roleSchema }, async ({ tx, auth, params, body }) =>
  tx(async (t) => {
    const orgId = requireOrgId(auth);
    const role = await t.selectFrom('roles').selectAll().where('organizationId', '=', orgId).where('id', '=', params.id!).executeTakeFirst();
    if (!role) throw notFound('Role');
    if (role.isLocked) throw new AppError(409, 'CONFLICT', 'The Owner role always has full access and cannot be edited.');
    if (role.id === auth.roleId) throw new AppError(400, 'BAD_REQUEST', 'You cannot edit your own role.');
    assertGrantable(auth, body.permissions);
    const beforePerms = await t.selectFrom('rolePermissions').select('permissionKey').where('roleId', '=', role.id).execute();
    const after = await t
      .updateTable('roles')
      .set({ name: body.name, description: body.description, homeScreen: body.homeScreen })
      .where('id', '=', role.id)
      .returningAll()
      .executeTakeFirstOrThrow();
    await t.deleteFrom('rolePermissions').where('roleId', '=', role.id).execute();
    if (body.permissions.length) {
      await t.insertInto('rolePermissions').values([...new Set(body.permissions)].map((permissionKey) => ({ organizationId: orgId, roleId: role.id, permissionKey }))).execute();
    }
    invalidatePrincipal();
    await audit(t, auth, {
      action: 'role.updated',
      entityType: 'role',
      entityId: role.id,
      before: { ...role, permissions: beforePerms.map((p) => p.permissionKey).sort() },
      after: { ...after, permissions: [...body.permissions].sort() },
    });
    return { ...after, permissions: body.permissions };
  }),
);

roles.delete('/:id', { summary: 'Delete an unused custom role', permissions: ['roles.manage'], status: 204 }, async ({ tx, auth, params }) =>
  tx(async (t) => {
    const orgId = requireOrgId(auth);
    const role = await t.selectFrom('roles').selectAll().where('organizationId', '=', orgId).where('id', '=', params.id!).executeTakeFirst();
    if (!role) throw notFound('Role');
    if (role.isSystem) throw new AppError(409, 'CONFLICT', 'Built-in roles cannot be deleted.');
    const inUse = await t.selectFrom('users').select('id').where('roleId', '=', role.id).limit(1).executeTakeFirst();
    if (inUse) throw new AppError(409, 'CONFLICT', 'Move users to another role before deleting this one.');
    await t.deleteFrom('roles').where('id', '=', role.id).execute();
    await audit(t, auth, { action: 'role.deleted', entityType: 'role', entityId: role.id, before: role });
    return undefined;
  }),
);

export const userRoutes = users;
export const roleRoutes = roles;
