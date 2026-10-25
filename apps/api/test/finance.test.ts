import { randomUUID } from 'node:crypto';
import { beforeAll, describe, expect, it } from 'vitest';
import { sql } from 'kysely';
import { withSystem } from '../src/db/tenant.js';
import { at, authed, createCustomer, createService, createStaff, createTenant, createUserWithRole, futureDate, type Tenant } from './helpers.js';

let t: Tenant;
let owner: ReturnType<typeof authed>;
let hairSpa: string;
let facial: string;
let rahul: string;

const custom = (description: string, unitPrice: number) => ({ type: 'custom', key: randomUUID(), description, unitPrice, quantity: 1 });
const svc = (serviceId: string, staffId?: string) => ({ type: 'service', key: randomUUID(), serviceId, staffId, quantity: 1 });

async function bill(customerId: string, lines: unknown[], extra: Record<string, unknown> = {}, token = t.owner.token, headers: Record<string, string> = {}) {
  let req = authed(token).post('/billing/invoices');
  for (const [k, v] of Object.entries(headers)) req = req.set(k, v);
  return req.send({ branchId: t.branchId, customerId, lines, ...extra });
}
const collect = (customerId: string, amount: number, extra: Record<string, unknown> = {}, token = t.owner.token) =>
  authed(token).post('/payments/collect').send({ branchId: t.branchId, customerId, amount, method: 'cash', ...extra });
const account = async (customerId: string) => (await owner.get(`/customers/${customerId}/360`)).body.data.account as { outstanding: number; advance: number; balance: number };
const reconcile = async () => (await owner.get('/ledger/reconcile')).body.data;

beforeAll(async () => {
  t = await createTenant('fin');
  owner = authed(t.owner.token);
  // No tax in these tests so the arithmetic is easy to read; tax maths is unit-tested in the shared package.
  await owner.patch('/organization/settings').send({ defaultTaxRateBp: 0 });
  hairSpa = await createService(t, { name: 'Hair Spa', code: 'HSPA', price: 120000, durationMinutes: 60 });
  facial = await createService(t, { name: 'Facial', code: 'FACE', price: 80000, durationMinutes: 45, categoryName: 'Skin' });
  rahul = await createStaff(t, 'Rahul Shah', 'E001', [hairSpa, facial]);
});

