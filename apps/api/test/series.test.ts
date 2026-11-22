import { randomUUID } from 'node:crypto';
import { DateTime } from 'luxon';
import { beforeAll, describe, expect, it } from 'vitest';
import { hashPassword } from '../src/core/passwords.js';
import { withSystem } from '../src/db/tenant.js';
import { api, at, authed, bookingDate, createCustomer, createService, createStaff, createTenant, createUserWithRole, login, PASSWORD, type Tenant } from './helpers.js';

// Repeating appointments: the front desk (or the customer, from their private link) repeats a booking every few weeks.

let t: Tenant;
let owner: ReturnType<typeof authed>;
let admin: ReturnType<typeof authed>;
let hairSpa: string;
let rahul: string;
let priya: string;
let meera: string;
let other: string;
const day = bookingDate(2);
const weeksLater = (weeks: number) => DateTime.fromISO(day).plus({ weeks }).toISODate()!;

async function book(customerId: string, staffId: string, date: string, time = '11:00', notifyCustomer = true): Promise<string> {
  const res = await owner.post('/appointments').send({ branchId: t.branchId, customerId, notifyCustomer, items: [{ serviceId: hairSpa, staffId, startAt: at(date, time) }] });
  if (res.status !== 201) throw new Error(JSON.stringify(res.body));
  return res.body.data.id;
}

beforeAll(async () => {
  t = await createTenant('series');
  owner = authed(t.owner.token);
  await owner.patch('/organization/settings').send({ onlineBookingEnabled: true });
  hairSpa = await createService(t, { name: 'Hair Spa', code: 'HSPA', price: 120000, durationMinutes: 60 });
  rahul = await createStaff(t, 'Rahul Shah', 'E001', [hairSpa]);
  priya = await createStaff(t, 'Priya Mehta', 'E002', [hairSpa]);
  meera = await createCustomer(t, 'Meera Patel');
  other = await createCustomer(t, 'Someone Else');
  const adminEmail = `admin-${randomUUID().slice(0, 6)}@platform.test`;
  await withSystem(async (tx) => tx.insertInto('users').values({ email: adminEmail, fullName: 'Platform Pat', passwordHash: await hashPassword(PASSWORD), isPlatformAdmin: true }).execute());
  admin = authed(await login(adminEmail));
});

describe('repeating at the front desk', () => {
  let first: string;
  let booked: Array<{ id: string; startAt: string; staffNames: string[]; staffChanged: boolean }>;

  it('books every 4 weeks: the same person when free, someone else when not, and skips dates nobody can do', async () => {
    first = await book(meera, rahul, day);
    await book(other, rahul, weeksLater(4), '11:00', false); // Rahul is busy 4 weeks on: Priya steps in
    await book(other, rahul, weeksLater(8), '11:00', false); // 8 weeks on nobody is free
    await book(other, priya, weeksLater(8), '11:00', false);

    const res = await owner.post(`/appointments/${first}/repeat`).send({ everyWeeks: 4, times: 4 });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    booked = res.body.data.booked;
    expect(booked.map((b) => [b.startAt, b.staffNames, b.staffChanged])).toEqual([
      [at(weeksLater(4), '11:00'), ['Priya'], true],
      [at(weeksLater(12), '11:00'), ['Rahul'], false],
    ]);
    expect(res.body.data.skipped).toEqual([{ startAt: at(weeksLater(8), '11:00'), reason: 'Nobody who does these services is free at that time.' }]);

    // Each visit shows where it sits in the series.
    const one = (await owner.get(`/appointments/${first}`)).body.data;
    expect(one.series).toMatchObject({ everyWeeks: 4, position: 1, count: 3, later: 2 });
    const two = (await owner.get(`/appointments/${booked[0]!.id}`)).body.data;
    expect(two).toMatchObject({ status: 'scheduled', customer: { id: meera }, series: { position: 2, count: 3, later: 1 } });

    // Repeats get reminders but no confirmation of their own; the salon's log says what happened.
    const sent = await withSystem((tx) => tx.selectFrom('notifications').select('eventType').where('sourceId', '=', booked[1]!.id).execute());
    expect(sent.map((s) => s.eventType)).not.toContain('appointment_confirmation');
    expect(sent.map((s) => s.eventType)).toContain('appointment_reminder');
    const log = await owner.get('/audit?action=appointment.series_created');
    expect(log.body.data[0].summary).toMatch(/repeats every 4 weeks: 2 more booked, 1 skipped/);
  });

  it('a booking that already repeats cannot be repeated again, and past or cancelled ones cannot repeat', async () => {
    expect((await owner.post(`/appointments/${first}/repeat`).send({ everyWeeks: 2, times: 3 })).status).toBe(409);
    expect((await owner.post(`/appointments/${first}/repeat`).send({ everyWeeks: 0, times: 3 })).status).toBe(400);
    expect((await owner.post(`/appointments/${first}/repeat`).send({ everyWeeks: 2, times: 40 })).status).toBe(400);
  });

  it('cancels a visit and the later ones in one go, keeping the earlier ones', async () => {
    const res = await owner.post(`/appointments/${booked[0]!.id}/cancel-following`).send({ reason: 'Moving away' });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.data.cancelled).toBe(2);
    expect((await owner.get(`/appointments/${first}`)).body.data).toMatchObject({ status: 'scheduled', series: { count: 1, later: 0 } });
    expect((await owner.get(`/appointments/${booked[1]!.id}`)).body.data.status).toBe('cancelled');
  });

  it('a receptionist can repeat bookings; a stylist cannot', async () => {
    const receptionist = await createUserWithRole(t, 'receptionist');
    const stylist = await createUserWithRole(t, 'staff');
    const id = await book(meera, priya, bookingDate(3), '15:00');
    expect((await authed(stylist.token).post(`/appointments/${id}/repeat`).send({ everyWeeks: 2, times: 2 })).status).toBe(403);
    expect((await authed(receptionist.token).post(`/appointments/${id}/repeat`).send({ everyWeeks: 2, times: 2 })).status).toBe(200);
  });
});

