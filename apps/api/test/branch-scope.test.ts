import { randomUUID } from 'node:crypto';
import { DateTime } from 'luxon';
import { beforeAll, describe, expect, it } from 'vitest';
import { authed, createBranch, createTenant, createUserWithRole, TZ, type Tenant } from './helpers.js';

// A login limited to one branch sees that branch's customers, with their numbers counted there. Customers of another
// branch can still be found by name or phone (to book them here), but nothing of their history there shows.

let t: Tenant;
let owner: ReturnType<typeof authed>;
let rajkot: string;
let ahmedabad: string;
let manager: ReturnType<typeof authed>;
let desk: ReturnType<typeof authed>;
const ids: Record<'onlyRajkot' | 'onlyAhmedabad' | 'both', string> = { onlyRajkot: '', onlyAhmedabad: '', both: '' };
const spent: Record<string, { rajkot: number; ahmedabad: number }> = {};
const today = DateTime.now().setZone(TZ).toISODate()!;

const custom = (description: string, unitPrice: number) => ({ type: 'custom', key: randomUUID(), description, unitPrice, quantity: 1 });
const otherBranchBills: string[] = [];
async function bill(branchId: string, customerId: string, amount: number): Promise<number> {
  const res = await owner.post('/billing/invoices').send({ branchId, customerId, lines: [custom('Hair Spa', amount)] });
  if (res.status !== 201) throw new Error(JSON.stringify(res.body));
  if (branchId === ahmedabad) otherBranchBills.push(res.body.data.id, res.body.data.invoiceNumber);
  return res.body.data.grandTotal as number;
}
const names = (rows: Array<{ fullName?: string; id?: string }>) => rows.map((r) => r.fullName);

beforeAll(async () => {
  t = await createTenant('scope');
  owner = authed(t.owner.token);
  rajkot = t.branchId;
  ahmedabad = await createBranch(t, 'Ahmedabad', 'AMD');
  for (const [key, name, branchId] of [['onlyRajkot', 'Rina Rajkot', rajkot], ['onlyAhmedabad', 'Asha Ahmedabad', ahmedabad], ['both', 'Bina Both', rajkot]] as const) {
    const res = await owner.post('/customers').send({ fullName: name, mobile: `9${Math.floor(100000000 + Math.random() * 899999999)}`, preferredBranchId: branchId });
    if (res.status !== 201) throw new Error(JSON.stringify(res.body));
    ids[key] = res.body.data.id;
  }
  spent.onlyRajkot = { rajkot: await bill(rajkot, ids.onlyRajkot, 100000), ahmedabad: 0 };
  spent.onlyAhmedabad = { rajkot: 0, ahmedabad: await bill(ahmedabad, ids.onlyAhmedabad, 900000) };
  spent.both = { rajkot: await bill(rajkot, ids.both, 50000), ahmedabad: await bill(ahmedabad, ids.both, 300000) };
  manager = authed((await createUserWithRole(t, 'branch_manager', { branchIds: [rajkot] })).token);
  desk = authed((await createUserWithRole(t, 'receptionist', { branchIds: [rajkot] })).token);
});

