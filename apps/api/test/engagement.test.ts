import { createHmac } from 'node:crypto';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { withSystem } from '../src/db/tenant.js';
import { ConsoleProvider, ProviderError } from '../src/integrations/notifications/providers.js';
import { isPrivateAddress } from '../src/core/net.js';
import { decideAttendance } from '../src/modules/attendance/service.js';
import { dispatchDue } from '../src/modules/notifications/dispatcher.js';
import { api, at, authed, createCustomer, createService, createStaff, createTenant, futureDate, type Tenant } from './helpers.js';

let t: Tenant;
let owner: ReturnType<typeof authed>;
let hairSpa: string;
let rahul: string;
let priya: string;
let meera: string;
const date = futureDate(3);

const book = (customerId: string, staffId: string, time: string, extra: Record<string, unknown> = {}) =>
  owner.post('/appointments').send({ branchId: t.branchId, customerId, items: [{ serviceId: hairSpa, staffId, startAt: at(date, time) }], ...extra });
const notificationsFor = (sourceId: string) =>
  withSystem((tx) => tx.selectFrom('notifications').selectAll().where('sourceId', '=', sourceId).orderBy('createdAt').execute());

beforeAll(async () => {
  t = await createTenant('eng');
  owner = authed(t.owner.token);
  hairSpa = await createService(t, { name: 'Hair Spa', code: 'HSPA', price: 120000, durationMinutes: 60 });
  rahul = await createStaff(t, 'Rahul Shah', 'E001', [hairSpa]);
  priya = await createStaff(t, 'Priya Mehta', 'E002', [hairSpa]);
  meera = await createCustomer(t, 'Meera Patel', '9876543210');
  await owner.put(`/customers/${meera}`).send({ email: 'meera@example.test' });
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('appointment notifications', () => {
  it('queues a confirmation per channel and the reminders the owner configured', async () => {
    const res = await book(meera, rahul, '11:00');
    expect(res.status).toBe(201);
    const rows = await notificationsFor(res.body.data.id);
    const confirmations = rows.filter((n) => n.eventType === 'appointment_confirmation');
    expect(confirmations.map((n) => n.channel).sort()).toEqual(['email', 'whatsapp']);
    expect(confirmations.find((n) => n.channel === 'whatsapp')!.body).toMatch(/Hair Spa/);
    expect(confirmations.find((n) => n.channel === 'whatsapp')!.body).toMatch(/Rahul/);
    const reminders = rows.filter((n) => n.eventType === 'appointment_reminder' && n.channel === 'whatsapp');
    expect(reminders).toHaveLength(2); // default: 24 h and 2 h before
    const start = new Date(at(date, '11:00')).getTime();
    expect(reminders.map((n) => start - n.scheduledFor.getTime()).sort((a, b) => a - b)).toEqual([2 * 3600_000, 24 * 3600_000]);
  });

  it('does not message a customer who opted out of a channel or of offers', async () => {
    const c = await createCustomer(t, 'Opted Out', '9123400001');
    await owner.put(`/customers/${c}/preferences`).send({ preferences: [{ channel: 'whatsapp', category: 'appointment', enabled: false }] });
    const res = await book(c, priya, '12:00');
    const rows = await notificationsFor(res.body.data.id);
    // Opting out of WhatsApp must not silently escalate to SMS; the customer simply gets nothing until they choose a channel.
    expect(rows.filter((n) => n.eventType === 'appointment_confirmation')).toHaveLength(0);
    await owner.put(`/customers/${c}/preferences`).send({ preferences: [{ channel: 'whatsapp', category: 'appointment', enabled: false }, { channel: 'sms', category: 'appointment', enabled: true }] });
    const second = await book(c, rahul, '13:00');
    expect((await notificationsFor(second.body.data.id)).filter((n) => n.eventType === 'appointment_confirmation').map((n) => n.channel)).toEqual(['sms']);
    const noConsent = await owner.post('/campaigns').send({ name: 'Diwali', channel: 'whatsapp', body: 'Hi {{customerName}}, 20% off this week!', segmentFilter: {} });
    expect(noConsent.body.data.recipientsCount).toBe(0);
  });

  it('never queues the same message twice', async () => {
    const res = await book(meera, priya, '14:00');
    const before = await notificationsFor(res.body.data.id);
    await owner.post(`/appointments/${res.body.data.id}/status`).send({ status: 'confirmed' });
    await owner.post(`/appointments/${res.body.data.id}/status`).send({ status: 'scheduled' });
    const after = await notificationsFor(res.body.data.id);
    expect(after.filter((n) => n.eventType === 'appointment_confirmation')).toHaveLength(before.filter((n) => n.eventType === 'appointment_confirmation').length);
  });

  it('cancels pending reminders and tells the customer when a booking is cancelled', async () => {
    const res = await book(meera, rahul, '15:00');
    const id = res.body.data.id as string;
    await owner.post(`/appointments/${id}/status`).send({ status: 'cancelled', reason: 'Called to cancel' });
    const rows = await notificationsFor(id);
    expect(rows.filter((n) => n.eventType === 'appointment_reminder').every((n) => n.status === 'cancelled')).toBe(true);
    expect(rows.some((n) => n.eventType === 'appointment_cancellation' && n.channel === 'whatsapp')).toBe(true);
  });

  it('skips the customer message when the receptionist chooses not to notify', async () => {
    const res = await book(meera, rahul, '16:00', { notifyCustomer: false });
    const rows = await notificationsFor(res.body.data.id);
    expect(rows.filter((n) => n.eventType === 'appointment_confirmation')).toHaveLength(0);
    expect(rows.filter((n) => n.eventType === 'appointment_reminder').length).toBeGreaterThan(0);
  });
});

describe('notification failures never break the business', () => {
  it('keeps the appointment when WhatsApp is down, retries with backoff, then gives up', async () => {
    const send = vi.spyOn(ConsoleProvider.prototype, 'send').mockRejectedValue(new ProviderError('WhatsApp API unavailable (503)', true));
    const res = await book(meera, rahul, '17:00');
    expect(res.status).toBe(201); // the booking exists even though nothing can be delivered
    const id = res.body.data.id as string;
    const appt = await owner.get(`/appointments/${id}`);
    expect(appt.body.data.status).toBe('scheduled');

    // Isolate this booking's messages from earlier tests so the batch only contains what we assert on.
    await withSystem((tx) => tx.updateTable('notifications').set({ status: 'cancelled' }).where('status', '=', 'queued').where('sourceId', '!=', id).execute());

    const first = await dispatchDue(50);
    expect(first.claimed).toBeGreaterThan(0);
    expect(first.sent).toBe(0);
    expect(first.retried).toBe(first.claimed);
    let rows = await notificationsFor(id);
    const confirmation = rows.find((n) => n.eventType === 'appointment_confirmation' && n.channel === 'whatsapp')!;
    expect(confirmation).toMatchObject({ status: 'queued', attempts: 1 });
    expect(confirmation.lastError).toMatch(/503/);
    expect(confirmation.nextAttemptAt.getTime()).toBeGreaterThan(Date.now()); // backoff: not retried immediately
    expect((await dispatchDue(50)).claimed).toBe(0);

    // Fast-forward the clock for this message and keep failing until the attempt limit.
    for (let attempt = 2; attempt <= 5; attempt += 1) {
      await withSystem((tx) => tx.updateTable('notifications').set({ nextAttemptAt: new Date() }).where('id', '=', confirmation.id).execute());
      await dispatchDue(50);
    }
    rows = await notificationsFor(id);
    expect(rows.find((n) => n.id === confirmation.id)).toMatchObject({ status: 'failed', attempts: 5 });
    expect(send).toHaveBeenCalled();

    // After the outage a manager can retry from the delivery log.
    vi.restoreAllMocks();
    const retry = await owner.post(`/notifications/${confirmation.id}/retry`);
    expect(retry.status).toBe(200);
    await dispatchDue(50);
    expect((await notificationsFor(id)).find((n) => n.id === confirmation.id)!.status).toBe('sent');
  });

  it('does not retry permanent failures such as an invalid number', async () => {
    vi.spyOn(ConsoleProvider.prototype, 'send').mockRejectedValue(new ProviderError('Recipient is not a WhatsApp user', false));
    const res = await book(meera, priya, '18:00');
    await withSystem((tx) => tx.updateTable('notifications').set({ status: 'cancelled' }).where('status', '=', 'queued').where('sourceId', '!=', res.body.data.id).execute());
    await dispatchDue(50);
    const rows = await notificationsFor(res.body.data.id);
    const failed = rows.find((n) => n.eventType === 'appointment_confirmation' && n.channel === 'whatsapp')!;
    expect(failed).toMatchObject({ status: 'failed', attempts: 1 });
    const log = await owner.get('/notifications?status=failed');
    expect(log.body.data.some((n: { id: string }) => n.id === failed.id)).toBe(true);
  });

  it('re-checks consent at send time', async () => {
    const c = await createCustomer(t, 'Changes Mind', '9123400002');
    await owner.put(`/customers/${c}/preferences`).send({ marketingConsent: true, preferences: [] });
    const campaign = await owner.post('/campaigns').send({ name: 'Offer', channel: 'whatsapp', body: 'Hi {{customerName}}, a gift for you!', segmentFilter: {} });
    expect(campaign.body.data.recipientsCount).toBeGreaterThan(0);
    const sent = await owner.post(`/campaigns/${campaign.body.data.id}/send`);
    expect(sent.status).toBe(200);
    await owner.put(`/customers/${c}/preferences`).send({ marketingConsent: false, preferences: [] });
    await dispatchDue(200);
    const rows = await withSystem((tx) => tx.selectFrom('notifications').select(['status', 'statusReason']).where('customerId', '=', c).where('campaignId', '=', campaign.body.data.id).execute());
    expect(rows[0]).toMatchObject({ status: 'skipped', statusReason: 'Customer withdrew marketing consent' });
  });
});

describe('templates', () => {
  it('previews with sample data and rejects unknown placeholders', async () => {
    const list = await owner.get('/notification-templates');
    expect(list.body.data.length).toBe(27); // 9 events × 3 channels
    const wa = list.body.data.find((x: { eventType: string; channel: string }) => x.eventType === 'appointment_confirmation' && x.channel === 'whatsapp');
    const bad = await owner.put(`/notification-templates/${wa.id}`).send({ body: 'Hi {{customerName}} {{creditCardNumber}}', isActive: true });
    expect(bad.status).toBe(400);
    expect(bad.body.message).toMatch(/creditCardNumber/);
    const preview = await owner.post('/notification-templates/preview').send({ eventType: 'appointment_confirmation', body: 'Hi {{customerName}}, see you {{date}} at {{time}}' });
    expect(preview.body.data.body).toBe('Hi Meera, see you Sat, 15 October at 5:00 PM');
    const ok = await owner.put(`/notification-templates/${wa.id}`).send({ body: 'Hello {{customerName}}! {{services}} with {{staff}} on {{date}}.', isActive: true });
    expect(ok.status).toBe(200);
  });
});

describe('attendance integration', () => {
  it('decides present, late, absent, missing punch, leave and holiday', () => {
    const H = 3600_000;
    const day = 10 * H; // shift 10:00–19:00 on an arbitrary scale
    const sched = { start: day, end: day + 9 * H };
    const base = { date: 'x', scheduled: sched, holiday: false, leaveFull: false };
    const after = day + 30 * H;
    expect(decideAttendance({ ...base, now: after, punches: [day - 0.1 * H, day + 9.5 * H] }).status).toBe('present');
    expect(decideAttendance({ ...base, now: after, punches: [day + 0.5 * H, day + 9 * H] })).toMatchObject({ status: 'late', lateMinutes: 30 });
    expect(decideAttendance({ ...base, now: after, punches: [] }).status).toBe('absent');
    expect(decideAttendance({ ...base, now: after, punches: [day] }).status).toBe('missing_punch');
    expect(decideAttendance({ ...base, now: after, punches: [day, day + 3 * H] }).status).toBe('half_day');
    expect(decideAttendance({ ...base, now: day + 0.2 * H, punches: [] }).status).toBe('not_started');
    expect(decideAttendance({ ...base, now: day + 3 * H, punches: [day + 0.1 * H] }).status).toBe('present');
    expect(decideAttendance({ ...base, now: after, punches: [], leaveFull: true }).status).toBe('on_leave');
    expect(decideAttendance({ ...base, now: after, punches: [], holiday: true }).status).toBe('holiday');
    expect(decideAttendance({ ...base, now: after, punches: [], scheduled: null }).status).toBe('weekly_off');
  });

  it('computes attendance from signed device pushes, flags unmapped IDs, and rejects bad signatures', async () => {
    const punchStaff = await createStaff(t, 'Lena Late', 'E010', [hairSpa]);
    const punchOk = await createStaff(t, 'Omar Ontime', 'E011', [hairSpa]);
    const punchMissing = await createStaff(t, 'Mia Missing', 'E012', [hairSpa]);
    await createStaff(t, 'Abe Absent', 'E013', [hairSpa]);
    for (const [id, punchId] of [[punchStaff, '501'], [punchOk, '502'], [punchMissing, '503']] as const) {
      const r = await owner.get(`/staff/${id}`);
      const s = r.body.data;
      const put = await owner.put(`/staff/${id}`).send({ branchId: s.branchId, employeeCode: s.employeeCode, fullName: s.fullName, displayName: s.displayName, biometricPunchId: punchId, expertiseIds: [] });
      expect(put.status).toBe(200);
    }
    const integration = await owner.post('/integrations').send({ kind: 'biometric', provider: 'push_webhook', displayName: 'Front door device', config: {} });
    expect(integration.status).toBe(201);
    const secret = integration.body.data.webhookSecretOnce as string;
    expect(secret).toBeTruthy();
    expect(JSON.stringify(integration.body.data.secretKeys)).not.toContain(secret);

    const yesterday = futureDate(-1);
    const payload = JSON.stringify({
      punches: [
        { externalId: 'p1', punchId: '501', punchedAt: at(yesterday, '10:40'), direction: 'in' },
        { externalId: 'p2', punchId: '501', punchedAt: at(yesterday, '19:05'), direction: 'out' },
        { externalId: 'p3', punchId: '502', punchedAt: at(yesterday, '09:55'), direction: 'in' },
        { externalId: 'p4', punchId: '502', punchedAt: at(yesterday, '19:30'), direction: 'out' },
        { externalId: 'p5', punchId: '503', punchedAt: at(yesterday, '10:00'), direction: 'in' },
        { externalId: 'p6', punchId: '999', punchedAt: at(yesterday, '10:00'), direction: 'in' },
      ],
    });
    const hook = `/api/v1/webhooks/biometric/${integration.body.data.id}`;
    const bad = await api().post(hook).set('Content-Type', 'application/json').set('X-Signature', 'sha256=deadbeef').send(payload);
    expect(bad.status).toBe(401);
    const sig = createHmac('sha256', secret).update(payload).digest('hex');
    const good = await api().post(hook).set('Content-Type', 'application/json').set('X-Signature', `sha256=${sig}`).send(payload);
    expect(good.status).toBe(200);
    expect(good.body.data).toMatchObject({ received: 6, inserted: 6, unmapped: 1 });
    const again = await api().post(hook).set('Content-Type', 'application/json').set('X-Signature', `sha256=${sig}`).send(payload);
    expect(again.body.data.inserted).toBe(0); // idempotent: re-sending never duplicates

    const history = await owner.get(`/attendance?from=${yesterday}&to=${yesterday}`);
    const byName = Object.fromEntries(history.body.data.map((r: { staffName: string; status: string }) => [r.staffName, r]));
    expect(byName.Omar).toMatchObject({ status: 'present', lateMinutes: 0 });
    expect(byName.Lena).toMatchObject({ status: 'late', lateMinutes: 40 });
    expect(byName.Mia.status).toBe('missing_punch');
    expect(byName.Abe.status).toBe('absent');
    expect(byName.Omar.workedMinutes).toBeGreaterThan(9 * 60);
    const unmapped = await owner.get('/attendance/punches/unmapped');
    expect(unmapped.body.data).toEqual([expect.objectContaining({ punchId: '999', punches: 1 })]);

    // Mapping the ID later attaches the earlier punch.
    await owner.post('/attendance/sync');
    const day = await owner.get(`/attendance/day?branchId=${t.branchId}`);
    expect(day.body.data.tracked).toBe(true);
    expect(day.body.data.summary).toHaveProperty('absent');
  });

  it('keeps everything else working when the device service is down', async () => {
    const integration = await owner.post('/integrations').send({ kind: 'biometric', provider: 'generic_http', displayName: 'Cloud devices', config: { apiUrl: 'http://127.0.0.1:9/punches' } });
    expect(integration.status).toBe(201);
    const sync = await owner.post('/attendance/sync');
    expect(sync.status).toBe(200); // the failure is reported, not thrown
    expect(sync.body.data.anyFailed).toBe(true);
    expect(sync.body.data.results.find((r: { displayName: string }) => r.displayName === 'Cloud devices').error).toMatch(/could not be reached/);
    const list = await owner.get('/integrations');
    expect(list.body.data.items.find((i: { id: string }) => i.id === integration.body.data.id)).toMatchObject({ status: 'error' });
    // Booking, billing and the calendar are unaffected.
    expect((await book(meera, rahul, '19:00')).status).toBe(201);
    expect((await owner.get(`/appointments/calendar?branchId=${t.branchId}&from=${date}&to=${date}`)).status).toBe(200);
    expect((await owner.get(`/attendance/day?branchId=${t.branchId}`)).status).toBe(200);
  });

  it('never returns saved secrets and blocks private network addresses', async () => {
    const res = await owner.post('/integrations').send({ kind: 'sms', provider: 'http', displayName: 'SMS gateway', config: { apiUrl: 'https://sms.example.test/send' }, secrets: { apiKey: 'super-secret-key-123' } });
    expect(res.status).toBe(201);
    expect(JSON.stringify(res.body)).not.toContain('super-secret-key-123');
    expect(res.body.data.secretKeys).toEqual(['apiKey']);
    const list = await owner.get('/integrations');
    expect(JSON.stringify(list.body)).not.toContain('super-secret-key-123');
    const missing = await owner.post('/integrations').send({ kind: 'sms', provider: 'http', displayName: 'No key', config: { apiUrl: 'https://sms.example.test/send' } });
    expect(missing.status).toBe(400);
    for (const ip of ['127.0.0.1', '10.1.2.3', '172.16.0.9', '192.168.1.1', '169.254.169.254', '::1', 'fd00::1', '::ffff:10.0.0.1']) expect(isPrivateAddress(ip)).toBe(true);
    for (const ip of ['8.8.8.8', '203.0.113.9', '2606:4700::1111']) expect(isPrivateAddress(ip)).toBe(false);
  });
});