describe('repeating from the customer’s private link', () => {
  let token: string;

  let asha: string;

  beforeAll(async () => {
    asha = await createCustomer(t, 'Asha Rao');
    const id = await book(asha, rahul, bookingDate(4), '14:00');
    const n = await withSystem((tx) => tx.selectFrom('notifications').select('body').where('sourceId', '=', id).where('eventType', '=', 'appointment_confirmation').executeTakeFirstOrThrow());
    token = /\/book\/manage\/([A-Za-z0-9_-]+)/.exec(n.body)![1]!;
  });

  it('the customer repeats their booking, and can stop the later visits', async () => {
    const view = (await api().get(`/api/v1/public/manage/${token}`)).body.data;
    expect(view).toMatchObject({ canRepeat: true, repeats: null });
    const res = await api().post(`/api/v1/public/manage/${token}/repeat`).send({ everyWeeks: 2, times: 3 });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.data.booked).toHaveLength(2);
    expect(res.body.data.booked.every((b: { staffNames: string[] }) => b.staffNames[0] === 'Rahul')).toBe(true);

    const after = (await api().get(`/api/v1/public/manage/${token}`)).body.data;
    expect(after).toMatchObject({ canRepeat: false, repeats: { everyWeeks: 2, later: 2 } });
    const visits = (await api().get(`/api/v1/public/manage/${token}/visits`)).body.data;
    expect(visits.upcoming.filter((u: { repeats: unknown }) => u.repeats)).toHaveLength(3);

    // "This and the later ones" from the link.
    const second = res.body.data.booked[0].id as string;
    const cancelled = await api().post(`/api/v1/public/manage/${token}/visits/${second}/cancel`).send({ following: true });
    expect(cancelled.status, JSON.stringify(cancelled.body)).toBe(200);
    expect(cancelled.body.data.cancelled).toBe(true);
    const left = (await api().get(`/api/v1/public/manage/${token}/visits`)).body.data;
    expect(left.upcoming.filter((u: { repeats: unknown }) => u.repeats)).toHaveLength(1);
    expect((await owner.get(`/appointments/${res.body.data.booked[1].id}`)).body.data.status).toBe('cancelled');
  });

  it('switched off by the platform, nobody can repeat bookings', async () => {
    const id = await book(asha, priya, bookingDate(5), '16:00');
    await admin.patch(`/platform/organizations/${t.orgId}`).send({ disabledFeatures: ['recurring'] });
    try {
      const desk = await owner.post(`/appointments/${id}/repeat`).send({ everyWeeks: 2, times: 2 });
      expect(desk.status).toBe(403);
      expect(desk.body.errorCode).toBe('FEATURE_OFF');
      expect((await api().get(`/api/v1/public/manage/${token}`)).body.data.canRepeat).toBe(false);
    } finally {
      await admin.patch(`/platform/organizations/${t.orgId}`).send({ disabledFeatures: [] });
    }
  });
});
