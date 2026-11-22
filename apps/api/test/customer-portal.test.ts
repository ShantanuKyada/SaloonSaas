import { randomUUID } from 'node:crypto';
import { sql } from 'kysely';
import { beforeAll, describe, expect, it } from 'vitest';
import { sha256 } from '../src/core/crypto.js';
import { hashPassword } from '../src/core/passwords.js';
import { withSystem } from '../src/db/tenant.js';
import { api, at, authed, bookingDate, createCustomer, createService, createStaff, createTenant, createUserWithRole, login, PASSWORD, type Tenant } from './helpers.js';

// Customer self-service: every booking's private link opens that booking and the customer's other visits, with
// "Book again" for what they had before. The salon can be switched off from it by the platform.

let t: Tenant;
let owner: ReturnType<typeof authed>;
let admin: ReturnType<typeof authed>;
let hairSpa: string;
let beard: string;
let rahul: string;
let priya: string;
let meera: string;
let other: string;
let thisBooking: string;
let token: string;

const pub = (path: string) => `/api/v1/public/manage/${token}${path}`;

async function book(customerId: string, serviceId: string, staffId: string, date: string, time: string): Promise<string> {
  const res = await owner.post('/appointments').send({ branchId: t.branchId, customerId, notifyCustomer: true, items: [{ serviceId, staffId, startAt: at(date, time) }] });
  if (res.status !== 201) throw new Error(JSON.stringify(res.body));
  return res.body.data.id;
}

/** A visit some days ago: booked ahead, then moved back in time and closed (the API rightly refuses to book the past). */
async function pastVisit(customerId: string, serviceId: string, staffId: string, daysAgo: number, status: 'completed' | 'cancelled' | 'no_show' = 'completed', time = '10:00'): Promise<string> {
  const id = await book(customerId, serviceId, staffId, bookingDate(20), time);
  const days = 20 + daysAgo;
  const shift = sql.raw(`interval '${days} days'`);
  await withSystem(async (tx) => {
    await sql`update appointment_items set start_at = start_at - ${shift}, end_at = end_at - ${shift}, blocked_until = blocked_until - ${shift}, status = ${status === 'completed' ? 'completed' : 'cancelled'} where appointment_id = ${id}`.execute(tx);
    await sql`update appointments set start_at = start_at - ${shift}, end_at = end_at - ${shift}, local_date = local_date - ${days}::int, status = ${status} where id = ${id}`.execute(tx);
  });
  return id;
}

/** The private link that went out with a booking's confirmation message. */
async function linkFromMessage(appointmentId: string): Promise<string> {
  const n = await withSystem((tx) => tx.selectFrom('notifications').select('body').where('sourceId', '=', appointmentId).where('eventType', '=', 'appointment_confirmation').executeTakeFirstOrThrow());
  const m = /\/book\/manage\/([A-Za-z0-9_-]+)/.exec(n.body);
  if (!m) throw new Error(`no link in: ${n.body}`);
  return m[1]!;
}

beforeAll(async () => {
  t = await createTenant('portal');
  owner = authed(t.owner.token);
  await owner.patch('/organization/settings').send({ onlineBookingEnabled: true });
  hairSpa = await createService(t, { name: 'Hair Spa', code: 'HSPA', price: 120000, durationMinutes: 60 });
  beard = await createService(t, { name: 'Beard Trim', code: 'BRD', price: 30000, durationMinutes: 30 });
  rahul = await createStaff(t, 'Rahul Shah', 'E001', [hairSpa, beard]);
  priya = await createStaff(t, 'Priya Mehta', 'E002', [hairSpa, beard]);
  meera = await createCustomer(t, 'Meera Patel');
  other = await createCustomer(t, 'Someone Else');
  const adminEmail = `admin-${randomUUID().slice(0, 6)}@platform.test`;
  await withSystem(async (tx) => tx.insertInto('users').values({ email: adminEmail, fullName: 'Platform Pat', passwordHash: await hashPassword(PASSWORD), isPlatformAdmin: true }).execute());
  admin = authed(await login(adminEmail));

  // Meera's history: Hair Spa with Rahul twice (her usual), a beard trim with Priya, a cancelled visit and a no-show.
  await pastVisit(meera, hairSpa, rahul, 60, 'completed', '10:00');
  await pastVisit(meera, beard, priya, 45, 'completed', '10:00');
  await pastVisit(meera, hairSpa, rahul, 20, 'completed', '12:00');
  await pastVisit(meera, hairSpa, priya, 10, 'cancelled', '12:00');
  await pastVisit(other, hairSpa, rahul, 15, 'completed', '14:00'); // someone else's: never shown to Meera
  thisBooking = await book(meera, hairSpa, rahul, bookingDate(3), '11:00');
  token = await linkFromMessage(thisBooking);
});

