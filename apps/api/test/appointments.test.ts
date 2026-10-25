import { beforeAll, describe, expect, it } from 'vitest';
import { sql } from 'kysely';
import { at, authed, createBranch, createCustomer, createService, createStaff, createTenant, createUserWithRole, futureDate, type Tenant } from './helpers.js';
import { withSystem } from '../src/db/tenant.js';

let t: Tenant;
let owner: ReturnType<typeof authed>;
let hairSpa: string;
let facial: string;
let rahul: string;
let priya: string;
let customerId: string;
const date = futureDate(3);

const book = (body: Record<string, unknown>, token = () => t.owner.token) => authed(token()).post('/appointments').send({ branchId: t.branchId, notifyCustomer: true, ...body });
const item = (serviceId: string, staffId: string, time: string, extra: Record<string, unknown> = {}) => ({ serviceId, staffId, startAt: at(date, time), ...extra });

beforeAll(async () => {
  t = await createTenant('appt');
  owner = authed(t.owner.token);
  hairSpa = await createService(t, { name: 'Hair Spa', code: 'HSPA', price: 120000, durationMinutes: 60 });
  facial = await createService(t, { name: 'Facial', code: 'FACE', price: 80000, durationMinutes: 45, categoryName: 'Skin' });
  rahul = await createStaff(t, 'Rahul Shah', 'E001', [hairSpa]);
  priya = await createStaff(t, 'Priya Mehta', 'E002', [hairSpa, facial]);
  customerId = await createCustomer(t, 'Meera Patel', '9876543210');
});

