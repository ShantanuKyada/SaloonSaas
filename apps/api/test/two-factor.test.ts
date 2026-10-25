import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { env } from '../src/config/env.js';
import { totpAt } from '../src/core/totp.js';
import { withSystem } from '../src/db/tenant.js';
import { api, authed, createTenant, createUserWithRole, PASSWORD, type Tenant } from './helpers.js';

// Time is controlled so codes (which change every 30 seconds and can never be used twice) are deterministic:
// every scenario starts at the real time and moves forward one 30-second step whenever it needs a fresh code.
const realNow = Date.now.bind(Date);
const STEP_MS = 30_000;
const tick = (steps = 1) => vi.setSystemTime(Date.now() + steps * STEP_MS);
const codeFor = (secret: string) => totpAt(secret, Date.now());
const wrongCodeFor = (secret: string) => {
  const valid = new Set([-1, 0, 1].map((n) => totpAt(secret, Date.now() + n * STEP_MS)));
  return valid.has('000000') ? '999999' : '000000';
};

let t: Tenant;
let owner: ReturnType<typeof authed>;

beforeAll(async () => {
  t = await createTenant('mfa');
  owner = authed(t.owner.token);
  vi.useFakeTimers({ toFake: ['Date'] });
});
beforeEach(() => vi.setSystemTime(realNow()));
afterAll(() => vi.useRealTimers());

async function newManager(tenant = t) {
  return createUserWithRole(tenant, 'branch_manager');
}

/** Runs the two set-up steps for a signed-in user and returns the secret and recovery codes. */
async function enrol(token: string) {
  const setup = await authed(token).post('/auth/mfa/setup').send({});
  expect(setup.status).toBe(200);
  const secret = setup.body.data.secret as string;
  const enable = await authed(token).post('/auth/mfa/enable').send({ code: codeFor(secret) });
  expect(enable.status).toBe(200);
  return { secret, recoveryCodes: enable.body.data.recoveryCodes as string[] };
}

const startLogin = (email: string, password = PASSWORD) => api().post('/api/v1/auth/login').send({ identifier: email, password });
const finishLogin = (mfaToken: string, code: string) => api().post('/api/v1/auth/login/mfa').send({ mfaToken, code });

async function challengeFor(email: string): Promise<string> {
  const res = await startLogin(email);
  expect(res.status).toBe(200);
  expect(res.body.data.mfaRequired).toBe(true);
  return res.body.data.mfaToken as string;
}

const auditActions = (userId: string) =>
  withSystem((tx) => tx.selectFrom('auditLogs').select(['action', 'summary']).where('entityId', '=', userId).execute());

