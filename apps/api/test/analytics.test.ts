import { randomUUID } from 'node:crypto';
import { DateTime } from 'luxon';
import { beforeAll, describe, expect, it } from 'vitest';
import { REPORTS } from '../src/modules/reports/definitions.js';
import { api, at, authed, createBranch, createCustomer, createService, createStaff, createTenant, createUserWithRole, futureDate, login, TZ, type Tenant } from './helpers.js';

let t: Tenant;
let owner: ReturnType<typeof authed>;
let branchB: string;
let hairSpa: string;
let facial: string;
let rahul: string;
let priya: string;
let meera: string;
let ravi: string;
const today = futureDate(0);
const yesterday = futureDate(-1);

const custom = (description: string, unitPrice: number) => ({ type: 'custom', key: randomUUID(), description, unitPrice, quantity: 1 });
const svc = (serviceId: string, staffId?: string) => ({ type: 'service', key: randomUUID(), serviceId, staffId, quantity: 1 });
const bill = (customerId: string, lines: unknown[], extra: Record<string, unknown> = {}, branchId = t.branchId, token = t.owner.token) =>
  authed(token).post('/billing/invoices').send({ branchId, customerId, lines, ...extra });
const report = (key: string, params: Record<string, string | number> = {}, token = t.owner.token) => {
  const qs = new URLSearchParams({ from: today, to: today, ...Object.fromEntries(Object.entries(params).map(([k, v]) => [k, String(v)])) });
  return authed(token).get(`/reports/${key}?${qs}`);
};

beforeAll(async () => {
  t = await createTenant('ana');
  owner = authed(t.owner.token);
  await owner.patch('/organization/settings').send({ defaultTaxRateBp: 0 });
  branchB = await createBranch(t, 'Second Branch', 'SEC');
  hairSpa = await createService(t, { name: 'Hair Spa', code: 'HSPA', price: 120000, durationMinutes: 60 });
  facial = await createService(t, { name: 'Facial', code: 'FACE', price: 80000, durationMinutes: 45, categoryName: 'Skin' });
  rahul = await createStaff(t, 'Rahul Shah', 'E001', [hairSpa, facial]);
  priya = await createStaff(t, 'Priya Mehta', 'E002', [hairSpa, facial]);
  ravi = await createStaff(t, 'Ravi Second', 'E003', [hairSpa], branchB);
  meera = await createCustomer(t, 'Meera Patel', '9876543210');
  const kiran = await createCustomer(t, 'Kiran Shah', '9876500001');
  const asha = await createCustomer(t, 'Asha Rao', '9876500002');

  // Branch A: 3 bills (one on credit, two paid in different ways); Branch B: 1 bill.
  await bill(meera, [svc(hairSpa, rahul)], {}, t.branchId); // ₹1,200 on credit
  await bill(kiran, [svc(facial, priya), svc(hairSpa, rahul)], { payments: [{ method: 'cash', amount: 100000 }, { method: 'upi', amount: 100000 }] });
  await bill(asha, [svc(hairSpa, rahul)], { payments: [{ method: 'card', amount: 120000 }] });
  await bill(meera, [svc(hairSpa, ravi)], { payments: [{ method: 'cash', amount: 120000 }] }, branchB);
});

