import { beforeAll, describe, expect, it } from 'vitest';
import { withSystem } from '../src/db/tenant.js';
import { at, authed, bookingDate, createCustomer, createService, createStaff, createTenant, createUserWithRole, login, type Tenant } from './helpers.js';

let t: Tenant;
let owner: ReturnType<typeof authed>;
let hairSpa: string;
let rahul: string;
let neha: string;
let me: ReturnType<typeof authed>;
let customerId: string;

type Feed = { unread: number; items: Array<{ id: string; kind: string; title: string; body: string | null; readAt: string | null }> };
const feed = async () => (await me.get('/me/notifications')).body.data as Feed;
const markAllRead = () => me.post('/me/notifications/read').send({});
const book = async (staffId: string, date: string, time: string) => {
  const res = await owner.post('/appointments').send({ branchId: t.branchId, customerId, notifyCustomer: false, items: [{ serviceId: hairSpa, staffId, startAt: at(date, time) }] });
  if (res.status !== 201) throw new Error(JSON.stringify(res.body));
  return res.body.data as { id: string; version: number; items: Array<{ id: string }> };
};
const staffMessages = (appointmentId: string) =>
  withSystem((tx) => tx.selectFrom('notifications').select(['staffId', 'channel', 'recipient', 'body', 'eventType']).where('sourceId', '=', appointmentId).where('eventType', '=', 'staff_new_booking').execute());

beforeAll(async () => {
  t = await createTenant('notes');
  owner = authed(t.owner.token);
  hairSpa = await createService(t, { name: 'Hair Spa', code: 'HSPA', price: 120000, durationMinutes: 60 });
  rahul = await createStaff(t, 'Rahul Shah', 'E001', [hairSpa]);
  neha = await createStaff(t, 'Neha Patel', 'E002', [hairSpa]);
  await withSystem((tx) => tx.updateTable('staff').set({ mobile: '+919812300099' }).where('id', '=', rahul).execute());
  const user = await createUserWithRole(t, 'staff', { name: 'Rahul Login' });
  await owner.patch(`/users/${user.id}`).send({ staffId: rahul });
  me = authed(await login(user.email));
  customerId = await createCustomer(t, 'Meera Patel');
});

describe('telling team members about their bookings', () => {
  it('a new booking shows in their feed and goes to their phone', async () => {
    const appt = await book(rahul, bookingDate(4), '11:00');
    const f = await feed();
    expect(f.unread).toBe(1);
    expect(f.items[0]).toMatchObject({ kind: 'booking_new', title: 'New booking: Meera Patel' });
    expect(f.items[0]!.body).toMatch(/^Hair Spa · \w{3} \d+ \w{3}, 11:00 AM$/);

    const sent = await staffMessages(appt.id);
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ staffId: rahul, channel: 'whatsapp', recipient: '+919812300099' });
    expect(sent[0]!.body).toMatch(/^Hi Rahul, new booking: Meera Patel for Hair Spa on .+ at 11:00 AM/);

    expect((await markAllRead()).body.data.marked).toBe(1);
    expect((await feed()).unread).toBe(0);
  });

  it('tells them when a booking moves, goes to someone else, or is cancelled', async () => {
    const date = bookingDate(5);
    const appt = await book(rahul, date, '10:00');
    await markAllRead();

    let current = (await owner.get(`/appointments/${appt.id}`)).body.data;
    await owner.post(`/appointments/${appt.id}/move`).send({ version: current.version, itemId: current.items[0].id, startAt: at(date, '15:00'), notifyCustomer: false });
    expect((await feed()).items[0]).toMatchObject({ kind: 'booking_moved', title: 'Booking moved: Meera Patel' });

    current = (await owner.get(`/appointments/${appt.id}`)).body.data;
    await owner.post(`/appointments/${appt.id}/move`).send({ version: current.version, itemId: current.items[0].id, startAt: at(date, '15:00'), staffId: neha, notifyCustomer: false });
    expect((await feed()).items[0]).toMatchObject({ kind: 'booking_removed', title: 'No longer with you: Meera Patel' });
    const nehaNotes = await withSystem((tx) => tx.selectFrom('staffNotifications').select(['kind']).where('staffId', '=', neha).where('appointmentId', '=', appt.id).execute());
    expect(nehaNotes.map((n) => n.kind)).toEqual(['booking_new']);

    const mine = await book(rahul, date, '18:00');
    const v = (await owner.get(`/appointments/${mine.id}`)).body.data.version;
    await owner.post(`/appointments/${mine.id}/status`).send({ status: 'cancelled', version: v, reason: 'Customer is unwell', notifyCustomer: false });
    expect((await feed()).items[0]).toMatchObject({ kind: 'booking_cancelled', title: 'Booking cancelled: Meera Patel' });
  });

  it('can be switched off for phones, while the feed keeps working', async () => {
    await owner.patch('/organization/settings').send({ notifyStaffOfBookings: false });
    const appt = await book(rahul, bookingDate(6), '12:00');
    expect(await staffMessages(appt.id)).toHaveLength(0);
    expect((await feed()).items[0]).toMatchObject({ kind: 'booking_new' });
    await owner.patch('/organization/settings').send({ notifyStaffOfBookings: true });
  });

  it('tells them the answer to their requests, once', async () => {
    const date = bookingDate(7);
    const appt = await book(rahul, date, '11:00');
    const desk = authed((await createUserWithRole(t, 'receptionist')).token);
    const asked = await me.post('/me/change-requests').send({ appointmentId: appt.id, proposedStartAt: at(date, '16:00') });
    expect(asked.status).toBe(201);
    await markAllRead();
    await desk.post(`/change-requests/${asked.body.data.id}/approve`).send({ notifyCustomer: false, note: 'Done, customer agreed' });
    const after = await feed();
    expect(after.unread).toBe(1); // "approved", not also "booking moved"
    expect(after.items[0]).toMatchObject({ kind: 'request_answered', body: 'Front desk: “Done, customer agreed”' });
    expect(after.items[0]!.title).toMatch(/^Approved: Meera Patel moved to .+ 4:00 PM$/);

    const leave = await me.post('/me/leaves').send({ startDate: bookingDate(20), endDate: bookingDate(20) });
    await owner.patch(`/staff-leaves/${leave.body.data.leave.id}`).send({ status: 'rejected' });
    expect((await feed()).items[0]).toMatchObject({ kind: 'leave_answered', title: expect.stringMatching(/^Leave declined: /) });
  });

  it('shows team messages in the message log under the team member’s name', async () => {
    const res = await owner.get('/notifications?eventType=staff_new_booking');
    expect(res.status).toBe(200);
    expect(res.body.data[0].customerName).toBe('Rahul (team)');
  });
});