describe('credit cycle', () => {
  it('tracks 3 bills on credit and settles them with one payment (₹6,500 example)', async () => {
    const c = await createCustomer(t, 'Credit Customer');
    for (const amount of [200000, 150000, 300000]) {
      const res = await bill(c, [custom('Service', amount)]);
      expect(res.status).toBe(201);
      expect(res.body.data).toMatchObject({ grandTotal: amount, balanceDue: amount, paymentStatus: 'unpaid' });
    }
    expect((await account(c)).outstanding).toBe(650000);

    const ledger = await owner.get(`/ledger?customerId=${c}`);
    expect(ledger.body.data.rows.map((r: { balance: number }) => r.balance)).toEqual([200000, 350000, 650000]);

    const pay = await collect(c, 650000);
    expect(pay.status).toBe(201);
    expect(pay.body.data).toMatchObject({ amount: 650000, allocatedAmount: 650000, unallocatedAmount: 0 });
    expect((await account(c)).outstanding).toBe(0);
    const after = await owner.get(`/ledger?customerId=${c}`);
    expect(after.body.data.closingBalance).toBe(0);
    expect(after.body.data.rows.at(-1)).toMatchObject({ entryType: 'payment', credit: 650000, balance: 0 });
    const invoices = await owner.get(`/billing/invoices?customerId=${c}`);
    expect(invoices.body.data.map((i: { paymentStatus: string }) => i.paymentStatus)).toEqual(['paid', 'paid', 'paid']);
    expect((await reconcile()).consistent).toBe(true);
  });

  it('supports partial payments: ₹10,000 bill, ₹4,000 paid, ₹6,000 left', async () => {
    const c = await createCustomer(t, 'Partial Customer');
    const inv = await bill(c, [custom('Bridal', 1000000)]);
    const pay = await collect(c, 400000);
    expect(pay.status).toBe(201);
    const after = await owner.get(`/billing/invoices/${inv.body.data.id}`);
    expect(after.body.data).toMatchObject({ amountPaid: 400000, balanceDue: 600000, paymentStatus: 'partial' });
    expect((await account(c)).outstanding).toBe(600000);
    await collect(c, 600000);
    expect((await owner.get(`/billing/invoices/${inv.body.data.id}`)).body.data.paymentStatus).toBe('paid');
  });

  it('lets the receptionist pick which bills a payment settles', async () => {
    const c = await createCustomer(t, 'Chooser');
    const first = await bill(c, [custom('Item A', 100000)]);
    const second = await bill(c, [custom('Item B', 200000)]);
    const pay = await collect(c, 150000, { allocations: [{ invoiceId: second.body.data.id, amount: 150000 }] });
    expect(pay.status).toBe(201);
    expect((await owner.get(`/billing/invoices/${first.body.data.id}`)).body.data.balanceDue).toBe(100000);
    expect((await owner.get(`/billing/invoices/${second.body.data.id}`)).body.data.balanceDue).toBe(50000);
    const tooMuch = await collect(c, 500000, { allocations: [{ invoiceId: first.body.data.id, amount: 500000 }] });
    expect(tooMuch.status).toBe(422);
    expect(tooMuch.body.errorCode).toBe('PAYMENT_EXCEEDS_BALANCE');
  });

  it('keeps an over-payment as advance and applies it to the next bill', async () => {
    const c = await createCustomer(t, 'Advance Customer');
    const pay = await collect(c, 500000);
    expect(pay.body.data.unallocatedAmount).toBe(500000);
    expect(await account(c)).toMatchObject({ outstanding: 0, advance: 500000 });
    const inv = await bill(c, [custom('Service', 300000)], { useAdvance: true });
    expect(inv.status).toBe(201);
    expect(inv.body.data).toMatchObject({ balanceDue: 0, paymentStatus: 'paid' });
    expect(await account(c)).toMatchObject({ outstanding: 0, advance: 200000 });
    expect((await reconcile()).consistent).toBe(true);
  });

  it('takes payment at the counter in the same step as the bill', async () => {
    const c = await createCustomer(t, 'Counter Customer');
    const inv = await bill(c, [custom('Service', 250000)], { payments: [{ method: 'upi', amount: 100000 }, { method: 'cash', amount: 150000 }] });
    expect(inv.body.data).toMatchObject({ paymentStatus: 'paid', balanceDue: 0 });
    expect(inv.body.data.payments).toHaveLength(2);
    expect((await account(c)).outstanding).toBe(0);
  });
});

describe('credit limit', () => {
  it('blocks new credit above the limit, lets a manager override, and still allows paid-in-full bills', async () => {
    const c = await createCustomer(t, 'Limited Customer');
    const manager = await createUserWithRole(t, 'branch_manager');
    const recep = await createUserWithRole(t, 'receptionist');
    await owner.put(`/customers/${c}`).send({ creditLimit: 2000000 });
    expect((await bill(c, [custom('First', 1250000)])).status).toBe(201);

    const blocked = await bill(c, [custom('Second', 1000000)]);
    expect(blocked.status).toBe(409);
    expect(blocked.body.errorCode).toBe('CREDIT_LIMIT_EXCEEDED');
    expect(blocked.body.details).toMatchObject({ creditLimit: 2000000, outstandingAfter: 2250000 });

    const recepOverride = await bill(c, [custom('Second', 1000000)], { allowCreditLimitOverride: true }, recep.token);
    expect(recepOverride.status).toBe(409);
    const managerOverride = await bill(c, [custom('Second', 1000000)], { allowCreditLimitOverride: true }, manager.token);
    expect(managerOverride.status).toBe(201);

    // Already over the limit, but a bill paid in full creates no new credit.
    const paidInFull = await bill(c, [custom('Third', 100000)], { payments: [{ method: 'cash', amount: 100000 }] });
    expect(paidInFull.status).toBe(201);
    const view = (await owner.get(`/customers/${c}/360`)).body.data.account;
    expect(view).toMatchObject({ outstanding: 2250000, creditLimit: 2000000, availableCredit: 0 });
  });
});

