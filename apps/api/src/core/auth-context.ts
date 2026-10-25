import { isPermission, twoFactorApplies, type HomeScreen, type Permission, type TwoFactorRequirement } from '@salon/shared';
import { jwtVerify } from 'jose';
import { env, isProduction } from '../config/env.js';
import { withSystem } from '../db/tenant.js';
import { AppError } from './errors.js';
import { metrics } from './metrics.js';

export interface AuthContext {
  userId: string;
  fullName: string;
  orgId: string | null;
  isPlatformAdmin: boolean;
  roleId: string | null;
  roleKey: string | null;
  homeScreen: HomeScreen | null;
  permissions: ReadonlySet<Permission>;
  allBranches: boolean;
  /** Branches this user may access (all non-archived org branches when allBranches). */
  branchIds: string[];
  staffId: string | null;
  /** This user has two-step sign-in switched on. */
  twoFactorEnabled: boolean;
  /** The salon (or, in production, the platform) requires two-step sign-in for this user, whether or not it is set up. */
  twoFactorRequired: boolean;
  /** Required but not set up yet: only the account and security routes are reachable until it is. */
  mfaSetupRequired: boolean;
  requestId: string;
  ip: string | null;
  userAgent: string | null;
}

/** Context for work not triggered by a user (worker jobs, public booking). */
export function systemContext(orgId: string | null, requestId = 'system'): AuthContext {
  return {
    userId: '',
    fullName: 'System',
    orgId,
    isPlatformAdmin: false,
    roleId: null,
    roleKey: null,
    homeScreen: null,
    permissions: new Set(),
    allBranches: true,
    branchIds: [],
    staffId: null,
    twoFactorEnabled: false,
    twoFactorRequired: false,
    mfaSetupRequired: false,
    requestId,
    ip: null,
    userAgent: null,
  };
}

export const ACCESS_TOKEN_KEY = new TextEncoder().encode(env.JWT_ACCESS_SECRET);

type Principal = Omit<AuthContext, 'requestId' | 'ip' | 'userAgent'>;

const CACHE_TTL_MS = 10_000;
const cache = new Map<string, { principal: Principal; expires: number }>();

/** Permission/branch changes take effect within CACHE_TTL_MS on every instance, immediately on this one. */
export function invalidatePrincipal(userId?: string): void {
  if (userId) cache.delete(userId);
  else cache.clear();
}

async function loadPrincipal(userId: string): Promise<Principal | null> {
  return withSystem(async (tx) => {
    const user = await tx
      .selectFrom('users as u')
      .leftJoin('roles as r', 'r.id', 'u.roleId')
      .leftJoin('organizations as o', 'o.id', 'u.organizationId')
      .leftJoin('staff as s', 's.userId', 'u.id')
      .leftJoin('organizationSettings as os', 'os.organizationId', 'u.organizationId')
      .select([
        'u.id',
        'u.fullName',
        'u.organizationId',
        'u.isPlatformAdmin',
        'u.allBranches',
        'u.status',
        'u.roleId',
        'r.key as roleKey',
        'r.homeScreen',
        'r.isLocked',
        'o.status as orgStatus',
        's.id as staffId',
        'u.totpEnabledAt',
        'os.twoFactorRequirement',
      ])
      .where('u.id', '=', userId)
      .executeTakeFirst();
    if (!user || user.status !== 'active') return null;
    if (user.organizationId && user.orgStatus !== 'active') {
      throw new AppError(403, 'ACCOUNT_DISABLED', 'This salon account is not active. Please contact support.');
    }

    let permissions: Permission[] = [];
    let branchIds: string[] = [];
    if (user.organizationId) {
      if (user.isLocked) {
        const rows = await tx.selectFrom('permissions').select('key').execute();
        permissions = rows.map((r) => r.key).filter(isPermission);
      } else if (user.roleId) {
        const rows = await tx.selectFrom('rolePermissions').select('permissionKey').where('roleId', '=', user.roleId).execute();
        permissions = rows.map((r) => r.permissionKey).filter(isPermission);
      }
      const branchRows = user.allBranches
        ? await tx
            .selectFrom('branches')
            .select('id')
            .where('organizationId', '=', user.organizationId)
            .where('status', '!=', 'archived')
            .execute()
        : await tx
            .selectFrom('userBranches as ub')
            .innerJoin('branches as b', 'b.id', 'ub.branchId')
            .select('b.id')
            .where('ub.userId', '=', user.id)
            .where('b.status', '!=', 'archived')
            .execute();
      branchIds = branchRows.map((b) => b.id);
    }

    // Two-step sign-in policy: the salon decides for owners and managers; platform administrators always need it in production.
    const permissionSet = new Set(permissions);
    const required = user.isPlatformAdmin ? isProduction : twoFactorApplies((user.twoFactorRequirement ?? 'off') as TwoFactorRequirement, user.roleKey, permissionSet);
    const twoFactorEnabled = user.totpEnabledAt !== null;

    return {
      userId: user.id,
      fullName: user.fullName,
      orgId: user.organizationId,
      isPlatformAdmin: user.isPlatformAdmin,
      roleId: user.roleId,
      roleKey: user.roleKey,
      homeScreen: (user.homeScreen as HomeScreen | null) ?? null,
      permissions: permissionSet,
      allBranches: user.allBranches,
      branchIds,
      staffId: user.staffId,
      twoFactorEnabled,
      twoFactorRequired: required,
      mfaSetupRequired: required && !twoFactorEnabled,
    };
  });
}