describe('booking', () => {
  it('books an appointment, prices it and queues a confirmation without blocking', async () => {
    const res = await book({ customerId, items: [item(hairSpa, rahul, '11:00')] });
    expect(res.status).toBe(201);
    expect(res.body.data).toMatchObject({ status: 'scheduled', estimatedAmount: 120000, totalDurationMinutes: 60 });
    expect(res.body.data.bookingNumber).toMatch(/^BK\d{6}-\d{3}$/);
    expect(res.body.data.items[0]).toMatchObject({ staffName: 'Rahul', serviceName: 'Hair Spa' });

    const queued = await withSystem((tx) =>
      tx.selectFrom('notifications').select(['eventType', 'channel', 'status']).where('sourceId', '=', res.body.data.id).execute(),
    );
    expect(queued.some((n) => n.eventType === 'appointment_confirmation' && n.status === 'queued')).toBe(true);
  });

  it('rejects double booking of the same staff member with a helpful message', async () => {
    const res = await book({ customerId, items: [item(hairSpa, rahul, '11:30')] });
    expect(res.status).toBe(409);
    expect(res.body.errorCode).toBe('APPOINTMENT_CONFLICT');
    expect(res.body.message).toMatch(/Rahul is already booked/);
  });

  it('allows back-to-back bookings and a different staff member at the same time', async () => {
    expect((await book({ customerId, items: [item(hairSpa, rahul, '12:00')] })).status).toBe(201);
    expect((await book({ customerId, items: [item(hairSpa, priya, '11:00')] })).status).toBe(201);
  });

  it('lets exactly one of two simultaneous bookings win (concurrency)', async () => {
    const c2 = await createCustomer(t, 'Second Customer');
    const results = await Promise.all([
      book({ customerId, items: [item(hairSpa, rahul, '16:00')] }),
      book({ customerId: c2, items: [item(hairSpa, rahul, '16:00')] }),
      book({ customerId, items: [item(hairSpa, rahul, '16:15')] }),
    ]);
    const statuses = results.map((r) => r.status).sort();
    expect(statuses).toEqual([201, 409, 409]);
    const rows = await withSystem((tx) =>
      tx.selectFrom('appointmentItems').select(sql<number>`count(*)`.as('n')).where('staffId', '=', rahul).where('blocksSchedule', '=', true).where('startAt', '>=', new Date(at(date, '16:00'))).where('startAt', '<', new Date(at(date, '17:00'))).executeTakeFirstOrThrow(),
    );
    expect(Number(rows.n)).toBe(1);
  });

  it('refuses staff who are not qualified for the service', async () => {
    const res = await book({ customerId, items: [item(facial, rahul, '14:00')] });
    expect(res.status).toBe(422);
    expect(res.body.errorCode).toBe('STAFF_NOT_QUALIFIED');
  });

  it('refuses bookings outside opening hours unless a manager overrides', async () => {
    const early = await book({ customerId, items: [item(hairSpa, priya, '08:00')] });
    expect(early.status).toBe(422);
    expect(early.body.errorCode).toBe('OUTSIDE_WORKING_HOURS');
    const late = await book({ customerId, items: [item(hairSpa, priya, '19:30')] });
    expect(late.body.errorCode).toBe('OUTSIDE_WORKING_HOURS');
    const receptionist = await createUserWithRole(t, 'receptionist');
    const denied = await book({ customerId, allowOutsideHours: true, items: [item(hairSpa, priya, '08:00')] }, () => receptionist.token);
    expect(denied.status).toBe(403);
    const allowed = await book({ customerId, allowOutsideHours: true, items: [item(hairSpa, priya, '08:00')] });
    expect(allowed.status).toBe(201);
  });

  it('refuses bookings during staff leave', async () => {
    const leaveDate = futureDate(5);
    const leave = await owner.post('/staff-leaves').send({ staffId: priya, startDate: leaveDate, endDate: leaveDate });
    expect(leave.status).toBe(201);
    const res = await book({ customerId, items: [{ serviceId: facial, staffId: priya, startAt: at(leaveDate, '12:00') }] });
    expect(res.status).toBe(422);
    expect(res.body.errorCode).toBe('STAFF_ON_LEAVE');
  });

  it('supports multiple services in one booking and rejects overlap with itself', async () => {
    const ok = await book({ customerId, items: [item(hairSpa, priya, '14:00'), item(facial, priya, '15:00')] });
    expect(ok.status).toBe(201);
    expect(ok.body.data.totalDurationMinutes).toBe(105);
    expect(ok.body.data.estimatedAmount).toBe(200000);
    const overlap = await book({ customerId, items: [item(hairSpa, priya, '17:00'), item(facial, priya, '17:30')] });
    expect(overlap.status).toBe(409);
  });

  it('chains later services right after the previous one when no start time is given', async () => {
    const chained = await book({ customerId, items: [item(hairSpa, priya, '16:00'), { serviceId: facial, staffId: priya }] });
    expect(chained.status).toBe(201);
    expect(chained.body.data.items[0].startAt).toBe(at(date, '16:00'));
    expect(chained.body.data.items[1].startAt).toBe(at(date, '17:00'));
    const noStart = await book({ customerId, items: [{ serviceId: hairSpa, staffId: rahul }] });
    expect(noStart.status).toBe(400);
    expect(noStart.body.details.issues[0].path).toBe('items.0.startAt');
  });

  it('validates the request body with field-level messages', async () => {
    const res = await book({ customerId: 'not-a-uuid', items: [] });
    expect(res.status).toBe(400);
    expect(res.body.errorCode).toBe('VALIDATION_ERROR');
    expect(res.body.details.issues.length).toBeGreaterThan(0);
  });
});

describe('availability', () => {
  it('lists only qualified staff with plain-language status', async () => {
    const res = await owner.get(`/scheduling/availability?branchId=${t.branchId}&date=${date}&serviceIds=${facial}&startAt=${encodeURIComponent(at(date, '14:30'))}`);
    expect(res.status).toBe(200);
    const names = res.body.data.staff.map((s: { displayName: string }) => s.displayName);
    expect(names).toEqual(['Priya']); // Rahul is not qualified for Facial
    expect(res.body.data.staff[0].state).toBe('busy');
    expect(res.body.data.staff[0].label).toMatch(/Busy until/);
  });

  it('shows free slots and hides the ones that are taken', async () => {
    const res = await owner.get(`/scheduling/availability?branchId=${t.branchId}&date=${date}&serviceIds=${hairSpa}`);
    const rahulSlots: string[] = res.body.data.staff.find((s: { displayName: string }) => s.displayName === 'Rahul').slots;
    expect(rahulSlots).not.toContain(at(date, '11:00'));
    expect(rahulSlots).not.toContain(at(date, '11:30'));
    expect(rahulSlots).toContain(at(date, '10:00'));
    expect(rahulSlots).toContain(at(date, '13:00'));
  });

  it('reports on-leave staff', async () => {
    const leaveDate = futureDate(5);
    const res = await owner.get(`/scheduling/availability?branchId=${t.branchId}&date=${leaveDate}&serviceIds=${facial}`);
    expect(res.body.data.staff[0]).toMatchObject({ displayName: 'Priya', state: 'on_leave', slots: [] });
  });
});