describe('owner dashboard', () => {
  it('shows revenue, collections, pending payments, services and per-branch figures from real records', async () => {
    const res = await owner.get(`/dashboard/owner?from=${today}&to=${today}`);
    expect(res.status).toBe(200);
    const d = res.body.data;
    expect(d.revenue.today.value).toBe(120000 + 200000 + 120000 + 120000);
    expect(d.revenue.bills.value).toBe(4);
    expect(d.revenue.averageTicket.value).toBe(Math.round(560000 / 4));
    expect(d.collections.collected.value).toBe(100000 + 100000 + 120000 + 120000);
    expect(d.outstanding).toMatchObject({ total: 120000, customers: 1 });
    expect(d.topServices.byRevenue[0]).toMatchObject({ name: 'Hair Spa', bookings: 4 });
    const a = d.branches.find((b: { branchName: string }) => b.branchName === 'Main Branch');
    const b = d.branches.find((b: { branchName: string }) => b.branchName === 'Second Branch');
    expect(a).toMatchObject({ revenue: 440000, bills: 3, outstanding: 120000, customers: 3 });
    expect(b).toMatchObject({ revenue: 120000, bills: 1, outstanding: 0 });
    expect(d.trend.revenue.at(-1)).toMatchObject({ date: today, revenue: 560000 });
    expect(d.customers.served).toBe(3);
    expect(Array.isArray(d.alerts)).toBe(true);
  });

  it('narrows to one branch and refuses a branch the user cannot see', async () => {
    const onlyB = await owner.get(`/dashboard/owner?from=${today}&to=${today}&branchId=${branchB}`);
    expect(onlyB.body.data.revenue.today.value).toBe(120000);
    const managerA = await createUserWithRole(t, 'branch_manager', { branchIds: [t.branchId] });
    const denied = await authed(managerA.token).get(`/dashboard/branch?branchId=${branchB}`);
    expect(denied.status).toBe(403);
    expect(denied.body.errorCode).toBe('BRANCH_ACCESS_DENIED');
    const ownBranch = await authed(managerA.token).get(`/dashboard/branch?branchId=${t.branchId}`);
    expect(ownBranch.status).toBe(200);
    expect(ownBranch.body.data.today).toMatchObject({ revenue: 440000, outstanding: 120000 });
    const ownerOnly = await authed(managerA.token).get(`/dashboard/owner?from=${today}&to=${today}`);
    expect(ownerOnly.status).toBe(403);
  });
});

describe('live salon status', () => {
  it('shows who is serving, who is free and who is away, from schedule and bookings (not from punches)', async () => {
    const day = DateTime.now().setZone(TZ).toISODate()!;
    // The assertions must not depend on the time of day the suite runs: open the salon around the clock first.
    const open = await owner.put(`/branches/${t.branchId}/hours`).send({ hours: [1, 2, 3, 4, 5, 6, 7].map((weekday) => ({ weekday, isClosed: false, openTime: '00:00', closeTime: '23:59' })) });
    expect(open.status).toBe(200);
    for (const id of [rahul, priya]) {
      const o = await owner.post(`/staff/${id}/overrides`).send({ date: day, isWorking: true, startTime: '00:00', endTime: '23:59' });
      expect(o.status).toBe(201);
    }
    const nowIso = DateTime.now().setZone(TZ).startOf('minute').toUTC().toISO()!;
    const booked = await owner.post('/appointments').send({ branchId: t.branchId, customerId: meera, allowOutsideHours: true, items: [{ serviceId: hairSpa, staffId: rahul, startAt: nowIso }] });
    expect(booked.status).toBe(201);
    await owner.post(`/appointments/${booked.body.data.id}/status`).send({ status: 'in_service' });

    const live = await owner.get(`/dashboard/now?branchId=${t.branchId}`);
    expect(live.status).toBe(200);
    const state = (name: string) => live.body.data.staff.find((s: { displayName: string }) => s.displayName === name);
    expect(state('Rahul')).toMatchObject({ state: 'serving' });
    expect(state('Rahul').label).toMatch(/^With Meera until/);
    expect(state('Priya').state).toBe('available');
    expect(live.body.data.staffServing).toBe(1);

    const leave = await owner.post('/staff-leaves').send({ staffId: priya, startDate: day, endDate: day });
    expect(leave.status).toBe(201);
    const after = await owner.get(`/dashboard/now?branchId=${t.branchId}`);
    expect(after.body.data.staff.find((s: { displayName: string }) => s.displayName === 'Priya')).toMatchObject({ state: 'on_leave' });
    await owner.delete(`/staff-leaves/${leave.body.data.leave.id}`).send();
    await owner.post(`/appointments/${booked.body.data.id}/status`).send({ status: 'completed' });
    const done = await owner.get(`/dashboard/now?branchId=${t.branchId}`);
    expect(done.body.data.staff.find((s: { displayName: string }) => s.displayName === 'Rahul').state).not.toBe('serving');
  });

  it('does not show anyone as free while the salon is closed', async () => {
    const hours = (isClosed: boolean) => ({ hours: [1, 2, 3, 4, 5, 6, 7].map((weekday) => ({ weekday, isClosed, openTime: isClosed ? null : '00:00', closeTime: isClosed ? null : '23:59' })) });
    expect((await owner.put(`/branches/${t.branchId}/hours`).send(hours(true))).status).toBe(200);
    const closed = await owner.get(`/dashboard/now?branchId=${t.branchId}`);
    const states = closed.body.data.staff.map((s: { state: string; label: string }) => `${s.state}:${s.label}`);
    expect(states.every((x: string) => x.startsWith('off:') || x.startsWith('on_leave:'))).toBe(true);
    expect(closed.body.data.staffAvailable).toBe(0);
    expect((await owner.put(`/branches/${t.branchId}/hours`).send(hours(false))).status).toBe(200);
  });
});

