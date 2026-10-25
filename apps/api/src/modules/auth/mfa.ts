import { randomBytes } from 'node:crypto';
import type { MfaChallenge, MfaConfirmInput, TwoFactorSetup, TwoFactorState } from '@salon/shared';
import { jwtVerify, SignJWT } from 'jose';
import { env } from '../../config/env.js';
import { audit } from '../../core/audit.js';
import { ACCESS_TOKEN_KEY, invalidatePrincipal, type AuthContext } from '../../core/auth-context.js';
import { decryptSecret, encryptSecret } from '../../core/crypto.js';
import { AppError } from '../../core/errors.js';
import { hashPassword, verifyPassword } from '../../core/passwords.js';
import { generateTotpSecret, otpauthUrl, verifyTotp } from '../../core/totp.js';
import { withTenant, type Tx } from '../../db/tenant.js';
import { DateTime } from 'luxon';

// Two-step sign-in: an authenticator-app code (TOTP) after the password, with one-time recovery codes for a lost phone.
// A secret that has been generated but not confirmed lives in `totp_pending_secret_enc`, so a half-finished set-up never
// switches anything on. Both secrets are encrypted at rest; recovery codes are stored only as Argon2id hashes.

export const MFA_TOKEN_TTL_SECONDS = 5 * 60;
export const RECOVERY_CODE_COUNT = 10;
// No 0/O/1/I, so a code read off a printout cannot be mistyped. 32 symbols × 10 characters = 50 bits.
const RECOVERY_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

// ───────────── The short-lived proof that the password step passed ─────────────

/** Signed with the access-token key but a different `typ`, so it can never be used as a bearer token (and vice versa). */
export async function issueMfaToken(userId: string): Promise<MfaChallenge> {
  const mfaToken = await new SignJWT({})
    .setProtectedHeader({ alg: 'HS256', typ: 'mfa+jwt' })
    .setSubject(userId)
    .setIssuer(env.JWT_ISSUER)
    .setIssuedAt()
    .setExpirationTime(`${MFA_TOKEN_TTL_SECONDS}s`)
    .sign(ACCESS_TOKEN_KEY);
  return { mfaRequired: true, mfaToken, expiresIn: MFA_TOKEN_TTL_SECONDS };
}

export async function readMfaToken(token: string): Promise<string> {
  try {
    const { payload } = await jwtVerify(token, ACCESS_TOKEN_KEY, { issuer: env.JWT_ISSUER, algorithms: ['HS256'], typ: 'mfa+jwt' });
    if (typeof payload.sub !== 'string') throw new Error('no subject');
    return payload.sub;
  } catch {
    throw new AppError(401, 'SESSION_EXPIRED', 'That sign-in took too long. Please start again.');
  }
}

// ───────────── Recovery codes ─────────────

export function generateRecoveryCode(): string {
  let raw = '';
  for (const byte of randomBytes(10)) raw += RECOVERY_ALPHABET[byte & 31]; // 256 is a multiple of 32, so every symbol is equally likely
  return `${raw.slice(0, 5)}-${raw.slice(5)}`;
}

const compact = (input: string): string => input.replace(/[\s-]/g, '').toUpperCase();

async function replaceRecoveryCodes(tx: Tx, userId: string, orgId: string | null): Promise<string[]> {
  const codes = Array.from({ length: RECOVERY_CODE_COUNT }, generateRecoveryCode);
  const hashes = await Promise.all(codes.map((code) => hashPassword(compact(code))));
  await tx.deleteFrom('userRecoveryCodes').where('userId', '=', userId).execute();
  await tx.insertInto('userRecoveryCodes').values(hashes.map((codeHash) => ({ organizationId: orgId, userId, codeHash }))).execute();
  return codes;
}

async function countRecoveryCodes(tx: Tx, userId: string): Promise<number> {
  const row = await tx
    .selectFrom('userRecoveryCodes')
    .select((eb) => eb.fn.countAll<number>().as('n'))
    .where('userId', '=', userId)
    .where('usedAt', 'is', null)
    .executeTakeFirstOrThrow();
  return row.n;
}

// ───────────── Checking the second step ─────────────

export interface SecondFactorUser {
  id: string;
  totpSecretEnc: string | null;
  totpLastStep: number | null;
}

export type SecondFactorResult = { ok: true; method: 'totp' | 'recovery' } | { ok: false };

/**
 * Accepts either the current authenticator code or an unused recovery code, and spends it. A code is accepted at most
 * once: the TOTP step is advanced with a compare-and-set so two simultaneous requests cannot both use the same code.
 */
