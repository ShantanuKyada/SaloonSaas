import { normalizePhone, type LoginResponse, type MfaChallenge, type SessionUser } from '@salon/shared';
import { SignJWT } from 'jose';
import { DateTime } from 'luxon';
import { env } from '../../config/env.js';
import { audit } from '../../core/audit.js';
import { ACCESS_TOKEN_KEY, getPrincipal, invalidatePrincipal, systemContext, type AuthContext } from '../../core/auth-context.js';
import { randomToken, sha256 } from '../../core/crypto.js';
import { AppError } from '../../core/errors.js';
import { logger } from '../../core/logger.js';
import { metrics } from '../../core/metrics.js';
import { burnPasswordCheck, hashPassword, verifyPassword } from '../../core/passwords.js';
import { withSystem, withTenant, type Tx } from '../../db/tenant.js';
import type { HomeScreen } from '@salon/shared';
import { checkSecondFactor, INVALID_CODE_MESSAGE, issueMfaToken, readMfaToken, registerSecondFactorFailure, twoFactorState } from './mfa.js';

export const REFRESH_COOKIE = 'salon_rt';

export interface ClientMeta {
  ip: string | null;
  userAgent: string | null;
  requestId: string;
}

export async function issueAccessToken(userId: string, orgId: string | null): Promise<string> {
  return new SignJWT({ org: orgId })
    .setProtectedHeader({ alg: 'HS256', typ: 'access+jwt' })
    .setSubject(userId)
    .setIssuer(env.JWT_ISSUER)
    .setIssuedAt()
    .setExpirationTime(`${env.ACCESS_TOKEN_TTL_SECONDS}s`)
    .sign(ACCESS_TOKEN_KEY);
}

async function createRefreshToken(tx: Tx, userId: string, familyId: string | null, meta: ClientMeta): Promise<{ token: string; id: string }> {
  const token = randomToken(32);
  const row = await tx
    .insertInto('refreshTokens')
    .values({
      userId,
      familyId: familyId ?? crypto.randomUUID(),
      tokenHash: sha256(token),
      expiresAt: DateTime.utc().plus({ days: env.REFRESH_TOKEN_TTL_DAYS }).toJSDate(),
      ip: meta.ip,
      userAgent: meta.userAgent?.slice(0, 300) ?? null,
    })
    .returning('id')
    .executeTakeFirstOrThrow();
  return { token, id: row.id };
}

function actorFor(userId: string, orgId: string | null, meta: ClientMeta): AuthContext {
  return { ...systemContext(orgId, meta.requestId), userId, ip: meta.ip, userAgent: meta.userAgent };
}

type LoginFailure = 'invalid' | 'locked' | 'disabled' | 'org_inactive' | 'invalid_code' | 'expired';

function rejectLogin(reason: LoginFailure): never {
  switch (reason) {
    case 'locked':
      throw new AppError(
        423,
        'ACCOUNT_LOCKED',
        `Too many unsuccessful attempts. Try again in ${env.LOGIN_LOCK_MINUTES} minutes, or ask your salon owner to reset your password.`,
      );
    case 'disabled':
      throw new AppError(403, 'ACCOUNT_DISABLED', 'This account has been disabled. Please contact your salon owner.');
    case 'org_inactive':
      throw new AppError(403, 'ACCOUNT_DISABLED', 'This salon account is not active. Please contact support.');
    case 'invalid_code':
      throw new AppError(401, 'INVALID_MFA_CODE', INVALID_CODE_MESSAGE);
    case 'expired':
      throw new AppError(401, 'SESSION_EXPIRED', 'That sign-in took too long. Please start again.');
    default:
      throw new AppError(401, 'INVALID_CREDENTIALS', 'The email/mobile number or password is incorrect.');
  }
}

