import { createHmac } from 'node:crypto';
import { expect, type APIRequestContext, type Page } from '@playwright/test';

// Demo logins created by `npm run db:seed` (see apps/api/src/seed/data.ts).
export const DEMO_PASSWORD = 'Welcome@2026';
export const USERS = {
  owner: 'owner@glow.test',
  rajkotManager: 'manager.rajkot@glow.test',
  rajkotReception: 'reception.rajkot@glow.test',
  ahmedabadReception: 'reception.ahmedabad@glow.test',
  stylist: 'rahul@glow.test',
  platform: 'admin@salonos.test',
} as const;

const CSRF = { 'X-Requested-With': 'salonos' };

/** Signs in through the API so the browser context holds the refresh cookie; the app then opens already signed in. */
export async function signInAs(page: Page, email: string, path = '/'): Promise<void> {
  const res = await page.request.post('/api/v1/auth/login', { data: { identifier: email, password: DEMO_PASSWORD }, headers: CSRF });
  expect(res.ok(), `login as ${email}`).toBeTruthy();
  await page.goto(path);
}

export interface Api {
  get<T = any>(path: string, query?: Record<string, string | number | undefined>): Promise<T>;
  post<T = any>(path: string, data?: unknown): Promise<T>;
  put<T = any>(path: string, data?: unknown): Promise<T>;
  patch<T = any>(path: string, data?: unknown): Promise<T>;
}

/** A tiny authenticated API client used to arrange test data quickly (the behaviour under test still goes through the UI). */
export async function apiAs(request: APIRequestContext, email: string): Promise<Api> {
  return apiWith(request, email, DEMO_PASSWORD);
}

/** Same as `apiAs` for accounts that do not use the demo password (salons created by a test). */
export async function apiWith(request: APIRequestContext, email: string, password: string): Promise<Api> {
  const res = await request.post('/api/v1/auth/login', { data: { identifier: email, password }, headers: CSRF });
  expect(res.ok(), `api login as ${email}`).toBeTruthy();
  const login = (await res.json()).data;
  expect(login.mfaRequired, `${email} should not need a code here`).toBeUndefined();
  const token = login.accessToken as string;
  const headers = { Authorization: `Bearer ${token}`, ...CSRF };
  const call = async (method: 'GET' | 'POST' | 'PUT' | 'PATCH', path: string, data?: unknown, query?: Record<string, string | number | undefined>) => {
    const params = Object.fromEntries(Object.entries(query ?? {}).filter(([, v]) => v !== undefined)) as Record<string, string | number>;
    const r = await request.fetch(`/api/v1${path}`, { method, headers, data: data === undefined ? undefined : data, params });
    if (r.status() === 204) return undefined;
    const body = await r.json();
    if (!r.ok()) throw new Error(`${method} ${path} → ${r.status()} ${body.errorCode}: ${body.message}`);
    return body.data;
  };
  return {
    get: (path, query) => call('GET', path, undefined, query),
    post: (path, data) => call('POST', path, data ?? {}),
    put: (path, data) => call('PUT', path, data ?? {}),
    patch: (path, data) => call('PATCH', path, data ?? {}),
  };
}

let counter = 0;
/** A unique, valid Indian mobile number per call so re-runs never collide with earlier test data. */
export function uniqueMobile(): string {
  counter += 1;
  const n = (Date.now() % 100_000_000) * 10 + (counter % 10);
  return `9${String(n).padStart(9, '0').slice(-9)}`;
}

export const uniqueName = (prefix: string) => `${prefix} ${Math.random().toString(36).slice(2, 7).toUpperCase()}`;

/** YYYY-MM-DD, `days` from today in the salon's time zone (Asia/Kolkata). */
export function dateInDays(days: number): string {
  const d = new Date(Date.now() + days * 86_400_000);
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata' }).format(d);
}

/** A date well in the future, varied per run so repeated runs do not fight over the same slots. */
export const farDate = (min = 7, spread = 70) => dateInDays(min + Math.floor(Math.random() * spread));