export async function checkSecondFactor(tx: Tx, user: SecondFactorUser, submitted: string): Promise<SecondFactorResult> {
  if (!user.totpSecretEnc) return { ok: false };
  const code = compact(submitted);

  if (/^\d{6}$/.test(code)) {
    const step = verifyTotp(decryptSecret(user.totpSecretEnc), code, { lastStep: user.totpLastStep });
    if (step === null) return { ok: false };
    const spent = await tx
      .updateTable('users')
      .set({ totpLastStep: step })
      .where('id', '=', user.id)
      .where((eb) => eb.or([eb('totpLastStep', 'is', null), eb('totpLastStep', '<', step)]))
      .executeTakeFirst();
    return Number(spent.numUpdatedRows) > 0 ? { ok: true, method: 'totp' } : { ok: false };
  }

  if (code.length !== 10) return { ok: false };
  const rows = await tx.selectFrom('userRecoveryCodes').select(['id', 'codeHash']).where('userId', '=', user.id).where('usedAt', 'is', null).execute();
  for (const row of rows) {
    if (!(await verifyPassword(row.codeHash, code))) continue;
    const spent = await tx.updateTable('userRecoveryCodes').set({ usedAt: new Date() }).where('id', '=', row.id).where('usedAt', 'is', null).executeTakeFirst();
    return Number(spent.numUpdatedRows) > 0 ? { ok: true, method: 'recovery' } : { ok: false };
  }
  return { ok: false };
}

/** A wrong code counts toward the same lock-out as a wrong password. Returns true when this failure locked the account. */
export async function registerSecondFactorFailure(tx: Tx, actor: AuthContext, user: { id: string; failedLoginCount: number }): Promise<boolean> {
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
    action: lock ? 'auth.locked' : 'auth.mfa_failed',
    entityType: 'user',
    entityId: user.id,
    summary: lock ? 'Account locked after repeated wrong two-step codes' : 'Wrong two-step code',
  });
  return lock;
}

export const INVALID_CODE_MESSAGE = "That code didn't work. Open your authenticator app for the current 6-digit code, or use a recovery code.";

// ───────────── State ─────────────

export async function twoFactorState(tx: Tx, principal: Pick<AuthContext, 'userId' | 'twoFactorEnabled' | 'twoFactorRequired' | 'mfaSetupRequired'>): Promise<TwoFactorState> {
  return {
    enabled: principal.twoFactorEnabled,
    required: principal.twoFactorRequired,
    setupRequired: principal.mfaSetupRequired,
    recoveryCodesLeft: principal.twoFactorEnabled ? await countRecoveryCodes(tx, principal.userId) : 0,
  };
}

const scopeOf = (auth: AuthContext) => ({ orgId: auth.orgId, platform: auth.isPlatformAdmin, userId: auth.userId });

// ───────────── Setting it up ─────────────

/** Step 1: make a secret for the QR code. Nothing is switched on until the person proves their app shows the right code. */
export async function beginSetup(auth: AuthContext): Promise<TwoFactorSetup> {
  return withTenant(scopeOf(auth), async (tx) => {
    const user = await tx.selectFrom('users').select(['email', 'phone', 'totpEnabledAt']).where('id', '=', auth.userId).executeTakeFirstOrThrow();
    if (user.totpEnabledAt) throw new AppError(409, 'CONFLICT', 'Two-step sign-in is already on. Switch it off first if you want to set it up again.');
    const org = auth.orgId ? await tx.selectFrom('organizations').select('name').where('id', '=', auth.orgId).executeTakeFirst() : undefined;
    const secret = generateTotpSecret();
    await tx.updateTable('users').set({ totpPendingSecretEnc: encryptSecret(secret) }).where('id', '=', auth.userId).execute();
    return { secret, otpauthUrl: otpauthUrl({ secret, account: user.email ?? user.phone ?? auth.fullName, issuer: org?.name ?? 'SalonOS Platform' }) };
  });
}

/** Step 2: the first code from the app switches it on and hands out the recovery codes (shown once). */
export async function enableTwoFactor(auth: AuthContext, code: string): Promise<{ recoveryCodes: string[] }> {
  const recoveryCodes = await withTenant(scopeOf(auth), async (tx) => {
    const user = await tx.selectFrom('users').select(['totpEnabledAt', 'totpPendingSecretEnc']).where('id', '=', auth.userId).forUpdate().executeTakeFirstOrThrow();
    if (user.totpEnabledAt) throw new AppError(409, 'CONFLICT', 'Two-step sign-in is already on.');
    if (!user.totpPendingSecretEnc) throw new AppError(400, 'BAD_REQUEST', 'Start the set-up again to get a new key.');
    const step = verifyTotp(decryptSecret(user.totpPendingSecretEnc), code);
    if (step === null) throw new AppError(400, 'INVALID_MFA_CODE', INVALID_CODE_MESSAGE, { issues: [{ path: 'code', message: 'Incorrect code' }] });
    await tx
      .updateTable('users')
      .set({ totpSecretEnc: user.totpPendingSecretEnc, totpPendingSecretEnc: null, totpEnabledAt: new Date(), totpLastStep: step })
      .where('id', '=', auth.userId)
      .execute();
    const codes = await replaceRecoveryCodes(tx, auth.userId, auth.orgId);
    await audit(tx, auth, { action: 'auth.mfa_enabled', entityType: 'user', entityId: auth.userId, summary: 'Switched on two-step sign-in' });
    return codes;
  });
  invalidatePrincipal(auth.userId);
  return { recoveryCodes };
}

