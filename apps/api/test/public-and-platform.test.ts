import { beforeAll, describe, expect, it } from 'vitest';
import { withSystem } from '../src/db/tenant.js';
import { api, at, authed, createCustomer, createService, createStaff, createTenant, futureDate, login, PASSWORD, type Tenant } from './helpers.js';

let t: Tenant;
let owner: ReturnType<typeof authed>;
let hairSpa: string;
const date = futureDate(4);

beforeAll(async () => {
  t = await createTenant('pub');
  owner = authed(t.owner.token);
  hairSpa = await createService(t, { name: 'Hair Spa', code: 'HSPA', price: 120000, durationMinutes: 60 });
  await createStaff(t, 'Rahul Shah', 'E001', [hairSpa]);
});

describe('online booking', () => {
  it('is off until the owner turns it on', async () => {
    const res = await api().get(`/api/v1/public/${t.code}`);
    expect(res.status).toBe(404);
    await owner.patch('/organization/settings').send({ onlineBookingEnabled: true });
    const on = await api().get(`/api/v1/public/${t.code}`);
    expect(on.status).toBe(200);
    expect(on.body.data.services.map((s: { name: string }) => s.name)).toEqual(['Hair Spa']);
    expect(JSON.stringify(on.body)).not.toMatch(/organizationId|passwordHash/);
  });

  it('offers only valid times, books, and lets the customer reschedule and cancel from a private link', async () => {
    const times = await api().get(`/api/v1/public/${t.code}/availability?branchId=${t.branchId}&date=${date}&serviceIds=${hairSpa}`);
    expect(times.status).toBe(200);
    expect(times.body.data.slots.length).toBeGreaterThan(0);
    expect(times.body.data.staff[0]).not.toHaveProperty('price');
    const start = at(date, '11:00');
    expect(times.body.data.slots.map((s: { startAt: string }) => s.startAt)).toContain(start);

    const body = { branchId: t.branchId, serviceIds: [hairSpa], startAt: start, customer: { fullName: 'Online Olivia', mobile: '9811122233', email: 'olivia@example.test', marketingConsent: false } };
    const booked = await api().post(`/api/v1/public/${t.code}/bookings`).send(body);
    expect(booked.status).toBe(201);
    expect(booked.body.data).toMatchObject({ status: 'scheduled', salonName: expect.stringContaining('Salon'), customerName: 'Online Olivia', canChange: true });
    const token = booked.body.data.manageLink.split('/').pop() as string;
    expect(token.length).toBeGreaterThan(30);

    // The slot is gone for the next customer; the same slot cannot be double booked.
    const taken = await api().post(`/api/v1/public/${t.code}/bookings`).send({ ...body, customer: { ...body.customer, mobile: '9811122244', fullName: 'Late Larry' } });
    expect(taken.status).toBe(409);
    expect(taken.body.message).toMatch(/just taken/);

    // The booking appears at the front desk like any other, as an online booking, and a confirmation was queued.
    const list = await owner.get(`/appointments?date=${date}&pageSize=50`);
    const mine = list.body.data.find((a: { customer: { fullName: string } }) => a.customer.fullName === 'Online Olivia');
    expect(mine).toMatchObject({ source: 'online', status: 'scheduled' });
    const queued = await withSystem((tx) => tx.selectFrom('notifications').select('eventType').where('sourceId', '=', mine.id).execute());
    expect(queued.some((n) => n.eventType === 'appointment_confirmation')).toBe(true);

    const seen = await api().get(`/api/v1/public/manage/${token}`);
    expect(seen.status).toBe(200);
    expect(seen.body.data.services[0].name).toBe('Hair Spa');
    expect((await api().get('/api/v1/public/manage/not-a-real-token-value')).status).toBe(404);

    const moved = await api().post(`/api/v1/public/manage/${token}/reschedule`).send({ startAt: at(date, '14:00') });
    expect(moved.status).toBe(200);
    expect((await owner.get(`/appointments/${mine.id}`)).body.data.items[0].startAt).toBe(at(date, '14:00'));
    const conflict = await api().post(`/api/v1/public/manage/${token}/reschedule`).send({ startAt: at(date, '03:00') });
    expect(conflict.status).toBeGreaterThanOrEqual(409);

    const cancelled = await api().post(`/api/v1/public/manage/${token}/cancel`).send({});
    expect(cancelled.status).toBe(200);
    expect((await owner.get(`/appointments/${mine.id}`)).body.data.status).toBe('cancelled');
    expect((await api().post(`/api/v1/public/manage/${token}/cancel`).send({})).status).toBe(409);
  });

  it('reuses an existing customer by mobile instead of creating a duplicate, and rejects bots', async () => {
    const existing = await createCustomer(t, 'Existing Esha', '9822233344');
    const res = await api().post(`/api/v1/public/${t.code}/bookings`).send({ branchId: t.branchId, serviceIds: [hairSpa], startAt: at(date, '16:00'), customer: { fullName: 'Esha Typo', mobile: '98222 33344' } });
    expect(res.status).toBe(201);
    const customers = await owner.get('/customers?search=9822233344');
    expect(customers.body.data).toHaveLength(1);
    expect(customers.body.data[0].id).toBe(existing);
    const bot = await api().post(`/api/v1/public/${t.code}/bookings`).send({ branchId: t.branchId, serviceIds: [hairSpa], startAt: at(date, '17:00'), customer: { fullName: 'Bot', mobile: '9833344455' }, website: 'http://spam.example' });
    expect(bot.status).toBe(400);
  });

  it('does not let one salon’s link or code reach another salon', async () => {
    const other = await createTenant('pub2');
    const res = await api().post(`/api/v1/public/${other.code}/bookings`).send({ branchId: t.branchId, serviceIds: [hairSpa], startAt: at(date, '12:00'), customer: { fullName: 'Cross', mobile: '9844455566' } });
    expect([404]).toContain(res.status);
  });
});