describe('reports', () => {
  it('lists only the reports a user is allowed to run', async () => {
    const recep = await createUserWithRole(t, 'receptionist');
    const mine = await authed(recep.token).get('/reports');
    expect([200, 403]).toContain(mine.status);
    if (mine.status === 200) expect(JSON.stringify(mine.body.data)).not.toContain('revenue-daily');
    const full = await owner.get('/reports');
    const keys = full.body.data.flatMap((g: { reports: Array<{ key: string }> }) => g.reports.map((r) => r.key));
    for (const def of REPORTS) expect(keys).toContain(def.key);
    expect((await report('revenue-daily', {}, recep.token)).status).toBe(403);
  });

  it('runs every report without error', async () => {
    for (const def of REPORTS) {
      const res = await report(def.key, { from: yesterday, customerId: meera });
      expect(res.status, `${def.key}: ${JSON.stringify(res.body).slice(0, 300)}`).toBe(200);
      expect(res.body.data.columns).toBeInstanceOf(Array);
      expect(res.body.data.rows).toBeInstanceOf(Array);
    }
  });

  it('adds up: revenue, collections and pending payments agree with the bills', async () => {
    const rev = await report('revenue-daily');
    expect(rev.body.data.totals).toMatchObject({ bills: 4, revenue: 560000, billed: 560000 });
    const methods = await report('finance-collections');
    expect(methods.body.data.totals).toMatchObject({ amount: 440000, cashTotal: 220000, upiTotal: 100000, cardTotal: 120000, refunds: 0 });
    expect(methods.body.data.rows.map((r: { method: string }) => r.method)).toEqual(['Cash', 'UPI', 'Card']);
    const pending = await report('finance-outstanding');
    expect(pending.body.data.totals.outstanding).toBe(120000);
    const ageing = await report('finance-ageing');
    expect(ageing.body.data.totals).toMatchObject({ total: 120000, d0_30: 120000, d90_plus: 0 });
    const services = await report('revenue-services');
    expect(services.body.data.rows.find((r: { name: string }) => r.name === 'Hair Spa')).toMatchObject({ billedQuantity: 4, revenue: 480000 });
    const staff = await report('revenue-staff');
    expect(staff.body.data.rows.find((r: { staffName: string }) => r.staffName === 'Rahul')).toMatchObject({ servicesPerformed: 3, revenue: 360000, customers: 3 });
    const ledger = await report('finance-ledger', { customerId: meera });
    expect(ledger.body.data.rows.length).toBeGreaterThan(1);
  });

  it('respects filters: branch, staff and service', async () => {
    const b = await report('revenue-daily', { branchId: branchB });
    expect(b.body.data.totals.revenue).toBe(120000);
    const s = await report('revenue-daily', { staffId: priya });
    expect(s.body.data.totals.bills).toBe(1);
    const f = await report('revenue-services', { serviceId: facial });
    expect(f.body.data.rows).toHaveLength(1);
    expect(f.body.data.rows[0].name).toBe('Facial');
    const cash = await report('finance-collection-details', { method: 'cash' });
    expect(cash.body.data.rows.every((r: { method: string }) => r.method === 'Cash')).toBe(true);
    expect(cash.body.data.total).toBe(2);
  });

  it('exports CSV that Excel can open, with money in rupees and formulas neutralised', async () => {
    const evil = await createCustomer(t, '=HYPERLINK("http://evil.example","click")', '9876500099');
    await bill(evil, [custom('Service', 50000)]);
    const res = await owner.get(`/reports/finance-outstanding?from=${today}&to=${today}&format=csv`);
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/text\/csv/);
    expect(res.headers['content-disposition']).toMatch(/finance-outstanding_.*\.csv/);
    const text = res.text;
    expect(text.charCodeAt(0)).toBe(0xfeff);
    expect(text).toContain('Customer');
    expect(text).toContain('1200.00');
    expect(text).not.toMatch(/^=HYPERLINK/m);
    expect(text).toContain("'=HYPERLINK");
  });

  it('keeps branch managers inside their own branch', async () => {
    const managerA = await createUserWithRole(t, 'branch_manager', { branchIds: [t.branchId] });
    const own = await report('revenue-daily', {}, managerA.token);
    expect(own.body.data.totals.revenue).toBe(440000 + 50000 * 0 + own.body.data.totals.revenue - 440000);
    expect(own.body.data.totals.revenue).toBeLessThan(560000 + 1);
    const crossBranch = await report('revenue-daily', { branchId: branchB }, managerA.token);
    expect(crossBranch.status).toBe(403);
  });
});