describe('safety of money operations', () => {
  it('creates one bill when the same request is sent twice (idempotency key)', async () => {
    const c = await createCustomer(t, 'Double Click');
    const key = `key-${randomUUID()}`;
    const lines = [custom('Service', 100000)]; // identical request body, as a double-click would send
    const [a, b] = await Promise.all([bill(c, lines, {}, t.owner.token, { 'Idempotency-Key': key }), bill(c, lines, {}, t.owner.token, { 'Idempotency-Key': key })]);
    expect([a.status, b.status].sort()).toEqual([201, 201]);
    expect(a.body.data.id).toBe(b.body.data.id);
    expect((await account(c)).outstanding).toBe(100000);
    const reuse = await bill(c, [custom('Service', 999999)], {}, t.owner.token, { 'Idempotency-Key': key });
    expect(reuse.status).toBe(422);
    expect(reuse.body.errorCode).toBe('IDEMPOTENCY_CONFLICT');
  });

  it('leaves no partial records when a bill fails part-way', async () => {
    const c = await createCustomer(t, 'Rollback Customer');
    const before = await withSystem((tx) => tx.selectFrom('ledgerEntries').select(sql<number>`count(*)`.as('n')).where('customerId', '=', c).executeTakeFirstOrThrow());
    const res = await bill(c, [custom('Service', 100000)], { offerCode: 'NOSUCHCODE', payments: [{ method: 'cash', amount: 100000 }] });
    expect(res.status).toBe(422);
    expect(res.body.errorCode).toBe('OFFER_INVALID');
    const after = await withSystem(async (tx) => ({
      ledger: await tx.selectFrom('ledgerEntries').select(sql<number>`count(*)`.as('n')).where('customerId', '=', c).executeTakeFirstOrThrow(),
      invoices: await tx.selectFrom('invoices').select(sql<number>`count(*)`.as('n')).where('customerId', '=', c).executeTakeFirstOrThrow(),
      payments: await tx.selectFrom('payments').select(sql<number>`count(*)`.as('n')).where('customerId', '=', c).executeTakeFirstOrThrow(),
    }));
    expect(Number(after.ledger.n)).toBe(Number(before.n));
    expect(Number(after.invoices.n)).toBe(0);
    expect(Number(after.payments.n)).toBe(0);
  });

  it('refuses to edit the ledger or break bill/payment consistency, even with direct database access', async () => {
    const c = await createCustomer(t, 'Tamper Customer');
    const inv = await bill(c, [custom('Service', 100000)]);
    await expect(withSystem((tx) => tx.updateTable('ledgerEntries').set({ description: 'tampered' }).where('customerId', '=', c).execute())).rejects.toMatchObject({ code: '42501' });
    await expect(withSystem((tx) => tx.deleteFrom('ledgerEntries').where('customerId', '=', c).execute())).rejects.toMatchObject({ code: '42501' });
    await expect(withSystem((tx) => tx.updateTable('invoices').set({ grandTotal: 1 }).where('id', '=', inv.body.data.id).execute())).rejects.toThrow(/cannot be edited/);
    // Marking a bill adjusted without a matching adjustment row is caught at commit by the deferred integrity trigger.
    await expect(
      withSystem((tx) => tx.updateTable('invoices').set({ amountAdjusted: 100, balanceDue: 99900, paymentStatus: 'partial' }).where('id', '=', inv.body.data.id).execute()),
    ).rejects.toThrow(/settlement mismatch/);
    expect((await account(c)).outstanding).toBe(100000);
  });
});