export interface Arranged {
  branchId: string;
  customerId: string;
  customerName: string;
  appointmentId: string;
  serviceId: string;
  staffId: string;
  startAt: string;
}

/** Creates a customer and a booked appointment through the API (fast set-up for tests that exercise later steps in the UI). */
export async function arrangeBooking(api: Api, opts: { branchName: string; serviceName: string; date?: string; namePrefix?: string }): Promise<Arranged> {
  const branches = await api.get<Array<{ id: string; name: string }>>('/branches');
  const branch = branches.find((b) => b.name === opts.branchName);
  if (!branch) throw new Error(`Branch ${opts.branchName} not found`);
  const services = await api.get<Array<{ id: string; name: string }>>('/services', { branchId: branch.id });
  const service = services.find((s) => s.name === opts.serviceName);
  if (!service) throw new Error(`Service ${opts.serviceName} not found`);
  const customerName = uniqueName(opts.namePrefix ?? 'E2E Customer');
  const customer = await api.post<{ id: string }>('/customers', { fullName: customerName, mobile: uniqueMobile(), marketingConsent: false });

  for (let attempt = 0; attempt < 12; attempt += 1) {
    const date = opts.date && attempt === 0 ? opts.date : farDate();
    const availability = await api.get<{ slots: Array<{ startAt: string; staffIds: string[] }> }>('/scheduling/availability', { branchId: branch.id, date, serviceIds: service.id });
    const slot = availability.slots[0];
    if (!slot) continue;
    const appointment = await api.post<{ id: string }>('/appointments', {
      branchId: branch.id,
      customerId: customer.id,
      source: 'phone',
      status: 'scheduled',
      items: [{ serviceId: service.id, staffId: slot.staffIds[0], startAt: slot.startAt }],
      notifyCustomer: false,
      allowOutsideHours: false,
    });
    return { branchId: branch.id, customerId: customer.id, customerName, appointmentId: appointment.id, serviceId: service.id, staffId: slot.staffIds[0]!, startAt: slot.startAt };
  }
  throw new Error('Could not find a free slot for the test booking');
}

// ───────────── Two-step sign-in ─────────────
const BASE32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

