import { changePasswordSchema, loginSchema, mfaConfirmSchema, mfaEnableSchema, mfaLoginSchema } from '@salon/shared';
import type { CookieOptions, Request, Response } from 'express';
import { rateLimit } from 'express-rate-limit';
import { cookieSecure, env, scaledLimit } from '../../config/env.js';
import { AppError } from '../../core/errors.js';
import { createRouter } from '../../core/router.js';
import { beginSetup, disableTwoFactor, enableTwoFactor, regenerateRecoveryCodes, twoFactorState } from './mfa.js';
import { buildSession, changePassword, login, loginWithMfa, logout, refresh, REFRESH_COOKIE, type ClientMeta } from './service.js';

const r = createRouter('/auth', 'Authentication');

const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: scaledLimit(20),
  standardHeaders: 'draft-8',
  legacyHeaders: false,
  handler: (_req, _res, next) =>
    next(new AppError(429, 'RATE_LIMITED', 'Too many sign-in attempts from this device. Please wait a few minutes.')),
});

// Changing two-step settings needs a code, so guessing is rate limited as well as counted toward the account lock-out.
const mfaSettingsLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: scaledLimit(10),
  standardHeaders: 'draft-8',
  legacyHeaders: false,
  handler: (_req, _res, next) => next(new AppError(429, 'RATE_LIMITED', 'Too many attempts. Please wait a few minutes.')),
});

const refreshLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: scaledLimit(60),
  standardHeaders: 'draft-8',
  legacyHeaders: false,
  handler: (_req, _res, next) => next(new AppError(429, 'RATE_LIMITED', 'Too many requests. Please wait a moment.')),
});

const cookieOptions: CookieOptions = {
  httpOnly: true,
  secure: cookieSecure,
  sameSite: 'strict',
  path: '/api/v1/auth',
  maxAge: env.REFRESH_TOKEN_TTL_DAYS * 24 * 60 * 60 * 1000,
};

function meta(req: Request): ClientMeta {
  return { ip: req.ip ?? null, userAgent: req.get('user-agent') ?? null, requestId: (req as Request & { requestId: string }).requestId };
}

/**
 * The refresh/logout endpoints are the only ones authenticated by cookie. Requiring a custom header means a
 * cross-site form or image cannot trigger them (browsers only send it after a CORS preflight we do not allow).
 */
function requireCsrfHeader(req: Request): void {
  if (req.get('x-requested-with') !== 'salonos') {
    throw new AppError(403, 'FORBIDDEN', 'Missing request header.');
  }
}

function setRefreshCookie(res: Response, token: string): void {
  res.cookie(REFRESH_COOKIE, token, cookieOptions);
}

r.post('/login', { summary: 'Sign in with email or mobile number', auth: 'public', body: loginSchema, status: 200, middleware: [loginLimiter] }, async ({ req, res, body }) => {
  const { response, refreshToken } = await login(body.identifier, body.password, meta(req));
  if (refreshToken) setRefreshCookie(res, refreshToken);
  return response;
});

r.post(
  '/login/mfa',
  {
    summary: 'Finish signing in with the code from your authenticator app (or a recovery code)',
    auth: 'public',
    body: mfaLoginSchema,
    status: 200,
    middleware: [loginLimiter],
  },
  async ({ req, res, body }) => {
    const { response, refreshToken } = await loginWithMfa(body.mfaToken, body.code, meta(req));
    setRefreshCookie(res, refreshToken);
    return response;
  },
);

r.post('/refresh', { summary: 'Exchange the refresh cookie for a new access token', auth: 'public', status: 200, middleware: [refreshLimiter] }, async ({ req, res }) => {
  requireCsrfHeader(req);
  const token = req.cookies?.[REFRESH_COOKIE] as string | undefined;
  if (!token) throw new AppError(401, 'SESSION_EXPIRED', 'Please sign in to continue.');
  try {
    const { response, refreshToken } = await refresh(token, meta(req));
    setRefreshCookie(res, refreshToken);
    return response;
  } catch (error) {
    res.clearCookie(REFRESH_COOKIE, { ...cookieOptions, maxAge: undefined });
    throw error;
  }
});

r.post('/logout', { summary: 'Sign out this device', auth: 'public', status: 204 }, async ({ req, res }) => {
  requireCsrfHeader(req);
  await logout(req.cookies?.[REFRESH_COOKIE] as string | undefined, meta(req));
  res.clearCookie(REFRESH_COOKIE, { ...cookieOptions, maxAge: undefined });
  return undefined;
});

r.get('/me', { summary: 'Current user, organization, branches and permissions', auth: 'any', allowUnenrolled: true }, async ({ auth }) => buildSession(auth.userId));

r.post('/change-password', { summary: 'Change own password', auth: 'any', allowUnenrolled: true, body: changePasswordSchema, status: 204 }, async ({ auth, body }) => {
  await changePassword(auth, body.currentPassword, body.newPassword);
  return undefined;
});

// ───────────── Two-step sign-in (authenticator app) ─────────────
// Reachable even while the salon requires two-step sign-in and it is not set up yet: that is how it gets set up.

r.get('/mfa', { summary: 'Two-step sign-in status for the signed-in user', auth: 'any', allowUnenrolled: true }, async ({ auth, tx }) =>
  tx((t) => twoFactorState(t, auth)),
);

r.post(
  '/mfa/setup',
  { summary: 'Start setting up two-step sign-in: returns the key and QR address for an authenticator app', auth: 'any', allowUnenrolled: true, status: 200 },
  async ({ auth }) => beginSetup(auth),
);

r.post(
  '/mfa/enable',
  { summary: 'Switch on two-step sign-in with the first code from the app; returns recovery codes (shown once)', auth: 'any', allowUnenrolled: true, body: mfaEnableSchema, status: 200 },
  async ({ auth, body }) => enableTwoFactor(auth, body.code),
);

r.post(
  '/mfa/disable',
  { summary: 'Switch off two-step sign-in (needs the password and a code)', auth: 'any', allowUnenrolled: true, body: mfaConfirmSchema, status: 204, middleware: [mfaSettingsLimiter] },
  async ({ auth, body }) => {
    await disableTwoFactor(auth, body);
    return undefined;
  },
);

r.post(
  '/mfa/recovery-codes',
  { summary: 'Make a new set of recovery codes (needs the password and a code); the old ones stop working', auth: 'any', allowUnenrolled: true, body: mfaConfirmSchema, status: 200, middleware: [mfaSettingsLimiter] },
  async ({ auth, body }) => regenerateRecoveryCodes(auth, body),
);

export const authRoutes = r;