describe('corrections', () => {
  it('cancelling a bill reverses the ledger and keeps the money as advance', async () => {
    const c = await createCustomer(t, 'Void Customer');
    const inv = await bill(c, [custom('Service', 300000)], { payments: [{ method: 'cash', amount: 300000 }] });
    const voided = await authed(t.owner.token).post(`/billing/invoices/${inv.body.data.id}/void`).send({ reason: 'Wrong service entered' });
    expect(voided.status).toBe(200);
    expect(voided.body.data).toMatchObject({ status: 'void', paymentStatus: 'void', balanceDue: 0 });
    expect(await account(c)).toMatchObject({ outstanding: 0, advance: 300000 });
    const again = await authed(t.owner.token).post(`/billing/invoices/${inv.body.data.id}/void`).send({ reason: 'Again please' });
    expect(again.status).toBe(409);
    const refund = await owner.post('/payments/refund').send({ paymentId: inv.body.data.payments[0].paymentId, amount: 300000, method: 'cash', reason: 'Bill cancelled' });
    expect(refund.status).toBe(201);
    expect(await account(c)).toMatchObject({ outstanding: 0, advance: 0 });
    expect((await reconcile()).consistent).toBe(true);
  });

  it('cancelling a payment makes the bill pending again', async () => {
    const c = await createCustomer(t, 'Payment Void');
    const inv = await bill(c, [custom('Service', 200000)]);
    const pay = await collect(c, 200000);
    const voided = await owner.post(`/payments/${pay.body.data.id}/void`).send({ reason: 'Entered by mistake' });
    expect(voided.status).toBe(200);
    expect(voided.body.data.status).toBe('void');
    expect((await owner.get(`/billing/invoices/${inv.body.data.id}`)).body.data).toMatchObject({ balanceDue: 200000, paymentStatus: 'unpaid' });
    expect((await account(c)).outstanding).toBe(200000);
    expect((await reconcile()).consistent).toBe(true);
  });

  it('refunds part of an applied payment and re-opens the bill by that amount', async () => {
    const c = await createCustomer(t, 'Refund Customer');
    const inv = await bill(c, [custom('Service', 200000)], { payments: [{ method: 'cash', amount: 200000 }] });
    const paymentId = inv.body.data.payments[0].paymentId;
    const refund = await owner.post('/payments/refund').send({ paymentId, amount: 50000, method: 'cash', reason: 'Unhappy with service' });
    expect(refund.status).toBe(201);
    expect(refund.body.data).toMatchObject({ refundedAmount: 50000, allocatedAmount: 150000 });
    expect((await owner.get(`/billing/invoices/${inv.body.data.id}`)).body.data).toMatchObject({ balanceDue: 50000, amountPaid: 150000, paymentStatus: 'partial' });
    const tooMuch = await owner.post('/payments/refund').send({ paymentId, amount: 200000, method: 'cash', reason: 'Too much' });
    expect(tooMuch.status).toBe(422);
    expect((await reconcile()).consistent).toBe(true);
  });

  it('records discounts and write-offs with a reason, and limits them by permission', async () => {
    const c = await createCustomer(t, 'Adjust Customer');
    const inv = await bill(c, [custom('Service', 200000)]);
    const recep = await createUserWithRole(t, 'receptionist');
    const manager = await createUserWithRole(t, 'branch_manager');
    const denied = await authed(recep.token).post('/ledger/adjustments').send({ invoiceId: inv.body.data.id, type: 'write_off', amount: 50000, reason: 'Goodwill' });
    expect(denied.status).toBe(403);
    const writeOff = await owner.post('/ledger/adjustments').send({ invoiceId: inv.body.data.id, type: 'write_off', amount: 50000, reason: 'Customer moved away' });
    expect(writeOff.status).toBe(201);
    expect(writeOff.body.data).toMatchObject({ balanceDue: 150000, amountAdjusted: 50000, paymentStatus: 'partial' });
    const discount = await authed(manager.token).post('/ledger/adjustments').send({ invoiceId: inv.body.data.id, type: 'discount', amount: 150000, reason: 'Regular customer' });
    expect(discount.status).toBe(201);
    expect(discount.body.data).toMatchObject({ balanceDue: 0, paymentStatus: 'paid' });
    expect((await account(c)).outstanding).toBe(0);
    expect(discount.body.data.adjustments).toHaveLength(2);
    expect((await reconcile()).consistent).toBe(true);
    const staffAccess = await authed(recep.token).post(`/billing/invoices/${inv.body.data.id}/void`).send({ reason: 'Nope' });
    expect(staffAccess.status).toBe(403);
  });
});