export async function getPrincipal(userId: string): Promise<Principal | null> {
  const hit = cache.get(userId);
  if (hit && hit.expires > Date.now()) return hit.principal;
  const principal = await loadPrincipal(userId);
  if (principal) cache.set(userId, { principal, expires: Date.now() + CACHE_TTL_MS });
  else cache.delete(userId);
  return principal;
}

export async function authenticateBearer(
  authorization: string | undefined,
  meta: { requestId: string; ip: string | null; userAgent: string | null },
): Promise<AuthContext> {
  if (!authorization?.startsWith('Bearer ')) {
    metrics.authFailures.inc({ reason: 'missing_token' });
    throw new AppError(401, 'UNAUTHENTICATED', 'Please sign in to continue.');
  }
  let userId: string;
  try {
    const { payload } = await jwtVerify(authorization.slice(7), ACCESS_TOKEN_KEY, {
      issuer: env.JWT_ISSUER,
      algorithms: ['HS256'],
      typ: 'access+jwt',
    });
    if (typeof payload.sub !== 'string') throw new Error('no subject');
    userId = payload.sub;
  } catch {
    metrics.authFailures.inc({ reason: 'invalid_token' });
    throw new AppError(401, 'SESSION_EXPIRED', 'Your session has expired. Please sign in again.');
  }
  const principal = await getPrincipal(userId);
  if (!principal) {
    metrics.authFailures.inc({ reason: 'disabled_user' });
    throw new AppError(401, 'ACCOUNT_DISABLED', 'This account is disabled. Please contact your salon owner.');
  }
  return { ...principal, ...meta };
}

// ───────────── Authorization helpers ─────────────

export function hasPermission(auth: AuthContext, permission: Permission): boolean {
  return auth.permissions.has(permission);
}

export function hasAnyPermission(auth: AuthContext, permissions: readonly Permission[]): boolean {
  return permissions.some((p) => auth.permissions.has(p));
}

export function requirePermissionIn(auth: AuthContext, permission: Permission, message?: string): void {
  if (!auth.permissions.has(permission)) {
    throw new AppError(403, 'FORBIDDEN', message ?? "You don't have permission to do this. Ask your manager for access.");
  }
}

export function requireOrgId(auth: AuthContext): string {
  if (!auth.orgId) throw new AppError(403, 'FORBIDDEN', 'This action is only available inside a salon account.');
  return auth.orgId;
}

export function assertBranchAccess(auth: AuthContext, branchId: string): void {
  if (!auth.branchIds.includes(branchId)) {
    throw new AppError(403, 'BRANCH_ACCESS_DENIED', "You don't have access to this branch.");
  }
}

/** Branches to filter a query by: the requested one (after an access check) or every branch the user can see. */
export function branchFilter(auth: AuthContext, requested?: string | null): string[] {
  if (requested) {
    assertBranchAccess(auth, requested);
    return [requested];
  }
  return nonEmpty(auth.branchIds);
}

const NO_MATCH = '00000000-0000-0000-0000-000000000000';
/** `IN ()` is invalid SQL; an impossible id keeps "no access" queries valid and empty. */
export function nonEmpty(ids: readonly string[]): string[] {
  return ids.length ? [...ids] : [NO_MATCH];
}

/** True when the user may only see their own appointments (staff role). */
export function isOwnScopeOnly(auth: AuthContext): boolean {
  return !auth.permissions.has('appointments.view') && auth.permissions.has('appointments.view_own');
}
