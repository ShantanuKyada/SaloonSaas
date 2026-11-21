import { beforeAll, describe, expect, it } from 'vitest';
import { at, authed, bookingDate, createCustomer, createService, createStaff, createTenant, createUserWithRole, login, type Tenant } from './helpers.js';

let t: Tenant;
let owner: ReturnType<typeof authed>;
let hairSpa: string;
let rahul: string;
let neha: string;
let me: ReturnType<typeof authed>;
let desk: ReturnType<typeof authed>;
let customerId: string;

const book = async (staffId: string, date: string, time: string) => {
  const res = await owner.post('/appointments').send({ branchId: t.branchId, customerId, notifyCustomer: false, items: [{ serviceId: hairSpa, staffId, startAt: at(date, time) }] });
  if (res.status !== 201) throw new Error(`booking: ${JSON.stringify(res.body)}`);
  return res.body.data as { id: string; version: number; startAt: string; items: Array<{ id: string }> };
};

beforeAll(async () => {
  t = await createTenant('team');
  owner = authed(t.owner.token);
  hairSpa = await createService(t, { name: 'Hair Spa', code: 'HSPA', price: 120000, durationMinutes: 60 });
  rahul = await createStaff(t, 'Rahul Shah', 'E001', [hairSpa]);
  neha = await createStaff(t, 'Neha Patel', 'E002', [hairSpa]);
  const user = await createUserWithRole(t, 'staff', { name: 'Rahul Login' });
  await owner.patch(`/users/${user.id}`).send({ staffId: rahul });
  me = authed(await login(user.email)); // log in again so the new staff link is in the token
  desk = authed((await createUserWithRole(t, 'receptionist')).token);
  customerId = await createCustomer(t, 'Meera Patel');
});

describe('my schedule and attendance', () => {
  it('shows the next two weeks: working hours, days off and how many appointments each day', async () => {
    const date = bookingDate(3);
    await book(rahul, date, '11:00');
    const res = await me.get('/me/schedule');
    expect(res.status).toBe(200);
    expect(res.body.data.days).toHaveLength(14);
    const day = res.body.data.days.find((d: { date: string }) => d.date === date);
    expect(day).toMatchObject({ status: 'working', appointments: 1 });
    expect(day.hours[0].start).toMatch(/^\d{2}:\d{2}$/);
    expect((await me.get('/me/attendance')).status).toBe(200);
  });

  it('is only for logins linked to a team member', async () => {
    // Any login linked to a team member may use these pages (a manager who also takes clients, say); others are told
    // their login is not linked.
    const res = await desk.get('/me/schedule');
    expect(res.status).toBe(404);
    expect(res.body.message).toMatch(/not linked to a team member/);
    const unlinked = authed((await createUserWithRole(t, 'staff', { name: 'No Profile' })).token);
    expect((await unlinked.get('/me/schedule')).status).toBe(404);
  });
});

describe('leave requests', () => {
  it('asks, waits for a manager, and blocks the day once approved', async () => {
    const date = bookingDate(9);
    await book(rahul, date, '12:00');
    const asked = await me.post('/me/leaves').send({ leaveType: 'casual', startDate: date, endDate: date, reason: 'Family function' });
    expect(asked.status).toBe(201);
    expect(asked.body.data.leave).toMatchObject({ status: 'pending', staffId: rahul });
    expect(asked.body.data.bookings).toHaveLength(1); // the booking that would need someone else

    expect((await me.post('/me/leaves').send({ startDate: date, endDate: date })).status).toBe(409);
    expect((await me.patch(`/staff-leaves/${asked.body.data.leave.id}`).send({ status: 'approved' })).status).toBe(403);

    const approved = await owner.patch(`/staff-leaves/${asked.body.data.leave.id}`).send({ status: 'approved' });
    expect(approved.status).toBe(200);
    const schedule = await me.get(`/me/schedule?from=${date}&to=${date}`);
    expect(schedule.body.data.days[0]).toMatchObject({ status: 'leave', leaveType: 'casual' });
    const mine = await me.get('/me/leaves');
    expect(mine.body.data[0]).toMatchObject({ status: 'approved', decidedByName: 'Test Owner' });
  });

  it('can be withdrawn while it is still waiting, not after', async () => {
    const date = bookingDate(12);
    const asked = await me.post('/me/leaves').send({ startDate: date, endDate: date, halfDay: 'first_half' });
    const id = asked.body.data.leave.id as string;
    expect((await me.post(`/me/leaves/${id}/cancel`)).body.data.status).toBe('cancelled');
    expect((await me.post(`/me/leaves/${id}/cancel`)).status).toBe(409);
    expect((await me.post('/me/leaves').send({ startDate: bookingDate(-2), endDate: bookingDate(-2) })).status).toBe(400);
  });
});