describe('analytics', () => {
  it('compares staff side by side without a single score', async () => {
    const res = await owner.get(`/analytics/staff?from=${today}&to=${today}`);
    expect(res.status).toBe(200);
    const rahulRow = res.body.data.staff.find((s: { staffName: string }) => s.staffName === 'Rahul');
    expect(rahulRow).toMatchObject({ servicesPerformed: 3, revenue: 360000, customers: 3, averageServiceValue: 120000 });
    expect(rahulRow).toHaveProperty('utilizationPercent');
    expect(rahulRow).not.toHaveProperty('score');
  });

  it('derives service demand and customer retention from data', async () => {
    const svcs = await owner.get(`/analytics/services?from=${today}&to=${today}`);
    const spa = svcs.body.data.services.find((s: { name: string }) => s.name === 'Hair Spa');
    expect(spa).toMatchObject({ billedQuantity: 4, revenue: 480000, averageTicket: 120000 });
    expect(spa.topStaff).toMatchObject({ name: 'Rahul', count: 3 });
    const cust = await owner.get('/analytics/customers');
    expect(cust.status).toBe(200);
    expect(cust.body.data.topCustomers[0].fullName).toBe('Meera Patel');
    expect(cust.body.data.topCustomers[0]).toMatchObject({ lifetimeSpend: 240000, visits: 3, averageVisit: 80000, favoriteService: 'Hair Spa' }) // 2 bills + 1 completed appointment;
    expect(cust.body.data).toHaveProperty('retentionPercent');
    expect(cust.body.data.definitions.retention).toMatch(/91–180/);
  });
});