const setFeatures = (disabledFeatures: string[]) => admin.patch(`/platform/organizations/${t.orgId}`).send({ disabledFeatures });

describe('the private link', () => {
  it('goes out with every booking confirmation, desk bookings too, and opens that booking', async () => {
    expect(token.length).toBeGreaterThan(30);
    const res = await api().get(pub(''));
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ customerName: 'Meera Patel', status: 'scheduled', canChange: true, canMove: true, selfService: true });
    // Only a hash is kept.
    const stored = await withSystem((tx) => tx.selectFrom('customerLinks').select(['tokenHash', 'lastUsedAt']).where('appointmentId', '=', thisBooking).execute());
    expect(stored.some((l) => l.tokenHash === sha256(token) && l.lastUsedAt)).toBe(true);
    expect(JSON.stringify(stored)).not.toContain(token);
  });

  it('shows the customer’s visits: what is coming up, what they had before, and their usual', async () => {
    const res = await api().get(pub('/visits'));
    expect(res.status).toBe(200);
    const v = res.body.data;
    expect(v.customerName).toBe('Meera Patel');
    expect(v.canBook).toBe(true);
    expect(v.upcoming).toHaveLength(1);
    expect(v.upcoming[0]).toMatchObject({ id: thisBooking, isThis: true, canChange: true, rebook: null });

    // Newest first; someone else's visit never appears; the cancelled one is history too.
    expect(v.past.map((p: { status: string }) => p.status)).toEqual(['cancelled', 'completed', 'completed', 'completed']);
    expect(v.past.every((p: { canChange: boolean }) => !p.canChange)).toBe(true);
    expect(v.past[1]).toMatchObject({ services: [expect.objectContaining({ name: 'Hair Spa', staffName: 'Rahul' })], rebook: { branchId: t.branchId, serviceIds: [hairSpa], staffId: rahul, staffName: 'Rahul' } });
    expect(v.past[2].rebook).toMatchObject({ serviceIds: [beard], staffId: priya });
    expect(JSON.stringify(v)).not.toContain('Someone Else');

    // Hair Spa with Rahul, twice: that is her usual.
    expect(v.usual).toMatchObject({ serviceIds: [hairSpa], staffId: rahul, staffName: 'Rahul', services: ['Hair Spa'], times: 2 });
  });

  it('books again for the same customer, same services and person, at a time that is free', async () => {
    const date = bookingDate(6);
    const again = { branchId: t.branchId, serviceIds: [hairSpa], staffId: rahul, startAt: at(date, '12:00') };
    const res = await api().post(pub('/book')).send(again);
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(res.body.data).toMatchObject({ customerName: 'Meera Patel', services: [expect.objectContaining({ name: 'Hair Spa', staffName: 'Rahul' })], manageLink: expect.stringContaining('/book/manage/') });

    // At the front desk it is Meera's online booking with Rahul; the time is now taken.
    const list = await owner.get(`/appointments?date=${date}&pageSize=50`);
    const made = list.body.data.find((a: { customer: { id: string } }) => a.customer.id === meera);
    expect(made).toMatchObject({ source: 'online', status: 'scheduled', items: [expect.objectContaining({ staffId: rahul })] });
    expect((await api().post(pub('/book')).send(again)).status).toBe(409);

    // And it now shows under "coming up".
    const v = (await api().get(pub('/visits'))).body.data;
    expect(v.upcoming.map((u: { id: string }) => u.id)).toContain(made.id);
  });

  it('moves or cancels the customer’s other bookings, never anyone else’s', async () => {
    const second = await book(meera, beard, priya, bookingDate(8), '15:00');
    const moved = await api().post(pub(`/visits/${second}/reschedule`)).send({ startAt: at(bookingDate(8), '16:00') });
    expect(moved.status, JSON.stringify(moved.body)).toBe(200);
    expect((await api().post(pub(`/visits/${second}/cancel`)).send({})).status).toBe(200);
    const after = await owner.get(`/appointments/${second}`);
    expect(after.body.data.status).toBe('cancelled');

    const theirs = await book(other, beard, rahul, bookingDate(8), '15:00');
    expect((await api().post(pub(`/visits/${theirs}/cancel`)).send({})).status).toBe(404);
    expect((await api().post(pub(`/visits/${theirs}/reschedule`)).send({ startAt: at(bookingDate(8), '17:00') })).status).toBe(404);
    expect((await api().post(pub('/visits/not-an-id/cancel')).send({})).status).toBe(404);
    expect((await owner.get(`/appointments/${theirs}`)).body.data.status).toBe('scheduled');
  });

  it('with online booking closed, offers no Book again and no moving', async () => {
    await owner.patch('/organization/settings').send({ onlineBookingEnabled: false });
    try {
      expect((await api().get(pub(''))).body.data.canMove).toBe(false);
      const v = (await api().get(pub('/visits'))).body.data;
      expect(v.canBook).toBe(false);
      expect(v.usual).toBeNull();
      expect(v.past.every((p: { rebook: unknown }) => p.rebook === null)).toBe(true);
      expect((await api().post(pub('/book')).send({ branchId: t.branchId, serviceIds: [hairSpa], startAt: at(bookingDate(9), '12:00') })).status).toBe(409);
      expect((await api().post(pub('/reschedule')).send({ startAt: at(bookingDate(3), '14:00') })).status).toBe(409);
    } finally {
      await owner.patch('/organization/settings').send({ onlineBookingEnabled: true });
    }
  });

  it('switched off by the platform: the link still opens its own booking, but nothing else', async () => {
    const second = await book(meera, beard, priya, bookingDate(9), '15:00');
    expect((await setFeatures(['customer_portal'])).status).toBe(200);
    try {
      const own = await api().get(pub(''));
      expect(own.status).toBe(200);
      expect(own.body.data.selfService).toBe(false);
      expect((await api().get(pub('/visits'))).status).toBe(403);
      expect((await api().post(pub('/book')).send({ branchId: t.branchId, serviceIds: [hairSpa], startAt: at(bookingDate(9), '12:00') })).status).toBe(403);
      expect((await api().post(pub(`/visits/${second}/cancel`)).send({})).status).toBe(403);
    } finally {
      await setFeatures([]);
    }
  });
});