describe('setting up two-step sign-in', () => {
  it('shows the key first and switches nothing on until the app produces a correct code', async () => {
    const mgr = await newManager();
    const me = authed(mgr.token);
    expect((await me.get('/auth/mfa')).body.data).toEqual({ enabled: false, required: false, setupRequired: false, recoveryCodesLeft: 0 });

    const setup = await me.post('/auth/mfa/setup').send({});
    expect(setup.status).toBe(200);
    const { secret, otpauthUrl } = setup.body.data;
    expect(secret).toMatch(/^[A-Z2-7]{32}$/);
    expect(otpauthUrl).toMatch(/^otpauth:\/\/totp\//);
    expect(otpauthUrl).toContain(`secret=${secret}`);
    expect(otpauthUrl).toContain(encodeURIComponent(mgr.email));

    // Still just a password.
    expect((await startLogin(mgr.email)).body.data.accessToken).toBeTruthy();

    const wrong = await me.post('/auth/mfa/enable').send({ code: wrongCodeFor(secret) });
    expect(wrong.status).toBe(400);
    expect(wrong.body.errorCode).toBe('INVALID_MFA_CODE');
    expect((await me.get('/auth/mfa')).body.data.enabled).toBe(false);

    const enable = await me.post('/auth/mfa/enable').send({ code: codeFor(secret) });
    expect(enable.status).toBe(200);
    const codes: string[] = enable.body.data.recoveryCodes;
    expect(codes).toHaveLength(10);
    expect(new Set(codes).size).toBe(10);
    for (const code of codes) expect(code).toMatch(/^[A-HJ-NP-Z2-9]{5}-[A-HJ-NP-Z2-9]{5}$/);
    expect((await me.get('/auth/mfa')).body.data).toEqual({ enabled: true, required: false, setupRequired: false, recoveryCodesLeft: 10 });

    expect((await me.post('/auth/mfa/setup').send({})).status).toBe(409);
    expect((await me.post('/auth/mfa/enable').send({ code: codeFor(secret) })).status).toBe(409);
    expect((await auditActions(mgr.id)).map((a) => a.action)).toContain('auth.mfa_enabled');
  });

  it('stores the secret encrypted and the recovery codes only as hashes', async () => {
    const mgr = await newManager();
    const { secret, recoveryCodes } = await enrol(mgr.token);
    const row = await withSystem((tx) => tx.selectFrom('users').select(['totpSecretEnc', 'totpPendingSecretEnc', 'totpEnabledAt']).where('id', '=', mgr.id).executeTakeFirstOrThrow());
    expect(row.totpEnabledAt).not.toBeNull();
    expect(row.totpPendingSecretEnc).toBeNull();
    expect(row.totpSecretEnc).toMatch(/^v1\./);
    expect(row.totpSecretEnc).not.toContain(secret);
    const hashes = await withSystem((tx) => tx.selectFrom('userRecoveryCodes').select('codeHash').where('userId', '=', mgr.id).execute());
    expect(hashes).toHaveLength(10);
    for (const { codeHash } of hashes) {
      expect(codeHash).toMatch(/^\$argon2id\$/);
      for (const code of recoveryCodes) expect(codeHash).not.toContain(code.replace('-', ''));
    }
  });

  it('refuses to start a second set-up while a key is switched on, and the status needs a signed-in user', async () => {
    expect((await api().get('/api/v1/auth/mfa')).status).toBe(401);
    expect((await api().post('/api/v1/auth/mfa/setup').send({})).status).toBe(401);
  });
});

describe('signing in with a code', () => {
  it('asks for the code after the password, and only a correct code produces a session', async () => {
    const mgr = await newManager();
    const { secret } = await enrol(mgr.token);
    tick(); // the set-up used this step's code; a code is accepted only once

    const first = await startLogin(mgr.email);
    expect(first.status).toBe(200);
    expect(first.body.data).toMatchObject({ mfaRequired: true, expiresIn: 300 });
    expect(first.body.data.accessToken).toBeUndefined();
    expect(first.headers['set-cookie']).toBeUndefined();
    const mfaToken = first.body.data.mfaToken as string;

    const wrong = await finishLogin(mfaToken, wrongCodeFor(secret));
    expect(wrong.status).toBe(401);
    expect(wrong.body.errorCode).toBe('INVALID_MFA_CODE');
    expect(wrong.headers['set-cookie']).toBeUndefined();

    const code = codeFor(secret);
    const done = await finishLogin(mfaToken, code);
    expect(done.status).toBe(200);
    expect(done.body.data.user.twoFactor).toMatchObject({ enabled: true, recoveryCodesLeft: 10 });
    expect(String(done.headers['set-cookie'])).toContain('salon_rt=');
    expect((await authed(done.body.data.accessToken).get('/auth/me')).status).toBe(200);

    // The same code cannot be used again, even with a brand new challenge.
    const replay = await finishLogin(await challengeFor(mgr.email), code);
    expect(replay.status).toBe(401);
    expect(replay.body.errorCode).toBe('INVALID_MFA_CODE');

    // The next code works.
    tick();
    const next = await finishLogin(await challengeFor(mgr.email), codeFor(secret));
    expect(next.status).toBe(200);
    expect((await auditActions(mgr.id)).some((a) => a.summary === 'Signed in with two-step verification')).toBe(true);
  });

  it('accepts a code typed the way authenticator apps show it, with a space in the middle', async () => {
    const mgr = await newManager();
    const { secret } = await enrol(mgr.token);
    tick();
    const code = codeFor(secret);
    const res = await finishLogin(await challengeFor(mgr.email), `${code.slice(0, 3)} ${code.slice(3)}`);
    expect(res.status).toBe(200);
  });

  it('does not let the short-lived challenge stand in for a session, or a session for a challenge', async () => {
    const mgr = await newManager();
    const { secret } = await enrol(mgr.token);
    tick();
    const mfaToken = await challengeFor(mgr.email);
    expect((await authed(mfaToken).get('/auth/me')).status).toBe(401);
    // An access token is not accepted as the proof either.
    const asChallenge = await finishLogin(mgr.token, codeFor(secret));
    expect(asChallenge.status).toBe(401);
    expect(asChallenge.body.errorCode).toBe('SESSION_EXPIRED');
    expect((await finishLogin('x'.repeat(40), codeFor(secret))).status).toBe(401);
  });

  it('lets the challenge expire after five minutes', async () => {
    const mgr = await newManager();
    const { secret } = await enrol(mgr.token);
    tick();
    const mfaToken = await challengeFor(mgr.email);
    vi.setSystemTime(Date.now() + 6 * 60_000);
    const late = await finishLogin(mfaToken, codeFor(secret));
    expect(late.status).toBe(401);
    expect(late.body.errorCode).toBe('SESSION_EXPIRED');
  });

  it('answers a wrong password exactly as it does for an account without two-step sign-in', async () => {
    const mgr = await newManager();
    await enrol(mgr.token);
    const plain = await createUserWithRole(t, 'receptionist');
    const a = await startLogin(mgr.email, 'WrongPass99999');
    const b = await startLogin(plain.email, 'WrongPass99999');
    expect(a.status).toBe(401);
    expect(a.body).toMatchObject({ errorCode: 'INVALID_CREDENTIALS', message: b.body.message });
    expect(b.body.errorCode).toBe('INVALID_CREDENTIALS');
  });
});

describe('guessing the code', () => {
  it('locks the account after repeated wrong codes, and a correct password does not reset the count', async () => {
    const mgr = await newManager();
    const { secret } = await enrol(mgr.token);
    tick();
    const max = env.LOGIN_MAX_ATTEMPTS;

    const mfaToken = await challengeFor(mgr.email);
    for (let i = 0; i < max - 2; i += 1) expect((await finishLogin(mfaToken, wrongCodeFor(secret))).body.errorCode).toBe('INVALID_MFA_CODE');
    // Starting over with the password does not give a fresh set of tries…
    const again = await challengeFor(mgr.email);
    expect((await finishLogin(again, wrongCodeFor(secret))).body.errorCode).toBe('INVALID_MFA_CODE');
    // …so the next wrong code is the one that locks the account.
    const locking = await finishLogin(again, wrongCodeFor(secret));
    expect(locking.status).toBe(423);
    expect(locking.body.errorCode).toBe('ACCOUNT_LOCKED');

    // Locked means locked, even for the right code and the right password.
    expect((await finishLogin(again, codeFor(secret))).status).toBe(423);
    expect((await startLogin(mgr.email)).status).toBe(423);
    expect((await auditActions(mgr.id)).map((a) => a.action)).toEqual(expect.arrayContaining(['auth.mfa_failed', 'auth.locked']));

    // The lock expires on its own.
    vi.setSystemTime(Date.now() + (env.LOGIN_LOCK_MINUTES + 1) * 60_000);
    const ok = await finishLogin(await challengeFor(mgr.email), codeFor(secret));
    expect(ok.status).toBe(200);
  });

  it('resets the count once the second step succeeds', async () => {
    const mgr = await newManager();
    const { secret } = await enrol(mgr.token);
    tick();
    const mfaToken = await challengeFor(mgr.email);
    for (let i = 0; i < env.LOGIN_MAX_ATTEMPTS - 1; i += 1) await finishLogin(mfaToken, wrongCodeFor(secret));
    expect((await finishLogin(mfaToken, codeFor(secret))).status).toBe(200);
    // A full set of tries is available again.
    for (let i = 0; i < env.LOGIN_MAX_ATTEMPTS - 1; i += 1) {
      expect((await finishLogin(await challengeFor(mgr.email), wrongCodeFor(secret))).body.errorCode).toBe('INVALID_MFA_CODE');
    }
  });
});

describe('recovery codes', () => {
  it('sign in once each, whatever the capitalisation or dash, and are counted', async () => {
    const mgr = await newManager();
    const { recoveryCodes } = await enrol(mgr.token);

    const typed = recoveryCodes[0]!.toLowerCase().replace('-', ' ');
    const used = await finishLogin(await challengeFor(mgr.email), typed);
    expect(used.status).toBe(200);
    expect(used.body.data.user.twoFactor.recoveryCodesLeft).toBe(9);
    expect((await auditActions(mgr.id)).some((a) => a.summary === 'Signed in with a recovery code')).toBe(true);

    const reused = await finishLogin(await challengeFor(mgr.email), recoveryCodes[0]!);
    expect(reused.status).toBe(401);
    expect(reused.body.errorCode).toBe('INVALID_MFA_CODE');

    const other = await finishLogin(await challengeFor(mgr.email), recoveryCodes[1]!);
    expect(other.status).toBe(200);
    expect(other.body.data.user.twoFactor.recoveryCodesLeft).toBe(8);
  });

  it('are replaced, not added to, when new ones are made, and need the password and a code', async () => {
    const mgr = await newManager();
    const me = authed(mgr.token);
    const { secret, recoveryCodes: old } = await enrol(mgr.token);
    tick();

    const badPassword = await me.post('/auth/mfa/recovery-codes').send({ password: 'WrongPass99999', code: codeFor(secret) });
    expect(badPassword.status).toBe(400);
    expect(badPassword.body.details.issues[0].path).toBe('password');
    const badCode = await me.post('/auth/mfa/recovery-codes').send({ password: PASSWORD, code: wrongCodeFor(secret) });
    expect(badCode.status).toBe(400);
    expect(badCode.body.errorCode).toBe('INVALID_MFA_CODE');

    const fresh = await me.post('/auth/mfa/recovery-codes').send({ password: PASSWORD, code: codeFor(secret) });
    expect(fresh.status).toBe(200);
    const codes: string[] = fresh.body.data.recoveryCodes;
    expect(codes).toHaveLength(10);
    expect(codes.filter((c) => old.includes(c))).toEqual([]);
    expect((await me.get('/auth/mfa')).body.data.recoveryCodesLeft).toBe(10);

    expect((await finishLogin(await challengeFor(mgr.email), old[0]!)).status).toBe(401);
    expect((await finishLogin(await challengeFor(mgr.email), codes[0]!)).status).toBe(200);
  });
});

describe('switching it off', () => {
  it('needs the password and a code, then goes back to a plain password sign-in', async () => {
    const mgr = await newManager();
    const me = authed(mgr.token);
    const { secret } = await enrol(mgr.token);
    tick();

    expect((await me.post('/auth/mfa/disable').send({ password: 'WrongPass99999', code: codeFor(secret) })).status).toBe(400);
    expect((await me.post('/auth/mfa/disable').send({ password: PASSWORD, code: wrongCodeFor(secret) })).body.errorCode).toBe('INVALID_MFA_CODE');
    expect((await me.get('/auth/mfa')).body.data.enabled).toBe(true);

    expect((await me.post('/auth/mfa/disable').send({ password: PASSWORD, code: codeFor(secret) })).status).toBe(204);
    expect((await me.get('/auth/mfa')).body.data).toEqual({ enabled: false, required: false, setupRequired: false, recoveryCodesLeft: 0 });
    expect((await startLogin(mgr.email)).body.data.accessToken).toBeTruthy();

    const row = await withSystem((tx) => tx.selectFrom('users').select(['totpSecretEnc', 'totpEnabledAt', 'totpLastStep']).where('id', '=', mgr.id).executeTakeFirstOrThrow());
    expect(row).toEqual({ totpSecretEnc: null, totpEnabledAt: null, totpLastStep: null });
    expect(await withSystem((tx) => tx.selectFrom('userRecoveryCodes').select('id').where('userId', '=', mgr.id).execute())).toEqual([]);
    expect((await auditActions(mgr.id)).map((a) => a.action)).toContain('auth.mfa_disabled');

    // Not switched on any more, so there is nothing to switch off.
    expect((await me.post('/auth/mfa/disable').send({ password: PASSWORD, code: '123456' })).status).toBe(409);
  });

  it('counts wrong codes here toward the same lock-out', async () => {
    const mgr = await newManager();
    const me = authed(mgr.token);
    const { secret } = await enrol(mgr.token);
    tick();
    for (let i = 0; i < env.LOGIN_MAX_ATTEMPTS - 1; i += 1) expect((await me.post('/auth/mfa/disable').send({ password: PASSWORD, code: wrongCodeFor(secret) })).status).toBe(400);
    expect((await me.post('/auth/mfa/disable').send({ password: PASSWORD, code: wrongCodeFor(secret) })).status).toBe(400);
    const locked = await me.post('/auth/mfa/disable').send({ password: PASSWORD, code: codeFor(secret) });
    expect(locked.status).toBe(423);
    expect((await me.get('/auth/mfa')).body.data.enabled).toBe(true);
  });
});

describe('the salon policy', () => {
  it('lets only an owner choose who must use it, and holds required people to the set-up screen until they finish', async () => {
    const p = await createTenant('mfapol');
    const boss = authed(p.owner.token);
    const manager = await createUserWithRole(p, 'branch_manager');
    const desk = await createUserWithRole(p, 'receptionist');

    // Someone who can change settings but is not an owner cannot change the policy.
    const role = await boss.post('/roles').send({ name: 'Settings admin', homeScreen: 'owner_dashboard', permissions: ['settings.manage', 'users.manage'] });
    expect(role.status).toBe(201);
    const admin = await boss.post('/users').send({ fullName: 'Settings Admin', email: `admin-${p.code}@test.example`, roleId: role.body.data.id, password: PASSWORD, allBranches: true, branchIds: [] });
    expect(admin.status).toBe(201);
    const adminToken = (await startLogin(`admin-${p.code}@test.example`)).body.data.accessToken as string;
    const denied = await authed(adminToken).patch('/organization/settings').send({ twoFactorRequirement: 'owners' });
    expect(denied.status).toBe(403);
    expect(denied.body.message).toMatch(/Only an owner/);
    expect((await authed(adminToken).patch('/organization/settings').send({ staffCanViewCustomerPhone: true })).status).toBe(200);

    expect((await authed(manager.token).get('/customers')).status).toBe(200);
    const set = await boss.patch('/organization/settings').send({ twoFactorRequirement: 'owners_and_managers' });
    expect(set.status).toBe(200);
    expect(set.body.data.twoFactorRequirement).toBe('owners_and_managers');

    // Owners and managers are held at the set-up screen straight away; the front desk is not affected.
    for (const token of [p.owner.token, manager.token, adminToken]) {
      const blocked = await authed(token).get('/customers');
      expect(blocked.status).toBe(403);
      expect(blocked.body.errorCode).toBe('MFA_SETUP_REQUIRED');
      const me = await authed(token).get('/auth/me');
      expect(me.status).toBe(200);
      expect(me.body.data.twoFactor).toEqual({ enabled: false, required: true, setupRequired: true, recoveryCodesLeft: 0 });
    }
    expect((await authed(desk.token).get('/customers')).status).toBe(200);
    expect((await authed(desk.token).get('/auth/mfa')).body.data.required).toBe(false);

    // Changing their own password still works while they are held at set-up.
    const changed = await authed(manager.token).post('/auth/change-password').send({ currentPassword: PASSWORD, newPassword: 'NewTestPass12345' });
    expect(changed.status).toBe(204);

    // Finishing the set-up releases them, with no new sign-in.
    const { secret } = await enrol(manager.token);
    expect((await authed(manager.token).get('/customers')).status).toBe(200);
    expect((await authed(manager.token).get('/auth/mfa')).body.data).toEqual({ enabled: true, required: true, setupRequired: false, recoveryCodesLeft: 10 });

    // Required means it cannot be switched off by the person themselves.
    tick();
    const off = await authed(manager.token).post('/auth/mfa/disable').send({ password: 'NewTestPass12345', code: codeFor(secret) });
    expect(off.status).toBe(403);
    expect(off.body.errorCode).toBe('MFA_REQUIRED_BY_POLICY');

    // The owner enrols, then relaxes the policy to owners only: managers are no longer held.
    await enrol(p.owner.token);
    expect((await boss.patch('/organization/settings').send({ twoFactorRequirement: 'owners' })).status).toBe(200);
    expect((await authed(adminToken).get('/auth/mfa')).body.data).toMatchObject({ required: false, setupRequired: false });
    expect((await authed(adminToken).get('/organization/settings')).status).toBe(200);

    // Off again: an enrolled manager keeps their own protection but is no longer required to have it.
    expect((await boss.patch('/organization/settings').send({ twoFactorRequirement: 'off' })).status).toBe(200);
    expect((await authed(manager.token).get('/auth/mfa')).body.data).toMatchObject({ enabled: true, required: false });
  });
});

describe('resetting someone else', () => {
  it('lets an owner switch off a colleague who lost their phone and recovery codes, and signs their devices out', async () => {
    const mgr = await newManager();
    await enrol(mgr.token);
    tick();

    const listed = await owner.get('/users?pageSize=100');
    expect(listed.body.data.find((u: { id: string }) => u.id === mgr.id).twoFactorEnabled).toBe(true);
    expect(listed.body.data.find((u: { id: string }) => u.id === t.owner.id).twoFactorEnabled).toBe(false);
    expect((await owner.get(`/users/${mgr.id}`)).body.data.twoFactorEnabled).toBe(true);
    expect(JSON.stringify(listed.body)).not.toMatch(/totp|codeHash/i);

    const reset = await owner.post(`/users/${mgr.id}/reset-two-factor`).send({});
    expect(reset.status).toBe(204);
    expect((await owner.get(`/users/${mgr.id}`)).body.data.twoFactorEnabled).toBe(false);
    expect((await startLogin(mgr.email)).body.data.accessToken).toBeTruthy();
    expect(await withSystem((tx) => tx.selectFrom('userRecoveryCodes').select('id').where('userId', '=', mgr.id).execute())).toEqual([]);
    const audited = await auditActions(mgr.id);
    expect(audited.map((a) => a.action)).toContain('user.two_factor_reset');
    const sessions = await withSystem((tx) => tx.selectFrom('refreshTokens').select('revokedReason').where('userId', '=', mgr.id).execute());
    expect(sessions.some((s) => s.revokedReason === 'two_factor_reset')).toBe(true);

    expect((await owner.post(`/users/${mgr.id}/reset-two-factor`).send({})).status).toBe(409);
  });

  it('refuses to reset your own, an owner by a non-owner, someone without access to users, or someone from another salon', async () => {
    const mgr = await newManager();
    const { secret } = await enrol(mgr.token);
    tick();
    expect((await owner.post(`/users/${t.owner.id}/reset-two-factor`).send({})).status).toBe(400);

    const role = await owner.post('/roles').send({ name: 'People admin', homeScreen: 'owner_dashboard', permissions: ['users.manage'] });
    const email = `people-${t.code}@test.example`;
    const created = await owner.post('/users').send({ fullName: 'People Admin', email, roleId: role.body.data.id, password: PASSWORD, allBranches: true, branchIds: [] });
    expect(created.status).toBe(201);
    const peopleAdmin = authed((await startLogin(email)).body.data.accessToken);
    const onOwner = await peopleAdmin.post(`/users/${t.owner.id}/reset-two-factor`).send({});
    expect(onOwner.status).toBe(403);
    expect(onOwner.body.message).toMatch(/Only an owner/);
    // …but may reset a colleague who is not an owner.
    const colleague = await newManager();
    await enrol(colleague.token);
    expect((await peopleAdmin.post(`/users/${colleague.id}/reset-two-factor`).send({})).status).toBe(204);
    expect((await owner.get(`/users/${colleague.id}`)).body.data.twoFactorEnabled).toBe(false);

    const desk = await createUserWithRole(t, 'receptionist');
    expect((await authed(desk.token).post(`/users/${mgr.id}/reset-two-factor`).send({})).status).toBe(403);

    const other = await createTenant('mfaiso');
    expect((await owner.post(`/users/${other.owner.id}/reset-two-factor`).send({})).status).toBe(404);
    expect((await authed(other.owner.token).post(`/users/${mgr.id}/reset-two-factor`).send({})).status).toBe(404);
    // Nothing changed for the manager.
    expect((await finishLogin(await challengeFor(mgr.email), codeFor(secret))).status).toBe(200);
  });
});