// ───────────── Changing it (password and a code are both required) ─────────────

/** Runs `work` only if the person proves who they are again: their password and a current code (or a recovery code). */
async function withConfirmedIdentity<T>(auth: AuthContext, input: MfaConfirmInput, work: (tx: Tx) => Promise<T>): Promise<T> {
  const outcome = await withTenant(scopeOf(auth), async (tx) => {
    const user = await tx
      .selectFrom('users')
      .select(['id', 'passwordHash', 'totpSecretEnc', 'totpLastStep', 'failedLoginCount', 'lockedUntil'])
      .where('id', '=', auth.userId)
      .forUpdate()
      .executeTakeFirstOrThrow();
    if (!user.totpSecretEnc) return { kind: 'not_enabled' as const };
    if (user.lockedUntil && user.lockedUntil > new Date()) return { kind: 'locked' as const };
    const passwordOk = await verifyPassword(user.passwordHash, input.password);
    const factor = passwordOk ? await checkSecondFactor(tx, user, input.code) : ({ ok: false } as const);
    if (!factor.ok) {
      await registerSecondFactorFailure(tx, auth, user);
      return { kind: passwordOk ? ('bad_code' as const) : ('bad_password' as const) };
    }
    if (user.failedLoginCount > 0) await tx.updateTable('users').set({ failedLoginCount: 0 }).where('id', '=', user.id).execute();
    return { kind: 'ok' as const, value: await work(tx) };
  });
  switch (outcome.kind) {
    case 'ok':
      return outcome.value;
    case 'not_enabled':
      throw new AppError(409, 'CONFLICT', 'Two-step sign-in is not switched on.');
    case 'locked':
      throw new AppError(423, 'ACCOUNT_LOCKED', `Too many unsuccessful attempts. Try again in ${env.LOGIN_LOCK_MINUTES} minutes.`);
    case 'bad_password':
      throw new AppError(400, 'VALIDATION_ERROR', 'Your password is incorrect.', { issues: [{ path: 'password', message: 'Incorrect password' }] });
    default:
      throw new AppError(400, 'INVALID_MFA_CODE', INVALID_CODE_MESSAGE, { issues: [{ path: 'code', message: 'Incorrect code' }] });
  }
}

export async function disableTwoFactor(auth: AuthContext, input: MfaConfirmInput): Promise<void> {
  if (auth.twoFactorRequired) {
    throw new AppError(403, 'MFA_REQUIRED_BY_POLICY', 'Your salon requires two-step sign-in for your role, so it cannot be switched off. Ask an owner to change the policy first.');
  }
  await withConfirmedIdentity(auth, input, async (tx) => {
    await clearTwoFactor(tx, auth.userId);
    await audit(tx, auth, { action: 'auth.mfa_disabled', entityType: 'user', entityId: auth.userId, summary: 'Switched off two-step sign-in' });
  });
  invalidatePrincipal(auth.userId);
}

export async function regenerateRecoveryCodes(auth: AuthContext, input: MfaConfirmInput): Promise<{ recoveryCodes: string[] }> {
  const recoveryCodes = await withConfirmedIdentity(auth, input, async (tx) => {
    const codes = await replaceRecoveryCodes(tx, auth.userId, auth.orgId);
    await audit(tx, auth, { action: 'auth.recovery_codes_regenerated', entityType: 'user', entityId: auth.userId, summary: 'Made new recovery codes (the old ones stopped working)' });
    return codes;
  });
  return { recoveryCodes };
}

/** Removes the secret and the recovery codes. Used when a person switches it off and when an administrator resets it. */
export async function clearTwoFactor(tx: Tx, userId: string): Promise<void> {
  await tx
    .updateTable('users')
    .set({ totpSecretEnc: null, totpPendingSecretEnc: null, totpEnabledAt: null, totpLastStep: null })
    .where('id', '=', userId)
    .execute();
  await tx.deleteFrom('userRecoveryCodes').where('userId', '=', userId).execute();
}