describe('status, reschedule and cancel', () => {
  it('cancelling frees the slot, restoring re-checks it, and reminders are cancelled', async () => {
    const created = await book({ customerId, items: [item(hairSpa, rahul, '18:00')] });
    const id = created.body.data.id as string;
    const cancelled = await owner.post(`/appointments/${id}/status`).send({ status: 'cancelled', reason: 'Customer called' });
    expect(cancelled.status).toBe(200);
    expect(cancelled.body.data.status).toBe('cancelled');

    const rebooked = await book({ customerId, items: [item(hairSpa, rahul, '18:00')] });
    expect(rebooked.status).toBe(201);

    const restore = await owner.post(`/appointments/${id}/status`).send({ status: 'scheduled' });
    expect(restore.status).toBe(409);
    expect(restore.body.errorCode).toBe('APPOINTMENT_CONFLICT');

    const pendingReminders = await withSystem((tx) =>
      tx.selectFrom('notifications').select('status').where('sourceId', '=', id).where('eventType', '=', 'appointment_reminder').where('status', '=', 'queued').execute(),
    );
    expect(pendingReminders).toHaveLength(0);
  });

  it('walks through the normal service lifecycle and blocks invalid jumps', async () => {
    const created = await book({ customerId, items: [item(hairSpa, priya, '10:00')] });
    const id = created.body.data.id as string;
    const bad = await owner.post(`/appointments/${id}/status`).send({ status: 'completed' });
    expect(bad.status).toBe(409);
    expect(bad.body.errorCode).toBe('INVALID_STATUS_TRANSITION');
    for (const status of ['checked_in', 'in_service', 'completed']) {
      const res = await owner.post(`/appointments/${id}/status`).send({ status });
      expect(res.status).toBe(200);
      expect(res.body.data.status).toBe(status);
    }
    const events = await owner.get(`/appointments/${id}/events`);
    expect(events.body.data.map((e: { toStatus: string | null }) => e.toStatus).filter(Boolean)).toEqual(['scheduled', 'checked_in', 'in_service', 'completed']);
  });

  it('gives the team member’s time back when a service is completed, and refuses to undo it if that time was taken', async () => {
    const closer = await createStaff(t, 'Early Finisher', 'E-EF1', [hairSpa]);
    const created = await book({ customerId, items: [item(hairSpa, closer, '10:00')] });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    const id = created.body.data.id as string;
    expect((await book({ customerId, items: [item(hairSpa, closer, '10:15')] })).status).toBe(409);
    for (const status of ['checked_in', 'in_service', 'completed']) expect((await owner.post(`/appointments/${id}/status`).send({ status })).status).toBe(200);

    const next = await book({ customerId, items: [item(hairSpa, closer, '10:15')] });
    expect(next.status).toBe(201);

    const undo = await owner.post(`/appointments/${id}/status`).send({ status: 'in_service' });
    expect(undo.status).toBe(409);
    expect(undo.body.errorCode).toBe('APPOINTMENT_CONFLICT');
  });

  it('reschedules via drag-and-drop with version checking and validation', async () => {
    const created = await book({ customerId, items: [item(hairSpa, priya, '13:00')] });
    const id = created.body.data.id as string;
    const itemId = created.body.data.items[0].id as string;
    const version = created.body.data.version as number;

    const conflict = await owner.post(`/appointments/${id}/move`).send({ version, itemId, startAt: at(date, '11:30') });
    expect(conflict.status).toBe(409);
    expect(conflict.body.errorCode).toBe('APPOINTMENT_CONFLICT');

    const moved = await owner.post(`/appointments/${id}/move`).send({ version, itemId, startAt: at(date, '12:30') });
    expect(moved.status).toBe(200);
    expect(moved.body.data.rescheduleCount).toBe(1);
    expect(moved.body.data.items[0].startAt).toBe(at(date, '12:30'));

    const stale = await owner.post(`/appointments/${id}/move`).send({ version, itemId, startAt: at(date, '13:00') });
    expect(stale.status).toBe(409);
    expect(stale.body.errorCode).toBe('STALE_VERSION');
  });
});