/** A correct password either signs the person in or, with two-step sign-in on, hands back a short-lived challenge to finish with a code. */
export async function login(
  identifier: string,
  password: string,
  meta: ClientMeta,
): Promise<{ response: LoginResponse | MfaChallenge; refreshToken: string | null }> {
  const trimmed = identifier.trim();
  const isEmail = trimmed.includes('@');
  const phone = isEmail ? null : normalizePhone(trimmed);

  const result = await withSystem(async (tx) => {
    const user = await tx
      .selectFrom('users')
      .select(['id', 'organizationId', 'passwordHash', 'status', 'failedLoginCount', 'lockedUntil', 'totpEnabledAt'])
      .$if(isEmail, (q) => q.where('email', '=', trimmed.toLowerCase()))
      .$if(!isEmail, (q) => q.where('phone', '=', phone ?? '__invalid__'))
      // Locked so simultaneous guesses cannot all read the same attempt counter and slip past the lock-out.
      .forUpdate()
      .executeTakeFirst();

    if (!user) {
      await burnPasswordCheck(password);
      metrics.authFailures.inc({ reason: 'unknown_user' });
      return { ok: false as const, reason: 'invalid' as const };
    }
    const actor = actorFor(user.id, user.organizationId, meta);

    if (user.lockedUntil && user.lockedUntil > new Date()) {
      metrics.authFailures.inc({ reason: 'locked' });
      return { ok: false as const, reason: 'locked' as const, until: user.lockedUntil };
    }
    const valid = await verifyPassword(user.passwordHash, password);
    if (!valid) {
      const attempts = user.failedLoginCount + 1;
      const lock = attempts >= env.LOGIN_MAX_ATTEMPTS;
      await tx
        .updateTable('users')
        .set({
          failedLoginCount: lock ? 0 : attempts,
          lockedUntil: lock ? DateTime.utc().plus({ minutes: env.LOGIN_LOCK_MINUTES }).toJSDate() : null,
        })
        .where('id', '=', user.id)
        .execute();
      await audit(tx, actor, {
        action: lock ? 'auth.locked' : 'auth.login_failed',
        entityType: 'user',
        entityId: user.id,
        summary: lock ? 'Account locked after repeated failed sign-ins' : 'Failed sign-in',
      });
      metrics.authFailures.inc({ reason: 'bad_password' });
      return { ok: false as const, reason: lock ? ('locked' as const) : ('invalid' as const) };
    }
    if (user.status !== 'active') {
      metrics.authFailures.inc({ reason: 'disabled' });
      return { ok: false as const, reason: 'disabled' as const };
    }
    if (user.organizationId) {
      const org = await tx.selectFrom('organizations').select('status').where('id', '=', user.organizationId).executeTakeFirst();
      if (org?.status !== 'active') return { ok: false as const, reason: 'org_inactive' as const };
    }

    // The attempt counter is not reset yet: it is cleared only once the second step succeeds, so a stolen password does
    // not give unlimited tries at the code.
    if (user.totpEnabledAt) return { ok: true as const, mfa: true as const, userId: user.id };

    await tx
      .updateTable('users')
      .set({ failedLoginCount: 0, lockedUntil: null, lastLoginAt: new Date() })
      .where('id', '=', user.id)
      .execute();
    const refresh = await createRefreshToken(tx, user.id, null, meta);
    await audit(tx, actor, { action: 'auth.login', entityType: 'user', entityId: user.id, summary: 'Signed in' });
    return { ok: true as const, mfa: false as const, userId: user.id, orgId: user.organizationId, refreshToken: refresh.token };
  });

  if (!result.ok) rejectLogin(result.reason);
  if (result.mfa) return { response: await issueMfaToken(result.userId), refreshToken: null };

  invalidatePrincipal(result.userId);
  const [accessToken, user] = await Promise.all([issueAccessToken(result.userId, result.orgId), buildSession(result.userId)]);
  return { response: { accessToken, expiresIn: env.ACCESS_TOKEN_TTL_SECONDS, user }, refreshToken: result.refreshToken };
}