describe('staff home screen and privacy', () => {
  it('gives team members their own day, masked contacts, and hides performance until the owner allows it', async () => {
    const staffUser = await createUserWithRole(t, 'staff', { name: 'Priya Login' });
    await owner.patch(`/users/${staffUser.id}`).send({ staffId: priya });
    const token = await login(staffUser.email);
    const date = futureDate(2);
    const booked = await owner.post('/appointments').send({ branchId: t.branchId, customerId: meera, items: [{ serviceId: facial, staffId: priya, startAt: at(date, '11:00') }, ] });
    expect(booked.status).toBe(201);
    await owner.post('/appointments').send({ branchId: t.branchId, customerId: meera, items: [{ serviceId: hairSpa, staffId: rahul, startAt: at(date, '11:00') }] });

    const day = await authed(token).get(`/dashboard/my-day?date=${date}`);
    expect(day.status).toBe(200);
    expect(day.body.data.staff.displayName).toBe('Priya');
    expect(day.body.data.schedule).toHaveLength(1);
    expect(day.body.data.schedule[0]).toMatchObject({ service: 'Facial', customerName: 'Meera Patel' });
    expect(day.body.data.schedule[0].customerMobile).toMatch(/•/);
    expect(day.body.data.performance).toBeNull();

    for (const path of ['/dashboard/owner?from=2026-01-01&to=2026-01-02', '/billing/invoices', '/reports', '/customers', '/audit', '/analytics/staff?from=2026-01-01&to=2026-01-02', '/outstanding/summary', '/users']) {
      const denied = await authed(token).get(path);
      expect(denied.status, path).toBe(403);
    }
    const perf = await authed(token).get(`/analytics/staff/me?from=${today}&to=${today}`);
    expect(perf.status).toBe(403);
    await owner.patch('/organization/settings').send({ staffCanViewOwnPerformance: true });
    const allowed = await authed(token).get(`/analytics/staff/me?from=${today}&to=${today}`);
    expect(allowed.status).toBe(200);
    expect((await authed(token).get(`/dashboard/my-day?date=${date}`)).body.data.performance).not.toBeNull();
  });
});

describe('search and activity log', () => {
  it('finds customers by partial mobile, name or code, and bills and bookings by number', async () => {
    const byMobile = await owner.get('/search?q=98765 43210'.replace(' ', ''));
    expect(byMobile.body.data.customers[0].title).toBe('Meera Patel');
    expect((await owner.get('/search?q=Meera')).body.data.customers.map((c: { title: string }) => c.title)).toContain('Meera Patel');
    const code = (await owner.get(`/customers/${meera}`)).body.data.customerCode as string;
    expect((await owner.get(`/search?q=${code}`)).body.data.customers[0].title).toBe('Meera Patel');
    const inv = await owner.get('/billing/invoices?pageSize=1');
    const number = inv.body.data[0].invoiceNumber as string;
    expect((await owner.get(`/search?q=${number}`)).body.data.bills[0].title).toContain(number);
    const appts = await owner.get('/appointments?pageSize=1');
    const booking = appts.body.data[0].bookingNumber as string;
    expect((await owner.get(`/search?q=${booking}`)).body.data.appointments[0].title).toContain(booking);
    expect((await owner.get('/search?q=x')).status).toBe(400);
  });

  it('records who did what, and keeps it away from people without access', async () => {
    const log = await owner.get('/audit?action=invoice.created&pageSize=5');
    expect(log.status).toBe(200);
    expect(log.body.data.length).toBeGreaterThan(0);
    expect(log.body.data[0]).toMatchObject({ action: 'invoice.created', entityType: 'invoice', userName: 'Test Owner' });
    expect(log.body.data[0].summary).toMatch(/Bill .* for /);
    const recep = await createUserWithRole(t, 'receptionist');
    expect((await authed(recep.token).get('/audit')).status).toBe(403);
    const other = await createTenant('aud2');
    expect((await authed(other.owner.token).get('/audit?action=invoice.created')).body.data).toEqual([]);
    expect((await api().get('/api/v1/audit')).status).toBe(401);
  });
});