describe('customers seen from one branch', () => {
  it('the customer list shows only this branch’s customers, with spend counted here', async () => {
    for (const who of [manager, desk]) {
      const list = (await who.get('/customers?pageSize=100')).body.data as Array<{ id: string; fullName: string; lifetimeSpend: number; visitCount: number }>;
      expect(names(list).sort()).toEqual(['Bina Both', 'Rina Rajkot']);
      const both = list.find((c) => c.id === ids.both)!;
      expect(both).toMatchObject({ lifetimeSpend: spent.both!.rajkot, visitCount: 1 });
    }
    // The owner sees everyone, with salon-wide numbers.
    const all = (await owner.get('/customers?pageSize=100')).body.data as Array<{ id: string; fullName: string; lifetimeSpend: number }>;
    expect(names(all).sort()).toEqual(['Asha Ahmedabad', 'Bina Both', 'Rina Rajkot']);
    expect(all.find((c) => c.id === ids.both)!.lifetimeSpend).toBe(spent.both!.rajkot + spent.both!.ahmedabad);
    // Filtering by a branch the login does not have is refused.
    expect((await manager.get(`/customers?branchId=${ahmedabad}`)).status).toBe(403);
  });

  it('the export has the same customers and numbers', async () => {
    const csv = (await manager.get('/customers/export')).text;
    expect(csv).toContain('Rina Rajkot');
    expect(csv).not.toContain('Asha Ahmedabad');
  });

  it('a customer of another branch can be found to book them, but their history there stays hidden', async () => {
    const found = (await desk.get('/customers/search?q=Asha')).body.data as Array<{ id: string }>;
    expect(found.map((c) => c.id)).toContain(ids.onlyAhmedabad);

    const profile = (await manager.get(`/customers/${ids.onlyAhmedabad}/360`)).body.data;
    expect(profile.stats).toMatchObject({ visitCount: 0, lifetimeSpend: 0, favoriteStaff: null, favoriteService: null, lastVisitAt: null });
    expect(profile.invoices).toEqual([]);
    expect(profile.suggestion).toBeNull();

    const both = (await manager.get(`/customers/${ids.both}/360`)).body.data;
    expect(both.stats).toMatchObject({ visitCount: 1, lifetimeSpend: spent.both!.rajkot });
    expect((await owner.get(`/customers/${ids.both}/360`)).body.data.stats.lifetimeSpend).toBe(spent.both!.rajkot + spent.both!.ahmedabad);
  });

  it('customer reports, analytics and groups count only this branch', async () => {
    const report = async (key: string) => (await manager.get(`/reports/${key}?from=${today}&to=${today}`)).body.data as { rows: Array<{ fullName: string; lifetimeSpend?: number }> };
    expect(names((await report('customers-new')).rows).sort()).toEqual(['Bina Both', 'Rina Rajkot']);
    const top = (await report('customers-high-value')).rows;
    expect(names(top)).not.toContain('Asha Ahmedabad');
    expect(top.find((r) => r.fullName === 'Bina Both')!.lifetimeSpend).toBe(spent.both!.rajkot);

    const analytics = (await manager.get('/analytics/customers')).body.data as { topCustomers: Array<{ fullName: string; lifetimeSpend: number }>; customersWithVisits: number };
    expect(names(analytics.topCustomers)).not.toContain('Asha Ahmedabad');
    expect(analytics.customersWithVisits).toBe(2);
    // The owner looking at one branch gets the same answer.
    expect(names((await owner.get(`/analytics/customers?branchId=${rajkot}`)).body.data.topCustomers)).not.toContain('Asha Ahmedabad');

    expect((await manager.post('/segments/preview').send({})).body.data.count).toBe(2);
    expect((await owner.post('/segments/preview').send({})).body.data.count).toBe(3);
  });
});

describe('nothing of another branch on any screen', () => {
  it('every list a branch login can open leaves out the other branch', async () => {
    const from = DateTime.now().setZone(TZ).minus({ days: 30 }).toISODate()!;
    const reports = ((await owner.get('/reports')).body.data as Array<{ reports: Array<{ key: string }> }>).flatMap((g) => g.reports.map((r) => r.key));
    const paths = [
      '/customers?pageSize=100', '/customers/export', '/segments', '/billing/invoices?pageSize=100', '/payments?pageSize=100', '/outstanding/summary', '/outstanding/customers', '/outstanding/invoices',
      `/appointments?from=${from}&to=${today}&pageSize=100`, `/appointments/calendar?branchId=${rajkot}&from=${from}&to=${today}`, `/walkins?branchId=${rajkot}`, '/staff?pageSize=100', '/staff-leaves',
      `/attendance?from=${from}&to=${today}`, `/dashboard/branch?branchId=${rajkot}`, '/dashboard/now', `/analytics/staff?from=${from}&to=${today}`, `/analytics/services?from=${from}&to=${today}`,
      '/analytics/customers', '/notifications?pageSize=100', '/notifications/summary', '/audit?pageSize=100', '/branches', '/change-requests', `/ledger/reconcile?date=${today}`,
      ...reports.map((k) => `/reports/${k}?from=${from}&to=${today}`),
    ];
    const markers = [ahmedabad, 'Asha Ahmedabad', ...otherBranchBills];
    for (const who of [manager, desk]) {
      for (const path of paths) {
        const res = await who.get(path);
        expect([200, 403], `${path}: ${res.status} ${JSON.stringify(res.body).slice(0, 200)}`).toContain(res.status);
        const text = res.text;
        for (const m of markers) expect(text.includes(m), `${path} shows ${m}`).toBe(false);
      }
    }
  });
});