/** Second step of sign-in: the code from the authenticator app (or a recovery code) completes what the password started. */
export async function loginWithMfa(mfaToken: string, code: string, meta: ClientMeta): Promise<{ response: LoginResponse; refreshToken: string }> {
  const userId = await readMfaToken(mfaToken);

  const result = await withSystem(async (tx) => {
    const user = await tx
      .selectFrom('users')
      .select(['id', 'organizationId', 'status', 'failedLoginCount', 'lockedUntil', 'totpSecretEnc', 'totpLastStep'])
      .where('id', '=', userId)
      .forUpdate()
      .executeTakeFirst();
    if (!user?.totpSecretEnc) return { ok: false as const, reason: 'expired' as const };
    const actor = actorFor(user.id, user.organizationId, meta);

    if (user.lockedUntil && user.lockedUntil > new Date()) {
      metrics.authFailures.inc({ reason: 'locked' });
      return { ok: false as const, reason: 'locked' as const };
    }
    if (user.status !== 'active') return { ok: false as const, reason: 'disabled' as const };
    if (user.organizationId) {
      const org = await tx.selectFrom('organizations').select('status').where('id', '=', user.organizationId).executeTakeFirst();
      if (org?.status !== 'active') return { ok: false as const, reason: 'org_inactive' as const };
    }

    const factor = await checkSecondFactor(tx, user, code);
    if (!factor.ok) {
      const locked = await registerSecondFactorFailure(tx, actor, user);
      metrics.authFailures.inc({ reason: 'bad_mfa_code' });
      return { ok: false as const, reason: locked ? ('locked' as const) : ('invalid_code' as const) };
    }

    await tx
      .updateTable('users')
      .set({ failedLoginCount: 0, lockedUntil: null, lastLoginAt: new Date() })
      .where('id', '=', user.id)
      .execute();
    const refresh = await createRefreshToken(tx, user.id, null, meta);
    await audit(tx, actor, {
      action: 'auth.login',
      entityType: 'user',
      entityId: user.id,
      summary: factor.method === 'recovery' ? 'Signed in with a recovery code' : 'Signed in with two-step verification',
    });
    return { ok: true as const, userId: user.id, orgId: user.organizationId, refreshToken: refresh.token };
  });

  if (!result.ok) rejectLogin(result.reason);

  invalidatePrincipal(result.userId);
  const [accessToken, user] = await Promise.all([issueAccessToken(result.userId, result.orgId), buildSession(result.userId)]);
  return { response: { accessToken, expiresIn: env.ACCESS_TOKEN_TTL_SECONDS, user }, refreshToken: result.refreshToken };
}

/** Rotates the refresh token. Presenting an already-rotated token revokes the whole family (theft detection). */
export async function refresh(token: string, meta: ClientMeta): Promise<{ response: LoginResponse; refreshToken: string }> {
  const outcome = await withSystem(async (tx) => {
    const row = await tx
      .selectFrom('refreshTokens as rt')
      .innerJoin('users as u', 'u.id', 'rt.userId')
      .select(['rt.id', 'rt.userId', 'rt.familyId', 'rt.expiresAt', 'rt.revokedAt', 'u.organizationId', 'u.status'])
      .where('rt.tokenHash', '=', sha256(token))
      .forUpdate('rt')
      .executeTakeFirst();
    if (!row) return { ok: false as const };
    if (row.revokedAt) {
      await tx
        .updateTable('refreshTokens')
        .set({ revokedAt: new Date(), revokedReason: 'reuse_detected' })
        .where('familyId', '=', row.familyId)
        .where('revokedAt', 'is', null)
        .execute();
      await audit(tx, actorFor(row.userId, row.organizationId, meta), {
        action: 'auth.refresh_reuse',
        entityType: 'user',
        entityId: row.userId,
        summary: 'Refresh token reuse detected; all sessions in this family were signed out',
      });
      logger.warn({ userId: row.userId }, 'refresh token reuse detected');
      metrics.authFailures.inc({ reason: 'refresh_reuse' });
      return { ok: false as const };
    }
    if (row.expiresAt < new Date() || row.status !== 'active') return { ok: false as const };
    const next = await createRefreshToken(tx, row.userId, row.familyId, meta);
    await tx
      .updateTable('refreshTokens')
      .set({ revokedAt: new Date(), revokedReason: 'rotated', replacedById: next.id })
      .where('id', '=', row.id)
      .execute();
    return { ok: true as const, userId: row.userId, orgId: row.organizationId, refreshToken: next.token };
  });
  if (!outcome.ok) throw new AppError(401, 'SESSION_EXPIRED', 'Your session has expired. Please sign in again.');
  const [accessToken, user] = await Promise.all([issueAccessToken(outcome.userId, outcome.orgId), buildSession(outcome.userId)]);
  return { response: { accessToken, expiresIn: env.ACCESS_TOKEN_TTL_SECONDS, user }, refreshToken: outcome.refreshToken };
}

export async function logout(token: string | undefined, meta: ClientMeta): Promise<void> {
  if (!token) return;
  await withSystem(async (tx) => {
    const row = await tx.selectFrom('refreshTokens').select(['familyId', 'userId']).where('tokenHash', '=', sha256(token)).executeTakeFirst();
    if (!row) return;
    await tx
      .updateTable('refreshTokens')
      .set({ revokedAt: new Date(), revokedReason: 'logout' })
      .where('familyId', '=', row.familyId)
      .where('revokedAt', 'is', null)
      .execute();
    const user = await tx.selectFrom('users').select('organizationId').where('id', '=', row.userId).executeTakeFirst();
    await audit(tx, actorFor(row.userId, user?.organizationId ?? null, meta), {
      action: 'auth.logout',
      entityType: 'user',
      entityId: row.userId,
      summary: 'Signed out',
    });
  });
}

