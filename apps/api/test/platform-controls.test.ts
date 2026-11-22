import { randomUUID } from 'node:crypto';
import { beforeAll, describe, expect, it } from 'vitest';
import { withSystem } from '../src/db/tenant.js';
import { hashPassword } from '../src/core/passwords.js';
import { api, at, authed, bookingDate, createBranch, createCustomer, createService, createStaff, createTenant, createUserWithRole, login, PASSWORD, type Tenant } from './helpers.js';

// The platform switches whole features on or off for a salon, and can open any salon in support mode.

let t: Tenant;
let other: Tenant;
let admin: ReturnType<typeof authed>;
let owner: ReturnType<typeof authed>;
let hairSpa: string;
let rahul: string;
let customerId: string;
const adminEmail = `admin-${randomUUID().slice(0, 6)}@platform.test`;

beforeAll(async () => {
  t = await createTenant('feat');
  other = await createTenant('feat2');
  owner = authed(t.owner.token);
  hairSpa = await createService(t, { name: 'Hair Spa', code: 'HSPA', price: 120000, durationMinutes: 60 });
  rahul = await createStaff(t, 'Rahul Shah', 'E001', [hairSpa]);
  customerId = await createCustomer(t, 'Meera Patel');
  await withSystem(async (tx) => tx.insertInto('users').values({ email: adminEmail, fullName: 'Platform Pat', passwordHash: await hashPassword(PASSWORD), isPlatformAdmin: true }).execute());
  admin = authed(await login(adminEmail));
});

const setFeatures = (disabledFeatures: string[]) => admin.patch(`/platform/organizations/${t.orgId}`).send({ disabledFeatures });

describe('features switched on or off per salon', () => {
  it('a switched-off feature closes its screens and API for everyone, owner included, and comes back when switched on', async () => {
    const manager = await createUserWithRole(t, 'branch_manager');
    expect((await owner.get('/reports')).status).toBe(200);
    expect((await setFeatures(['reports', 'packages'])).status).toBe(200);

    const me = (await owner.get('/auth/me')).body.data;
    expect(me.organization.disabledFeatures).toEqual(['packages', 'reports']);
    expect(me.permissions).not.toContain('reports.financial');
    expect(me.permissions).not.toContain('packages.manage');
    expect((await owner.get('/reports')).status).toBe(403);
    expect((await authed(manager.token).get('/reports')).status).toBe(403);
    expect((await owner.post('/packages').send({ code: 'P1', name: 'Combo', price: 1000, validityDays: 30, items: [{ serviceId: hairSpa, quantity: 1 }] })).status).toBe(403);
    // Selling a package on a bill is refused too.
    const sale = await owner.post('/billing/invoices').send({ branchId: t.branchId, customerId, lines: [{ type: 'package_sale', key: randomUUID(), packageId: randomUUID(), quantity: 1 }] });
    expect(sale.status).toBe(403);
    expect(sale.body.errorCode).toBe('FEATURE_OFF');

    // Another salon is untouched.
    expect((await authed(other.owner.token).get('/reports')).status).toBe(200);

    expect((await setFeatures([])).status).toBe(200);
    expect((await owner.get('/reports')).status).toBe(200);
  });

  it('switching off online booking closes the public booking page', async () => {
    await owner.patch('/organization/settings').send({ onlineBookingEnabled: true });
    expect((await api().get(`/api/v1/public/${t.code}`)).status).toBe(200);
    await setFeatures(['online_booking']);
    expect((await api().get(`/api/v1/public/${t.code}`)).status).toBe(404);
    await setFeatures([]);
    expect((await api().get(`/api/v1/public/${t.code}`)).status).toBe(200);
  });

  it('switching off offers stops them on bills', async () => {
    const offer = await owner.post('/offers').send({ code: 'TENOFF', name: 'Ten off', discountType: 'percentage', discountValue: 1000, validFrom: bookingDate(-30), validTo: bookingDate(30), autoApply: false });
    expect(offer.status, JSON.stringify(offer.body)).toBe(201);
    const line = { type: 'custom', key: randomUUID(), description: 'Hair Spa', unitPrice: 100000, quantity: 1 };
    await setFeatures(['offers']);
    const refused = await owner.post('/billing/invoices').send({ branchId: t.branchId, customerId, offerCode: 'TENOFF', lines: [line] });
    expect(refused.status).toBe(403);
    expect(refused.body.errorCode).toBe('FEATURE_OFF');
    await setFeatures([]);
  });

  it('only platform administrators switch features, and unknown features are refused', async () => {
    expect((await owner.patch(`/platform/organizations/${t.orgId}`).send({ disabledFeatures: ['reports'] })).status).toBe(403);
    expect((await setFeatures(['teleportation'])).status).toBe(400);
    const log = await owner.get('/audit?action=organization.updated');
    expect(log.body.data.some((l: { summary: string }) => /Reports, Packages and combos switched off|Packages and combos, Reports switched off/.test(l.summary))).toBe(true);
  });
});

describe('support mode', () => {
  it('a platform administrator opens a salon and works in it as its owner would, and it is logged', async () => {
    const res = await admin.post(`/platform/organizations/${t.orgId}/support`);
    expect(res.status).toBe(200);
    expect(res.body.data.user).toMatchObject({ isPlatformAdmin: true, support: { organizationName: expect.any(String) }, organization: { id: t.orgId }, role: { key: 'owner', name: 'Platform support', homeScreen: 'owner_dashboard' } });
    expect(res.body.data.user.permissions).toContain('settings.manage');
    const support = authed(res.body.data.accessToken);

    // Every screen of that salon, and real work in it.
    expect((await support.get('/customers?pageSize=5')).status).toBe(200);
    const booked = await support.post('/appointments').send({ branchId: t.branchId, customerId, notifyCustomer: false, items: [{ serviceId: hairSpa, staffId: rahul, startAt: at(bookingDate(5), '11:00') }] });
    expect(booked.status, JSON.stringify(booked.body)).toBe(201);

    // Only that salon: another salon's data stays out of reach, even by id.
    const otherBranch = await createBranch(other, 'Elsewhere', 'ELS');
    expect((await support.get(`/branches/${otherBranch}`)).status).toBeGreaterThanOrEqual(403);
    expect((await support.get('/branches')).body.data.every((b: { id: string }) => b.id !== otherBranch)).toBe(true);

    // The salon sees who did it.
    const log = (await owner.get('/audit?pageSize=50')).body.data as Array<{ action: string; summary: string | null; userName: string | null }>;
    expect(log.find((l) => l.action === 'platform.support_opened')).toMatchObject({ userName: 'SalonOS platform team', summary: 'Platform Pat (platform administrator) opened the salon in support mode' });
    expect(log.find((l) => l.action.startsWith('appointment.created'))?.summary).toMatch(/\(platform support\)$/);
  });

  it('salon users cannot open support mode, and switched-off features stay off in support mode', async () => {
    expect((await owner.post(`/platform/organizations/${t.orgId}/support`)).status).toBe(403);
    await setFeatures(['reports']);
    const support = authed((await admin.post(`/platform/organizations/${t.orgId}/support`)).body.data.accessToken);
    expect((await support.get('/reports')).status).toBe(403);
    await setFeatures([]);
  });
});