describe('offers', () => {
  const today = futureDate(0);
  const offer = (over: Record<string, unknown>) => owner.post('/offers').send({ name: 'Festive 10%', discountType: 'percentage', discountValue: 1000, validFrom: futureDate(-5), validTo: futureDate(5), ...over });

  it('applies a valid offer, refuses expired ones, and enforces per-customer limits', async () => {
    const c = await createCustomer(t, 'Offer Customer');
    const good = await offer({ code: 'FEST10', usageLimitPerCustomer: 1 });
    expect(good.status).toBe(201);
    const expired = await offer({ name: 'Old', code: 'OLD50', validFrom: futureDate(-30), validTo: futureDate(-1) });
    expect(expired.body.data.state).toBe('expired');

    const preview = await authed(t.owner.token).post('/billing/preview').send({ branchId: t.branchId, customerId: c, lines: [svc(hairSpa, rahul)], offerCode: 'FEST10' });
    expect(preview.body.data).toMatchObject({ subtotal: 120000, offerDiscount: 12000, grandTotal: 108000 });
    expect(preview.body.data.offer.name).toBe('Festive 10%');
    expect(preview.body.data.applicableOffers.map((o: { name: string }) => o.name)).toContain('Festive 10%');

    const old = await bill(c, [svc(hairSpa, rahul)], { offerCode: 'OLD50' });
    expect(old.status).toBe(422);
    expect(old.body.errorCode).toBe('OFFER_INVALID');
    expect(old.body.message).toMatch(/expired/);

    const used = await bill(c, [svc(hairSpa, rahul)], { offerId: good.body.data.id });
    expect(used.status).toBe(201);
    expect(used.body.data).toMatchObject({ offerDiscount: 12000, grandTotal: 108000, offerName: 'Festive 10%' });
    const again = await bill(c, [svc(hairSpa, rahul)], { offerId: good.body.data.id });
    expect(again.status).toBe(422);
    expect(again.body.message).toMatch(/maximum number of times/);
    void today;
  });

  it('does not let receptionists give manual discounts but lets managers', async () => {
    const c = await createCustomer(t, 'Discount Customer');
    const recep = await createUserWithRole(t, 'receptionist');
    const manager = await createUserWithRole(t, 'branch_manager');
    const body = { manualDiscount: { type: 'flat', value: 20000, reason: 'Loyal customer' } };
    expect((await bill(c, [svc(hairSpa)], body, recep.token)).status).toBe(403);
    const ok = await bill(c, [svc(hairSpa)], body, manager.token);
    expect(ok.status).toBe(201);
    expect(ok.body.data).toMatchObject({ manualDiscount: 20000, manualDiscountReason: 'Loyal customer', grandTotal: 100000 });
  });
});