describe('walk-ins', () => {
  it('registers a new customer as a walk-in, assigns staff and starts the service', async () => {
    const created = await authed(t.owner.token).post('/walkins').send({ branchId: t.branchId, newCustomer: { fullName: 'Walk In Customer', mobile: '9123456780' }, items: [{ serviceId: hairSpa }] });
    expect(created.status).toBe(201);
    expect(created.body.data).toMatchObject({ status: 'waiting', source: 'walk_in', walkInStage: 'waiting' });
    expect(created.body.data.queueNumber).toBeGreaterThan(0);
    expect(created.body.data.customer.fullName).toBe('Walk In Customer');
  });

  it('lets a walk-in leave the queue before being given a time, and return to it when restored', async () => {
    const created = await authed(t.owner.token).post('/walkins').send({ branchId: t.branchId, newCustomer: { fullName: 'Left The Queue', mobile: '9123456781' }, items: [{ serviceId: hairSpa }] });
    expect(created.status).toBe(201);
    const id = created.body.data.id as string;

    const cancelled = await authed(t.owner.token).post(`/appointments/${id}/status`).send({ status: 'cancelled', version: created.body.data.version, reason: 'Customer changed their mind', notifyCustomer: false });
    expect(cancelled.status).toBe(200);
    expect(cancelled.body.data).toMatchObject({ status: 'cancelled', startAt: null });

    const restored = await authed(t.owner.token).post(`/appointments/${id}/status`).send({ status: 'waiting', version: cancelled.body.data.version, notifyCustomer: false });
    expect(restored.status).toBe(200);
    expect(restored.body.data).toMatchObject({ status: 'waiting', walkInStage: 'waiting' });
  });

  it('refuses a duplicate mobile number and points to the existing customer', async () => {
    const res = await authed(t.owner.token).post('/customers').send({ fullName: 'Someone Else', mobile: '98765 43210' });
    expect(res.status).toBe(409);
    expect(res.body.errorCode).toBe('DUPLICATE_CUSTOMER');
    expect(res.body.details.existing.fullName).toBe('Meera Patel');
  });
});

describe('data isolation', () => {
  it('keeps one salon’s appointments invisible to another salon', async () => {
    const created = await book({ customerId, items: [item(hairSpa, priya, '18:30')] });
    const other = await createTenant('other');
    const res = await authed(other.owner.token).get(`/appointments/${created.body.data.id}`);
    expect(res.status).toBe(404);
    const list = await authed(other.owner.token).get('/appointments');
    expect(list.body.data).toEqual([]);
  });

  it('keeps one branch’s data away from users who are not assigned to it', async () => {
    const branchB = await createBranch(t, 'Second Branch', 'SEC');
    const recA = await createUserWithRole(t, 'receptionist', { branchIds: [t.branchId] });
    const denied = await authed(recA.token).get(`/appointments/calendar?branchId=${branchB}&from=${date}&to=${date}`);
    expect(denied.status).toBe(403);
    expect(denied.body.errorCode).toBe('BRANCH_ACCESS_DENIED');
    const book403 = await authed(recA.token).post('/appointments').send({ branchId: branchB, customerId, items: [item(hairSpa, priya, '12:00')] });
    expect(book403.status).toBe(403);
  });

  it('shows staff only their own appointments, with contact details masked', async () => {
    const staffUser = await createUserWithRole(t, 'staff', { name: 'Priya Login' });
    const link = await owner.patch(`/users/${staffUser.id}`).send({ staffId: priya });
    expect(link.status).toBe(200);
    // The principal cache has a short TTL; login again so the new staff link is visible immediately.
    const { login } = await import('./helpers.js');
    const token = await login(staffUser.email);
    const list = await authed(token).get('/appointments?pageSize=100');
    expect(list.status).toBe(200);
    expect(list.body.data.length).toBeGreaterThan(0);
    for (const a of list.body.data) {
      expect(a.items.some((i: { staffId: string }) => i.staffId === priya)).toBe(true);
      expect(a.customer.mobile).toMatch(/•/);
    }
    const customers = await authed(token).get('/customers');
    expect(customers.status).toBe(403);
    const ledger = await authed(token).get('/billing/invoices');
    expect([403, 404]).toContain(ledger.status);
  });
});
