import { randomUUID } from 'node:crypto';
import { DateTime } from 'luxon';
import { beforeAll, describe, expect, it } from 'vitest';
import { authed, createCustomer, createService, createTenant, TZ, type Tenant } from './helpers.js';

let t: Tenant;
let owner: ReturnType<typeof authed>;
const today = DateTime.now().setZone(TZ).toISODate()!;
const svc = (serviceId: string, staffId: string) => ({ type: 'service', key: randomUUID(), serviceId, staffId, quantity: 1 });

describe('commission earned', () => {
  let hairSpa: string;
  let anita: string;
  let bina: string;
  let chetan: string;
  const taxable: Record<string, number> = {};

  beforeAll(async () => {
    t = await createTenant('comm');
    owner = authed(t.owner.token);
    hairSpa = await createService(t, { name: 'Hair Spa', code: 'HSPA', price: 100000, durationMinutes: 60 });
    // Anita: 10% usually. Bina: 5% usually, but ₹50 flat for Hair Spa. Chetan: no rate.
    const add = async (fullName: string, code: string, commission: { commissionType: string; commissionValue: number }, override?: { commissionType: string; commissionValue: number }) => {
      const res = await owner.post('/staff').send({ branchId: t.branchId, employeeCode: code, fullName, displayName: fullName.split(' ')[0], ...commission });
      expect(res.status, JSON.stringify(res.body)).toBe(201);
      const id = res.body.data.id as string;
      expect((await owner.put(`/staff/${id}/services`).send({ services: [{ serviceId: hairSpa, isActive: true, ...override }] })).status).toBe(200);
      return id;
    };
    anita = await add('Anita Rao', 'E1', { commissionType: 'percentage', commissionValue: 1000 });
    bina = await add('Bina Shah', 'E2', { commissionType: 'percentage', commissionValue: 500 }, { commissionType: 'flat', commissionValue: 5000 });
    chetan = await add('Chetan Modi', 'E3', { commissionType: 'none', commissionValue: 0 });

    const customer = await createCustomer(t, 'Meera Patel');
    for (const staffId of [anita, bina, bina, chetan]) {
      const res = await owner.post('/billing/invoices').send({ branchId: t.branchId, customerId: customer, lines: [svc(hairSpa, staffId)] });
      expect(res.status, JSON.stringify(res.body)).toBe(201);
      taxable[staffId] = (taxable[staffId] ?? 0) + (res.body.data.lines as Array<{ taxableAmount: number }>)[0]!.taxableAmount;
    }
  });

  it('uses the per-service rate, else the usual rate, and shows who has no rate', async () => {
    const res = await owner.get(`/reports/staff-commission?from=${today}&to=${today}`);
    expect(res.status).toBe(200);
    const rows = res.body.data.rows as Array<{ staffName: string; services: number; base: number; commission: number; noRate: number }>;
    const by = (name: string) => rows.find((r) => r.staffName === name.split(' ')[0])!;
    expect(by('Anita')).toMatchObject({ services: 1, base: taxable[anita], commission: Math.round(taxable[anita]! * 0.1), noRate: 0 });
    expect(by('Bina')).toMatchObject({ services: 2, commission: 2 * 5000, noRate: 0 });
    expect(by('Chetan')).toMatchObject({ services: 1, commission: 0, noRate: 1 });
    expect(res.body.data.totals.commission).toBe(Math.round(taxable[anita]! * 0.1) + 10000);
    expect(res.body.data.note).toMatch(/1 team member has services with no rate set/);
  });
});
