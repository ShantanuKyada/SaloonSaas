import { randomUUID } from 'node:crypto';
import { DateTime } from 'luxon';
import request from 'supertest';
import { createApp } from '../src/app.js';
import { hashPassword } from '../src/core/passwords.js';
import { withSystem } from '../src/db/tenant.js';
import { provisionOrganization } from '../src/modules/organizations/provision.js';
import { systemContext } from '../src/core/auth-context.js';

export const app = createApp();
export const api = () => request(app);

export const PASSWORD = 'TestPass12345';
export const TZ = 'Asia/Kolkata';

export interface Tenant {
  orgId: string;
  code: string;
  branchId: string;
  roleIds: Record<string, string>;
  owner: { id: string; token: string; email: string };
}

export async function login(identifier: string, password = PASSWORD): Promise<string> {
  const res = await api().post('/api/v1/auth/login').send({ identifier, password });
  if (res.status !== 200) throw new Error(`login failed for ${identifier}: ${res.status} ${JSON.stringify(res.body)}`);
  return res.body.data.accessToken as string;
}

/** Creates an isolated salon organization with an owner, one branch and starter data. */
export async function createTenant(label = 'T'): Promise<Tenant> {
  const code = `${label.toLowerCase()}-${randomUUID().slice(0, 8)}`;
  const email = `owner-${code}@test.example`;
  const result = await withSystem((tx) =>
    provisionOrganization(
      tx,
      {
        name: `Salon ${code}`,
        code,
        country: 'IN',
        currency: 'INR',
        timezone: TZ,
        subscriptionPlan: 'trial',
        legalName: null,
        contactPerson: null,
        email: null,
        phone: null,
        taxId: null,
        maxBranches: null,
        owner: { fullName: 'Test Owner', email, phone: null, password: PASSWORD },
        firstBranch: { name: 'Main Branch', code: 'MAIN', city: 'Rajkot' },
      },
      systemContext(null),
    ),
  );
  const token = await login(email);
  return { orgId: result.organizationId, code, branchId: result.branchId, roleIds: result.roleIds, owner: { id: result.ownerUserId, token, email } };
}

export const authed = (token: string) => ({
  get: (url: string) => api().get(`/api/v1${url}`).set('Authorization', `Bearer ${token}`),
  post: (url: string) => api().post(`/api/v1${url}`).set('Authorization', `Bearer ${token}`),
  put: (url: string) => api().put(`/api/v1${url}`).set('Authorization', `Bearer ${token}`),
  patch: (url: string) => api().patch(`/api/v1${url}`).set('Authorization', `Bearer ${token}`),
  delete: (url: string) => api().delete(`/api/v1${url}`).set('Authorization', `Bearer ${token}`),
});

export async function createBranch(t: Tenant, name: string, code: string): Promise<string> {
  const res = await authed(t.owner.token).post('/branches').send({ name, code, timezone: TZ, city: 'Ahmedabad' });
  if (res.status !== 201) throw new Error(`branch: ${JSON.stringify(res.body)}`);
  return res.body.data.id;
}

export async function createUserWithRole(t: Tenant, roleKey: string, opts: { branchIds?: string[]; allBranches?: boolean; name?: string } = {}) {
  const email = `${roleKey}-${randomUUID().slice(0, 8)}@test.example`;
  const res = await authed(t.owner.token)
    .post('/users')
    .send({ fullName: opts.name ?? `${roleKey} user`, email, roleId: t.roleIds[roleKey], password: PASSWORD, allBranches: opts.allBranches ?? false, branchIds: opts.branchIds ?? [t.branchId] });
  if (res.status !== 201) throw new Error(`user: ${JSON.stringify(res.body)}`);
  return { id: res.body.data.id as string, email, token: await login(email) };
}

export async function createService(t: Tenant, data: { name: string; code: string; price: number; durationMinutes: number; categoryName?: string; bufferMinutes?: number }): Promise<string> {
  const o = authed(t.owner.token);
  const cats = await o.get('/service-categories');
  const category = cats.body.data.find((c: { name: string }) => c.name === (data.categoryName ?? 'Hair'));
  const res = await o.post('/services').send({ categoryId: category.id, code: data.code, name: data.name, price: data.price, durationMinutes: data.durationMinutes, bufferMinutes: data.bufferMinutes ?? 0 });
  if (res.status !== 201) throw new Error(`service: ${JSON.stringify(res.body)}`);
  return res.body.data.id;
}

export async function createStaff(t: Tenant, name: string, code: string, serviceIds: string[], branchId = t.branchId): Promise<string> {
  const o = authed(t.owner.token);
  const res = await o.post('/staff').send({ branchId, employeeCode: code, fullName: name, displayName: name.split(' ')[0] });
  if (res.status !== 201) throw new Error(`staff: ${JSON.stringify(res.body)}`);
  const id = res.body.data.id as string;
  const map = await o.put(`/staff/${id}/services`).send({ services: serviceIds.map((serviceId) => ({ serviceId, isActive: true })) });
  if (map.status !== 200) throw new Error(`staff services: ${JSON.stringify(map.body)}`);
  return id;
}

export async function createCustomer(t: Tenant, name: string, mobile?: string): Promise<string> {
  const res = await authed(t.owner.token).post('/customers').send({ fullName: name, mobile: mobile ?? `9${Math.floor(100000000 + Math.random() * 899999999)}` });
  if (res.status !== 201) throw new Error(`customer: ${JSON.stringify(res.body)}`);
  return res.body.data.id;
}

/** A local date some days ahead (so bookings are never "in the past"), in the branch time zone. */
export function futureDate(daysAhead = 3): string {
  return DateTime.now().setZone(TZ).plus({ days: daysAhead }).toISODate()!;
}

export function at(date: string, time: string): string {
  return DateTime.fromISO(`${date}T${time}`, { zone: TZ }).toUTC().toISO()!;
}

export { hashPassword };