describe('links from the front desk', () => {
  it('the desk can make a fresh link to send by hand, and it is logged', async () => {
    const res = await owner.post(`/appointments/${thisBooking}/customer-link`);
    expect(res.status).toBe(200);
    const fresh = (res.body.data.url as string).split('/').pop()!;
    expect(fresh).not.toBe(token);
    expect((await api().get(`/api/v1/public/manage/${fresh}`)).body.data.customerName).toBe('Meera Patel');
    const log = await owner.get('/audit?action=appointment.customer_link');
    expect(log.body.data[0].summary).toMatch(/private booking link for Meera Patel/);

    const stylist = await createUserWithRole(t, 'staff');
    expect((await authed(stylist.token).post(`/appointments/${thisBooking}/customer-link`)).status).toBe(403);
  });

  it('links expire, archived customers lose theirs, and links sent before this change keep working', async () => {
    const res = await owner.post(`/appointments/${thisBooking}/customer-link`);
    const fresh = (res.body.data.url as string).split('/').pop()!;
    await withSystem((tx) => tx.updateTable('customerLinks').set({ expiresAt: new Date(Date.now() - 1000) }).where('tokenHash', '=', sha256(fresh)).execute());
    const expired = await api().get(`/api/v1/public/manage/${fresh}`);
    expect(expired.status).toBe(404);
    expect(expired.body.message).toMatch(/expired/);

    const legacy = 'legacy-token-' + randomUUID();
    const old = await book(other, hairSpa, priya, bookingDate(10), '10:00');
    await withSystem((tx) => tx.updateTable('appointments').set({ manageTokenHash: sha256(legacy) }).where('id', '=', old).execute());
    expect((await api().get(`/api/v1/public/manage/${legacy}`)).body.data.customerName).toBe('Someone Else');

    expect((await owner.delete(`/customers/${other}`)).status).toBe(204);
    expect((await api().get(`/api/v1/public/manage/${legacy}`)).status).toBe(404);
  });
});