describe('packages', () => {
  it('sells a package and keeps unused services available after partial use', async () => {
    const c = await createCustomer(t, 'Package Customer');
    const pkg = await owner.post('/packages').send({ code: 'BRIDAL', name: 'Bridal Package', price: 150000, validityDays: 90, items: [{ serviceId: hairSpa, quantity: 2 }, { serviceId: facial, quantity: 1 }] });
    expect(pkg.status).toBe(201);
    expect(pkg.body.data).toMatchObject({ originalValue: 320000, savings: 170000 });

    const sale = await bill(c, [{ type: 'package_sale', key: 'p', packageId: pkg.body.data.id }], { payments: [{ method: 'card', amount: 150000 }] });
    expect(sale.status).toBe(201);
    expect(sale.body.data.grandTotal).toBe(150000);

    const owned = await owner.get(`/customers/${c}/packages?activeOnly=true`);
    expect(owned.body.data).toHaveLength(1);
    const hairItem = owned.body.data[0].items.find((i: { serviceName: string }) => i.serviceName === 'Hair Spa');
    expect(hairItem).toMatchObject({ quantityTotal: 2, quantityUsed: 0, remaining: 2 });

    const use = await bill(c, [{ type: 'package_redemption', key: 'r', customerPackageItemId: hairItem.id, staffId: rahul, quantity: 1 }]);
    expect(use.status).toBe(201);
    expect(use.body.data).toMatchObject({ grandTotal: 0, paymentStatus: 'paid' });
    expect(use.body.data.lines[0].description).toContain('Bridal Package');
    const after = await owner.get(`/customers/${c}/packages?activeOnly=true`);
    const items = after.body.data[0].items as Array<{ serviceName: string; remaining: number }>;
    expect(items.find((i) => i.serviceName === 'Hair Spa')!.remaining).toBe(1);
    expect(items.find((i) => i.serviceName === 'Facial')!.remaining).toBe(1);

    const tooMany = await bill(c, [{ type: 'package_redemption', key: 'r', customerPackageItemId: hairItem.id, quantity: 2 }]);
    expect(tooMany.status).toBe(422);
    expect(tooMany.body.errorCode).toBe('PACKAGE_UNAVAILABLE');

    // Cancelling the redemption bill gives the session back.
    await owner.post(`/billing/invoices/${use.body.data.id}/void`).send({ reason: 'Customer did not attend' });
    const restored = await owner.get(`/customers/${c}/packages?activeOnly=true`);
    expect(restored.body.data[0].items.find((i: { serviceName: string }) => i.serviceName === 'Hair Spa').remaining).toBe(2);

    // A sold package that was already used cannot be cancelled.
    await bill(c, [{ type: 'package_redemption', key: 'r2', customerPackageItemId: hairItem.id, quantity: 1 }]);
    const blocked = await owner.post(`/billing/invoices/${sale.body.data.id}/void`).send({ reason: 'Refund the package' });
    expect(blocked.status).toBe(409);
  });
});

describe('billing from an appointment', () => {
  it('completes a running service, bills it with the quoted price and links the bill', async () => {
    const c = await createCustomer(t, 'Appointment Bill');
    const date = futureDate(4);
    const booking = await owner.post('/appointments').send({ branchId: t.branchId, customerId: c, items: [{ serviceId: hairSpa, staffId: rahul, startAt: at(date, '11:00') }] });
    expect(booking.status).toBe(201);
    const id = booking.body.data.id as string;
    expect((await bill(c, [svc(hairSpa, rahul)], { appointmentId: id })).status).toBe(409); // not started yet
    await owner.post(`/appointments/${id}/status`).send({ status: 'in_service' });

    const draft = await owner.get(`/billing/draft-from-appointment/${id}`);
    expect(draft.status).toBe(200);
    const inv = await bill(c, draft.body.data.lines, { appointmentId: id, payments: [{ method: 'upi', amount: 120000 }] });
    expect(inv.status).toBe(201);
    expect(inv.body.data.lines[0]).toMatchObject({ description: 'Hair Spa', unitPrice: 120000, staffName: 'Rahul' });

    const appt = await owner.get(`/appointments/${id}`);
    expect(appt.body.data).toMatchObject({ status: 'completed', invoiceNumber: inv.body.data.invoiceNumber, paymentStatus: 'paid' });
    const twice = await bill(c, draft.body.data.lines, { appointmentId: id });
    expect(twice.status).toBe(409);
    expect(twice.body.errorCode).toBe('APPOINTMENT_ALREADY_BILLED');

    const stats = (await owner.get(`/customers/${c}/360`)).body.data;
    expect(stats.stats).toMatchObject({ visitCount: 1, lifetimeSpend: 120000 });
    expect(stats.stats.favoriteService.name).toBe('Hair Spa');
    expect(stats.stats.favoriteStaff.name).toBe('Rahul');
  });
});