describe('platform and platform safety', () => {
  it('serves OpenAPI documentation generated from the live routes', async () => {
    const res = await api().get('/api/openapi.json');
    expect(res.status).toBe(200);
    expect(res.body.openapi).toBe('3.1.0');
    const paths = Object.keys(res.body.paths);
    for (const p of ['/api/v1/auth/login', '/api/v1/appointments', '/api/v1/billing/invoices', '/api/v1/payments/collect', '/api/v1/reports/{key}', '/api/v1/public/{code}/bookings']) expect(paths).toContain(p);
    expect(res.body.paths['/api/v1/billing/invoices'].post.description).toMatch(/Requires any of/);
    expect(res.body.paths['/api/v1/appointments'].post.requestBody.content['application/json'].schema).toBeTruthy();
    expect((await api().get('/api/docs/')).status).toBe(200);
  });

  it('sets security headers, hides stack traces and returns one error shape', async () => {
    const res = await api().get('/api/v1/appointments');
    expect(res.status).toBe(401);
    expect(res.body).toMatchObject({ success: false, errorCode: 'UNAUTHENTICATED', details: {} });
    expect(res.body.requestId).toBeTruthy();
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['strict-transport-security']).toBeDefined();
    expect(res.headers['x-powered-by']).toBeUndefined();
    expect(res.headers['x-request-id']).toBe(res.body.requestId);
    const bad = await api().post('/api/v1/auth/login').set('Content-Type', 'application/json').send('{ not json');
    expect(bad.status).toBe(400);
    expect(JSON.stringify(bad.body)).not.toMatch(/at .*\.ts|node_modules/);
    expect((await api().get('/api/v1/nope')).body.errorCode).toBe('NOT_FOUND');
  });

  it('exposes health, readiness and metrics', async () => {
    expect((await api().get('/health')).body).toEqual({ status: 'ok' });
    expect((await api().get('/ready')).body).toEqual({ status: 'ready' });
    const metrics = await api().get('/metrics');
    expect(metrics.status).toBe(200);
    expect(metrics.text).toContain('http_requests_total');
    expect(metrics.text).toContain('appointment_conflicts_total');
  });

  it('locks accounts after repeated bad passwords and revokes sessions when refresh tokens are replayed', async () => {
    const victim = await createTenant('lock');
    for (let i = 0; i < 5; i += 1) {
      const res = await api().post('/api/v1/auth/login').send({ identifier: victim.owner.email, password: 'wrong-password-1' });
      expect(res.body.errorCode).toBe(i < 4 ? 'INVALID_CREDENTIALS' : 'ACCOUNT_LOCKED');
    }
    const locked = await api().post('/api/v1/auth/login').send({ identifier: victim.owner.email, password: PASSWORD });
    expect(locked.status).toBe(423);

    const fresh = await createTenant('rt');
    const first = await api().post('/api/v1/auth/login').send({ identifier: fresh.owner.email, password: PASSWORD });
    const cookie = first.headers['set-cookie']![0]!.split(';')[0]!;
    expect(first.headers['set-cookie']![0]).toMatch(/HttpOnly/i);
    expect(first.headers['set-cookie']![0]).toMatch(/SameSite=Strict/i);
    const noHeader = await api().post('/api/v1/auth/refresh').set('Cookie', cookie);
    expect(noHeader.status).toBe(403); // CSRF guard: custom header required
    const rotated = await api().post('/api/v1/auth/refresh').set('Cookie', cookie).set('X-Requested-With', 'salonos');
    expect(rotated.status).toBe(200);
    const newCookie = rotated.headers['set-cookie']![0]!.split(';')[0]!;
    // Replaying the old (already rotated) token is treated as theft: the whole session family is revoked.
    const replay = await api().post('/api/v1/auth/refresh').set('Cookie', cookie).set('X-Requested-With', 'salonos');
    expect(replay.status).toBe(401);
    const afterReplay = await api().post('/api/v1/auth/refresh').set('Cookie', newCookie).set('X-Requested-With', 'salonos');
    expect(afterReplay.status).toBe(401);
  });

  it('keeps platform administration away from salon users and creates fully isolated salons', async () => {
    const tenant = await createTenant('plat');
    expect((await authed(tenant.owner.token).get('/platform/organizations')).status).toBe(403);
    expect((await authed(tenant.owner.token).post('/platform/organizations').send({})).status).toBe(403);
    await withSystem((tx) => tx.insertInto('users').values({ email: 'root@platform.test', fullName: 'Root', passwordHash: 'x', isPlatformAdmin: true }).onConflict((oc) => oc.doNothing()).execute());
    const hash = (await import('../src/core/passwords.js')).hashPassword;
    await withSystem(async (tx) => tx.updateTable('users').set({ passwordHash: await hash(PASSWORD) }).where('email', '=', 'root@platform.test').execute());
    const admin = await login('root@platform.test');
    const ownerEmail = `new-${Date.now()}@glow.test`;
    const created = await authed(admin).post('/platform/organizations').send({ name: 'New Glow Salon', code: `glow-${Date.now().toString(36)}`, owner: { fullName: 'New Owner', email: ownerEmail, password: PASSWORD }, firstBranch: { name: 'Rajkot', code: 'RJT', city: 'Rajkot' } });
    expect(created.status).toBe(201);
    const list = await authed(admin).get('/platform/organizations?search=New Glow');
    expect(list.body.data[0]).toMatchObject({ name: 'New Glow Salon', branchCount: 1, userCount: 1, customerCount: 0 });
    // A platform admin has no salon context, so salon screens are closed to them.
    expect((await authed(admin).get('/customers')).status).toBe(403);

    // The new salon starts with working defaults and a usable owner login.
    const newOwner = await login(ownerEmail);
    expect((await authed(newOwner).get('/service-categories')).body.data.length).toBeGreaterThanOrEqual(9);
    expect((await authed(newOwner).get('/roles')).body.data.map((r: { key: string }) => r.key).sort()).toEqual(['branch_manager', 'owner', 'receptionist', 'staff']);

    // Suspending a salon locks everyone out of it straight away, including sessions that are already open.
    const org = list.body.data[0].id as string;
    expect((await authed(admin).patch(`/platform/organizations/${org}`).send({ status: 'suspended' })).status).toBe(200);
    expect((await authed(newOwner).get('/service-categories')).status).toBe(403);
    const relogin = await api().post('/api/v1/auth/login').send({ identifier: ownerEmail, password: PASSWORD });
    expect(relogin.status).toBe(403);
    expect(relogin.body.errorCode).toBe('ACCOUNT_DISABLED');
  });
});