export async function revokeAllSessions(tx: Tx, userId: string, reason: string): Promise<void> {
  await tx
    .updateTable('refreshTokens')
    .set({ revokedAt: new Date(), revokedReason: reason })
    .where('userId', '=', userId)
    .where('revokedAt', 'is', null)
    .execute();
  invalidatePrincipal(userId);
}

export async function changePassword(auth: AuthContext, currentPassword: string, newPassword: string): Promise<void> {
  await withTenant({ orgId: auth.orgId, platform: auth.isPlatformAdmin, userId: auth.userId }, async (tx) => {
    const user = await tx.selectFrom('users').select(['passwordHash']).where('id', '=', auth.userId).executeTakeFirstOrThrow();
    if (!(await verifyPassword(user.passwordHash, currentPassword))) {
      throw new AppError(400, 'VALIDATION_ERROR', 'Your current password is incorrect.', {
        issues: [{ path: 'currentPassword', message: 'Incorrect password' }],
      });
    }
    await tx
      .updateTable('users')
      .set({ passwordHash: await hashPassword(newPassword), passwordChangedAt: new Date(), mustChangePassword: false })
      .where('id', '=', auth.userId)
      .execute();
    await audit(tx, auth, { action: 'auth.password_changed', entityType: 'user', entityId: auth.userId, summary: 'Changed own password' });
  });
}

export async function buildSession(userId: string): Promise<SessionUser> {
  const principal = await getPrincipal(userId);
  if (!principal) throw new AppError(401, 'ACCOUNT_DISABLED', 'This account is disabled.');
  return withSystem(async (tx) => {
    const user = await tx
      .selectFrom('users')
      .select(['id', 'fullName', 'email', 'phone', 'mustChangePassword'])
      .where('id', '=', userId)
      .executeTakeFirstOrThrow();

    let organization: SessionUser['organization'] = null;
    let preferences: SessionUser['preferences'] = null;
    let branches: SessionUser['branches'] = [];
    let role: SessionUser['role'] = null;

    if (principal.orgId) {
      const org = await tx
        .selectFrom('organizations as o')
        .innerJoin('organizationSettings as s', 's.organizationId', 'o.id')
        .select([
          'o.id',
          'o.code',
          'o.name',
          'o.currency',
          'o.timezone',
          'o.country',
          'o.taxLabel',
          'o.logoUrl',
          'o.onboardingCompletedAt',
          's.staffCanViewCustomerPhone',
          's.staffCanViewOwnPerformance',
          's.slotIntervalMinutes',
          's.pricesIncludeTax',
          's.defaultTaxRateBp',
          's.roundOffToMinor',
        ])
        .where('o.id', '=', principal.orgId)
        .executeTakeFirstOrThrow();
      organization = {
        id: org.id,
        code: org.code,
        name: org.name,
        currency: org.currency,
        timezone: org.timezone,
        country: org.country,
        taxLabel: org.taxLabel,
        logoUrl: org.logoUrl,
        onboardingCompleted: org.onboardingCompletedAt !== null,
      };
      preferences = {
        staffCanViewCustomerPhone: org.staffCanViewCustomerPhone,
        staffCanViewOwnPerformance: org.staffCanViewOwnPerformance,
        slotIntervalMinutes: org.slotIntervalMinutes,
        pricesIncludeTax: org.pricesIncludeTax,
        defaultTaxRateBp: org.defaultTaxRateBp,
        roundOffToMinor: org.roundOffToMinor,
      };
      if (principal.branchIds.length) {
        branches = await tx
          .selectFrom('branches')
          .select(['id', 'code', 'name', 'timezone', 'status', 'phone'])
          .where('id', 'in', principal.branchIds)
          .orderBy('name')
          .execute();
      }
      const roleRow = principal.roleId
        ? await tx.selectFrom('roles').select(['id', 'key', 'name', 'homeScreen']).where('id', '=', principal.roleId).executeTakeFirst()
        : undefined;
      role = roleRow ? { id: roleRow.id, key: roleRow.key, name: roleRow.name, homeScreen: roleRow.homeScreen as HomeScreen } : null;
    }

    return {
      id: user.id,
      fullName: user.fullName,
      email: user.email,
      phone: user.phone,
      isPlatformAdmin: principal.isPlatformAdmin,
      organization,
      role,
      permissions: [...principal.permissions],
      allBranches: principal.allBranches,
      branches,
      staffId: principal.staffId,
      mustChangePassword: user.mustChangePassword,
      twoFactor: await twoFactorState(tx, principal),
      preferences,
    };
  });
}