/** The 6-digit code an authenticator app shows for `secret` (RFC 6238: HMAC-SHA1, 30-second steps) at `atMs`. */
export function totp(secret: string, atMs = Date.now()): string {
  let bits = 0;
  let value = 0;
  const key: number[] = [];
  for (const char of secret.replace(/[\s=-]/g, '').toUpperCase()) {
    value = (value << 5) | BASE32.indexOf(char);
    bits += 5;
    if (bits >= 8) {
      key.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  const message = Buffer.alloc(8);
  message.writeBigUInt64BE(BigInt(Math.floor(atMs / 30_000)));
  const digest = createHmac('sha1', Buffer.from(key)).update(message).digest();
  const offset = digest[digest.length - 1]! & 0x0f;
  const binary = ((digest[offset]! & 0x7f) << 24) | (digest[offset + 1]! << 16) | (digest[offset + 2]! << 8) | digest[offset + 3]!;
  return String(binary % 1_000_000).padStart(6, '0');
}

/**
 * The code for the next 30-second step. A code is accepted only once and only for a step newer than the last one used,
 * so right after set-up (which used this step's code) the next step's code is the one to type, with no waiting.
 */
export const nextTotp = (secret: string) => totp(secret, Date.now() + 30_000);

/** A code that is certainly wrong: it belongs to a step far outside the allowed clock drift. */
export const wrongTotp = (secret: string) => totp(secret, Date.now() + 10 * 30_000);

/** Turns two-step sign-in on for the signed-in API user without the screens. Returns what the screens would show. */
export async function enrolViaApi(api: Api): Promise<{ secret: string; recoveryCodes: string[] }> {
  const { secret } = await api.post<{ secret: string }>('/auth/mfa/setup');
  const { recoveryCodes } = await api.post<{ recoveryCodes: string[] }>('/auth/mfa/enable', { code: totp(secret) });
  return { secret, recoveryCodes };
}

export const SALON_PASSWORD = 'E2eSalon#2026';

export interface Salon {
  id: string;
  code: string;
  branchId: string;
  ownerEmail: string;
  /** Archives the salon so test salons do not pile up as active ones. */
  dispose: () => Promise<void>;
}

/**
 * A brand-new salon with its own owner (password SALON_PASSWORD), created by the platform administrator. Tests of
 * sign-in policy use one so they never change the demo salon the other tests share.
 */
export async function provisionSalon(request: APIRequestContext): Promise<Salon> {
  const platform = await apiAs(request, USERS.platform);
  const code = `e2e-${Math.random().toString(36).slice(2, 8)}`;
  const ownerEmail = `owner-${code}@e2e.test`;
  const created = await platform.post<{ organizationId: string; branchId: string }>('/platform/organizations', {
    name: `E2E Salon ${code}`,
    code,
    owner: { fullName: 'E2E Owner', email: ownerEmail, password: SALON_PASSWORD },
    firstBranch: { name: 'E2E Branch', code: 'E2E', city: 'Rajkot' },
  });
  return {
    id: created.organizationId,
    code,
    branchId: created.branchId,
    ownerEmail,
    dispose: async () => {
      await platform.patch(`/platform/organizations/${created.organizationId}`, { status: 'archived' });
    },
  };
}

/** Signs in through the form with any account (the page stops at the code step when two-step sign-in is on). */
export async function signInWith(page: Page, email: string, password: string): Promise<void> {
  await page.goto('/login');
  await page.getByLabel('Email or mobile number').fill(email);
  await page.getByLabel('Password', { exact: true }).fill(password);
  await page.getByRole('button', { name: 'Sign in' }).click();
}

export const MANAGER_PASSWORD = 'E2eManager#2026';

/** Adds a branch manager to a salon through the owner's API session, with their forced first password change already done. */
export async function addManager(request: APIRequestContext, owner: Api, salon: Salon): Promise<{ email: string; fullName: string }> {
  const roles = await owner.get<Array<{ id: string; key: string }>>('/roles');
  const role = roles.find((r) => r.key === 'branch_manager');
  if (!role) throw new Error('Branch Manager role not found');
  const email = `manager-${salon.code}@e2e.test`;
  const fullName = `Manager ${salon.code}`;
  await owner.post('/users', { fullName, email, roleId: role.id, password: SALON_PASSWORD, allBranches: false, branchIds: [salon.branchId] });
  const manager = await apiWith(request, email, SALON_PASSWORD);
  await manager.post('/auth/change-password', { currentPassword: SALON_PASSWORD, newPassword: MANAGER_PASSWORD });
  return { email, fullName };
}

/** Marks a team member created by a test as having left, so repeated runs do not fill the calendar with test staff. */
export async function retireStaff(api: Api, id: string): Promise<void> {
  const s = await api.get<Record<string, any>>(`/staff/${id}`);
  await api.put(`/staff/${id}`, {
    branchId: s.branchId, employeeCode: s.employeeCode, fullName: s.fullName, displayName: s.displayName, gender: s.gender, dateOfBirth: s.dateOfBirth, mobile: s.mobile, email: s.email, address: s.address,
    joiningDate: s.joiningDate, exitDate: s.exitDate, designation: s.designation, employmentType: s.employmentType, employmentStatus: 'terminated', biometricPunchId: s.biometricPunchId, photoUrl: s.photoUrl,
    calendarColor: s.calendarColor, calendarOrder: s.calendarOrder, isBookable: false, onlineBookable: false, commissionType: s.commissionType ?? 'none', commissionValue: s.commissionValue ?? 0, notes: s.notes,
    expertiseIds: (s.expertise as Array<{ id: string }>).map((e) => e.id),
  });
}