describe('what each role can do', () => {
  it('a receptionist runs the front desk; the branch dashboard and attendance records are the manager’s', async () => {
    expect((await desk.get(`/dashboard/branch?branchId=${rajkot}`)).status).toBe(403);
    expect((await desk.get('/dashboard/owner')).status).toBe(403);
    expect((await desk.get(`/attendance?from=${today}&to=${today}`)).status).toBe(403);
    expect((await desk.get(`/dashboard/now?branchId=${rajkot}`)).status).toBe(200); // the Front desk's live status
    expect((await manager.get(`/attendance?from=${today}&to=${today}`)).status).toBe(200);
  });

  it('branch comparison reports are listed only for people who see more than one branch', async () => {
    const keys = async (who: ReturnType<typeof authed>) => ((await who.get('/reports')).body.data as Array<{ reports: Array<{ key: string }> }>).flatMap((g) => g.reports.map((r) => r.key));
    expect(await keys(owner)).toEqual(expect.arrayContaining(['revenue-branches', 'appointments-branch', 'staff-commission']));
    const mine = await keys(manager);
    expect(mine).not.toContain('revenue-branches');
    expect(mine).not.toContain('appointments-branch');
    expect(mine).toContain('staff-commission');
  });

  it('a manager’s dashboard is the business story for their branch only', async () => {
    const res = await manager.get(`/dashboard/owner?from=${today}&to=${today}`);
    expect(res.status).toBe(200);
    expect(res.text).not.toContain(ahmedabad);
    expect(res.text).not.toContain('Asha Ahmedabad');
    expect(res.body.data.revenue.today.value).toBe(100000 + 50000); // revenue is before tax: Rajkot’s two bills only
    expect(res.body.data.customers.totalActive).toBe(2);
    expect((res.body.data.topCustomers as Array<{ fullName: string; lifetimeSpend: number }>).find((c) => c.fullName === 'Bina Both')!.lifetimeSpend).toBe(spent.both!.rajkot);
    expect((await manager.get(`/dashboard/owner?branchId=${ahmedabad}&from=${today}&to=${today}`)).status).toBe(403);
  });

  it('a manager archives and brings back their own branch’s customers only', async () => {
    expect((await desk.delete(`/customers/${ids.onlyRajkot}`)).status).toBe(403);
    expect((await manager.delete(`/customers/${ids.onlyAhmedabad}`)).status).toBe(403);
    expect((await manager.delete(`/customers/${ids.onlyRajkot}`)).status).toBe(204);
    expect(names((await manager.get('/customers?pageSize=100')).body.data)).not.toContain('Rina Rajkot');
    expect(names((await manager.get('/customers?status=archived')).body.data)).toEqual(['Rina Rajkot']);
    expect((await manager.post(`/customers/${ids.onlyRajkot}/restore`)).status).toBe(200);
    expect((await manager.post(`/customers/${ids.onlyRajkot}/restore`)).status).toBe(409);
    expect(names((await manager.get('/customers?pageSize=100')).body.data)).toContain('Rina Rajkot');
  });
});