describe('pending payments reports', () => {
  it('summarises ageing, customer-wise and bill-wise pending amounts', async () => {
    const c = await createCustomer(t, 'Ageing Customer');
    await bill(c, [custom('Old bill', 100000)]);
    const summary = await owner.get('/outstanding/summary');
    expect(summary.status).toBe(200);
    expect(summary.body.data.totalOutstanding).toBeGreaterThan(0);
    expect(summary.body.data.ageing).toHaveLength(4);
    const customers = await owner.get('/outstanding/customers?pageSize=100');
    expect(customers.body.data.some((r: { customerId: string }) => r.customerId === c)).toBe(true);
    const row = customers.body.data.find((r: { customerId: string }) => r.customerId === c);
    expect(row.outstanding).toBe(100000);
    const invoices = await owner.get(`/outstanding/invoices?customerId=${c}`);
    expect(invoices.body.data).toHaveLength(1);
    expect(invoices.body.data[0]).toMatchObject({ balanceDue: 100000, bucket: 'd0_30' });

    // The same bill seen 45 and 100 days later moves into the older ageing buckets.
    const at45 = await owner.get(`/outstanding/invoices?customerId=${c}&asOf=${futureDate(45)}`);
    expect(at45.body.data[0]).toMatchObject({ bucket: 'd31_60', overdue: true });
    const at100 = await owner.get(`/outstanding/customers?asOf=${futureDate(100)}&pageSize=100`);
    expect(at100.body.data.find((r: { customerId: string }) => r.customerId === c).buckets).toMatchObject({ d0_30: 0, d90_plus: 100000 });
    const ageing = await owner.get(`/outstanding/summary?asOf=${futureDate(65)}`);
    expect(ageing.body.data.ageing.find((x: { key: string }) => x.key === 'd61_90').amount).toBeGreaterThanOrEqual(100000);
  });

  it('rate-limits reminders so customers are not spammed', async () => {
    const c = await createCustomer(t, 'Reminder Customer', '9811111111');
    await bill(c, [custom('Pending', 450000)]);
    const first = await owner.post('/outstanding/remind').send({ customerId: c });
    expect(first.status).toBe(200);
    expect(first.body.data.queued).toBeGreaterThan(0);
    const second = await owner.post('/outstanding/remind').send({ customerId: c });
    expect(second.status).toBe(429);
    expect(second.body.errorCode).toBe('RATE_LIMITED');
    const queued = await withSystem((tx) => tx.selectFrom('notifications').select('body').where('customerId', '=', c).where('eventType', '=', 'outstanding_reminder').execute());
    expect(queued[0]!.body).toContain('₹4,500');
  });
});

describe('financial data isolation', () => {
  it('hides bills, payments and ledgers from other salons and branches', async () => {
    const c = await createCustomer(t, 'Private Customer');
    const inv = await bill(c, [custom('Service', 100000)], { payments: [{ method: 'cash', amount: 40000 }] });
    const other = await createTenant('foe');
    const o = authed(other.owner.token);
    expect((await o.get(`/billing/invoices/${inv.body.data.id}`)).status).toBe(404);
    expect((await o.get(`/payments/${inv.body.data.payments[0].paymentId}`)).status).toBe(404);
    expect((await o.get(`/ledger?customerId=${c}`)).status).toBe(404);
    const crossTenantBill = await o.post('/billing/invoices').send({ branchId: other.branchId, customerId: c, lines: [custom('Cross tenant item', 100)] });
    expect(crossTenantBill.status).toBe(404);
    const crossPay = await o.post('/payments/collect').send({ branchId: t.branchId, customerId: c, amount: 100, method: 'cash' });
    expect(crossPay.status).toBe(403);
    expect((await o.get('/outstanding/customers')).body.data).toEqual([]);
  });
});