describe('requests to move an appointment', () => {
  it('offers free times, and the front desk approves: the booking moves', async () => {
    const date = bookingDate(5);
    const appt = await book(rahul, date, '11:00');
    const slots = await me.get(`/me/appointments/${appt.id}/slots?date=${date}`);
    expect(slots.status).toBe(200);
    const target = at(date, '15:00');
    expect(slots.body.data.slots).toContain(target);

    const asked = await me.post('/me/change-requests').send({ appointmentId: appt.id, proposedStartAt: target, reason: 'Doctor appointment in the morning' });
    expect(asked.status).toBe(201);
    expect(asked.body.data).toMatchObject({ status: 'pending', staffName: 'Rahul', services: 'Hair Spa', customerName: 'Meera Patel' });
    expect((await me.post('/me/change-requests').send({ appointmentId: appt.id, proposedStartAt: at(date, '16:00') })).status).toBe(409);

    const waiting = await desk.get('/change-requests');
    expect(waiting.body.data.map((r: { id: string }) => r.id)).toContain(asked.body.data.id);
    expect((await me.post(`/change-requests/${asked.body.data.id}/approve`).send({})).status).toBe(403);

    const dash = await owner.get(`/dashboard/owner?from=${date}&to=${date}`);
    expect(dash.body.data.alerts.map((a: { id: string }) => a.id)).toContain('team-requests');

    const ok = await desk.post(`/change-requests/${asked.body.data.id}/approve`).send({ notifyCustomer: false });
    expect(ok.status).toBe(200);
    expect(ok.body.data).toMatchObject({ status: 'approved' });
    const moved = await owner.get(`/appointments/${appt.id}`);
    expect(moved.body.data).toMatchObject({ startAt: target, rescheduleCount: 1 });
    expect((await desk.post(`/change-requests/${asked.body.data.id}/decline`).send({})).status).toBe(409);
  });

  it('refuses a time they are not free, someone else’s booking, and a request overtaken by a change', async () => {
    const date = bookingDate(6);
    const appt = await book(rahul, date, '10:00');
    await book(rahul, date, '14:00');
    expect((await me.post('/me/change-requests').send({ appointmentId: appt.id, proposedStartAt: at(date, '14:00') })).status).toBe(422);

    const nehas = await book(neha, date, '10:00');
    expect((await me.get(`/me/appointments/${nehas.id}/slots?date=${date}`)).status).toBe(404);
    expect((await me.post('/me/change-requests').send({ appointmentId: nehas.id, proposedStartAt: at(date, '16:00') })).status).toBe(404);

    const asked = await me.post('/me/change-requests').send({ appointmentId: appt.id, proposedStartAt: at(date, '17:00') });
    expect(asked.status).toBe(201);
    // The front desk moves the booking another way meanwhile: the request is now out of date.
    const current = await owner.get(`/appointments/${appt.id}`);
    await owner.post(`/appointments/${appt.id}/move`).send({ version: current.body.data.version, itemId: current.body.data.items[0].id, startAt: at(date, '12:00'), notifyCustomer: false });
    const stale = await desk.post(`/change-requests/${asked.body.data.id}/approve`).send({});
    expect(stale.status).toBe(409);
    expect(stale.body.message).toMatch(/changed since the request/);
    const declined = await desk.post(`/change-requests/${asked.body.data.id}/decline`).send({ note: 'Already moved to 12:00' });
    expect(declined.body.data).toMatchObject({ status: 'declined', decisionNote: 'Already moved to 12:00' });
    const mine = await me.get('/me/change-requests');
    expect(mine.body.data.find((r: { id: string }) => r.id === asked.body.data.id)).toMatchObject({ status: 'declined' });
  });

  it('can be withdrawn before the front desk answers', async () => {
    const date = bookingDate(7);
    const appt = await book(rahul, date, '11:00');
    const asked = await me.post('/me/change-requests').send({ appointmentId: appt.id, proposedStartAt: at(date, '16:00') });
    expect((await me.post(`/me/change-requests/${asked.body.data.id}/cancel`)).body.data.status).toBe('cancelled');
    expect((await desk.post(`/change-requests/${asked.body.data.id}/approve`).send({})).status).toBe(409);
  });
});
