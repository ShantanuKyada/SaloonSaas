// Demo data for "Glow Salon Group" (Rajkot + Ahmedabad). Run with: npm run db:seed
//
// The seed drives the real HTTP API in-process, with a controllable clock, so every bill, payment, ledger entry,
// appointment and attendance record is produced by the same business rules as production. Database-default timestamps
// are then moved to the historical moment (the only non-API step, done with a superuser connection).
//
// Safe to run on a fresh database only. Use `npm run db:reset` first to start over.

// Demo data has well-known passwords: never put it into a production environment.
if (process.env.NODE_ENV === 'production') {
  console.error('Refusing to seed demo data when NODE_ENV=production.');
  process.exit(1);
}

// Seeding makes thousands of requests: relax rate limits (they are off in "test" mode) and keep tokens valid for the run.
process.env.NODE_ENV = 'test';
process.env.ACCESS_TOKEN_TTL_SECONDS = '3600';
process.env.LOG_LEVEL = 'silent';

import { createHmac } from 'node:crypto';
import { DateTime } from 'luxon';
import pg from 'pg';
import supertest from 'supertest';
import { BRANCHES, DEMO_PASSWORD, EXPERTISE, FIRST_NAMES_F, FIRST_NAMES_M, rng, SERVICES, STAFF, SURNAMES } from './data.js';
import { installClock, realNow, resetClock, setClock, withRealClock } from './clock.js';

const { createApp } = await import('../app.js');
const { env } = await import('../config/env.js');
const { hashPassword } = await import('../core/passwords.js');
const { withSystem } = await import('../db/tenant.js');
const { closeDb } = await import('../db/pool.js');
const { refreshCustomerStats } = await import('../modules/customers/service.js');

installClock();
const app = createApp();
const TZ = 'Asia/Kolkata';
const random = rng(20261023);

type Res = supertest.Response;
const client = (token: string) => ({
  get: (u: string) => supertest(app).get(`/api/v1${u}`).set('Authorization', `Bearer ${token}`),
  post: (u: string) => supertest(app).post(`/api/v1${u}`).set('Authorization', `Bearer ${token}`),
  put: (u: string) => supertest(app).put(`/api/v1${u}`).set('Authorization', `Bearer ${token}`),
  patch: (u: string) => supertest(app).patch(`/api/v1${u}`).set('Authorization', `Bearer ${token}`),
});
function must(res: Res, label: string): Res {
  if (res.status >= 400) throw new Error(`${label} failed (${res.status}): ${JSON.stringify(res.body).slice(0, 400)}`);
  return res;
}
// Tokens are issued with real time so they stay valid however far the fake clock travels.
async function login(identifier: string): Promise<string> {
  return withRealClock(async () => {
    const res = must(await supertest(app).post('/api/v1/auth/login').send({ identifier, password: DEMO_PASSWORD }), `login ${identifier}`);
    return res.body.data.accessToken as string;
  });
}
const log = (m: string) => console.log(`• ${m}`);

// ───────────── Backdating (superuser, triggers off) ─────────────
if (!env.DATABASE_SUPERUSER_URL) {
  console.error('DATABASE_SUPERUSER_URL is required: the seed uses it to place records at their historical dates.');
  process.exit(1);
}
const superUrl = new URL(env.DATABASE_SUPERUSER_URL);
superUrl.pathname = new URL(env.DATABASE_URL).pathname;
const admin = new pg.Client({ connectionString: superUrl.toString() });
await admin.connect();
await admin.query('set session_replication_role = replica');
const TS: Array<[string, string[], string]> = [
  ['customers', ['registered_at', 'created_at', 'updated_at'], 'created_at'],
  ['consent_events', ['recorded_at'], 'recorded_at'],
  ['appointments', ['created_at', 'updated_at'], 'created_at'],
  ['appointment_items', ['created_at', 'updated_at'], 'created_at'],
  ['appointment_events', ['created_at'], 'created_at'],
  ['invoices', ['issued_at', 'created_at', 'updated_at'], 'created_at'],
  ['invoice_items', ['created_at'], 'created_at'],
  ['payments', ['received_at', 'created_at', 'updated_at'], 'created_at'],
  ['payment_allocations', ['created_at'], 'created_at'],
  ['ledger_entries', ['occurred_at', 'created_at'], 'created_at'],
  ['customer_packages', ['purchased_at', 'created_at', 'updated_at'], 'created_at'],
  ['package_redemptions', ['redeemed_at'], 'redeemed_at'],
  ['offer_redemptions', ['redeemed_at'], 'redeemed_at'],
  ['audit_logs', ['created_at'], 'created_at'],
];
async function backdate(to: DateTime, since: Date): Promise<void> {
  for (const [table, columns, filter] of TS) {
    await admin.query(`update ${table} set ${columns.map((c) => `${c} = $1`).join(', ')} where ${filter} >= $2`, [to.toJSDate(), since]);
  }
  // Historical messages were "delivered" long ago: never leave them queued for the worker to send now.
  await admin.query(
    `update notifications set status = case when random() < 0.93 then 'delivered' else 'failed' end, created_at = $1, updated_at = $1,
            sent_at = $1, delivered_at = $1, scheduled_for = $1, failed_at = null, last_error = null
      where created_at >= $2 and scheduled_for < now() + interval '1 minute'`,
    [to.toJSDate(), since],
  );
  await admin.query(`update notifications set status = 'failed', failed_at = created_at, last_error = 'WhatsApp API unavailable (503)', delivered_at = null where status = 'failed' and failed_at is null and created_at = $1`, [to.toJSDate()]);
}

// ───────────── Main ─────────────
const exists = await withSystem((tx) => tx.selectFrom('organizations').select('id').where('code', '=', 'glow').executeTakeFirst());
if (exists) {
  console.error('Demo salon "glow" already exists. Run `npm run db:reset` first to start over.');
  process.exit(1);
}

const today = DateTime.now().setZone(TZ).startOf('day');
const HISTORY_DAYS = 60;
const at = (day: DateTime, time: string) => DateTime.fromISO(`${day.toISODate()}T${time}`, { zone: TZ });

log('Creating platform administrator');
await withSystem(async (tx) => {
  await tx.insertInto('users').values({ email: 'admin@salonos.test', fullName: 'Platform Admin', passwordHash: await hashPassword(DEMO_PASSWORD), isPlatformAdmin: true, organizationId: null, roleId: null }).onConflict((oc) => oc.doNothing()).execute();
});
const platformToken = await login('admin@salonos.test');

log('Onboarding Glow Salon Group');
setClock(today.minus({ days: HISTORY_DAYS + 40 }).set({ hour: 10 }));
const t0Setup = realNow();
must(
  await client(platformToken).post('/platform/organizations').send({ name: 'Glow Salon Group', code: 'glow', legalName: 'Glow Salon Group Pvt Ltd', contactPerson: 'Hitesh Shah', email: 'hello@glowsalon.test', phone: '9898100000', taxId: '24ABCDE1234F1Z5', subscriptionPlan: 'growth', owner: { fullName: 'Hitesh Shah', email: 'owner@glow.test', phone: '9898100000', password: DEMO_PASSWORD }, firstBranch: { name: BRANCHES[0].name, code: BRANCHES[0].code, city: BRANCHES[0].city } }),
  'create organization',
);
const ownerToken = await login('owner@glow.test');
const owner = client(ownerToken);
const branchRjt = (must(await owner.get('/branches'), 'branches').body.data as Array<{ id: string; code: string }>).find((b) => b.code === 'RJT')!.id;
must(await owner.put(`/branches/${branchRjt}`).send({ name: BRANCHES[0].name, code: 'RJT', city: BRANCHES[0].city, addressLine1: BRANCHES[0].address, phone: BRANCHES[0].phone, timezone: TZ, status: 'active' }), 'update branch');
const amd = must(await owner.post('/branches').send({ name: BRANCHES[1].name, code: 'AMD', city: BRANCHES[1].city, addressLine1: BRANCHES[1].address, phone: BRANCHES[1].phone, timezone: TZ }), 'create branch 2');
const branchId = { RJT: branchRjt, AMD: amd.body.data.id as string };
must(await owner.patch('/organization/settings').send({ onlineBookingEnabled: true, creditDueDays: 30, reminderOffsetsMinutes: [1440, 120], receiptFooter: 'Thank you for visiting Glow! See you again soon.' }), 'settings');

log('Services, expertise and team');
const expertise = new Map<string, string>(((must(await owner.get('/expertise'), 'expertise').body.data) as Array<{ id: string; name: string }>).map((e) => [e.name, e.id]));
for (const name of EXPERTISE) if (!expertise.has(name)) throw new Error(`Missing default expertise ${name}`);
const categories = new Map<string, string>(((must(await owner.get('/service-categories'), 'categories').body.data) as Array<{ id: string; name: string }>).map((c) => [c.name, c.id]));
const serviceId = new Map<string, string>();
for (const s of SERVICES) {
  const res = must(await owner.post('/services').send({ categoryId: categories.get(s.category), code: s.code, name: s.name, price: s.price, durationMinutes: s.minutes, bufferMinutes: s.buffer ?? 0, gender: s.gender ?? 'unisex', allBranches: true, expertiseIds: s.expertise.map((e) => expertise.get(e)) }), `service ${s.name}`);
  serviceId.set(s.code, res.body.data.id);
}

const staffId = new Map<string, string>();
const staffBranch = new Map<string, 'RJT' | 'AMD'>();
for (const s of STAFF) {
  const res = must(await owner.post('/staff').send({ branchId: branchId[s.branch], employeeCode: s.code, fullName: s.name, displayName: s.display, designation: s.designation, gender: s.gender, mobile: s.mobile, joiningDate: today.minus({ years: 2 }).toISODate(), biometricPunchId: s.punchId, calendarColor: s.color, expertiseIds: s.expertise.map((e) => expertise.get(e)), employmentType: 'full_time', commissionType: 'percentage', commissionValue: 1000 }), `staff ${s.name}`);
  staffId.set(s.code, res.body.data.id);
  staffBranch.set(res.body.data.id, s.branch);
  const days = [1, 2, 3, 4, 5, 6, 7].filter((d) => d !== s.weeklyOff);
  must(
    await owner.put(`/staff/${res.body.data.id}/schedule`).send({
      shifts: days.map((weekday) => ({ weekday, startTime: '10:00', endTime: weekday === 7 ? '18:00' : '20:00' })),
      breaks: days.map((weekday) => ({ weekday, startTime: '14:00', endTime: '14:45', label: 'Lunch' })),
    }),
    `schedule ${s.name}`,
  );
}
// Price/duration differences by person.
const pooja = staffId.get('AH002')!;
const poojaServices = ((must(await owner.get(`/staff/${pooja}`), 'pooja').body.data.services) as Array<{ serviceId: string; serviceName: string; isActive: boolean }>).map((x) => ({ serviceId: x.serviceId, isActive: x.isActive, ...(x.serviceName === 'Hair Coloring' ? { priceOverride: 280000 } : {}) }));
must(await owner.put(`/staff/${pooja}/services`).send({ services: poojaServices }), 'pooja prices');

log('Logins for every role');
const roles = new Map<string, string>(((must(await owner.get('/roles'), 'roles').body.data) as Array<{ id: string; key: string }>).map((r) => [r.key, r.id]));
const logins: Array<[string, string, string, 'RJT' | 'AMD' | null, string | null]> = [
  ['Rajkot Manager', 'manager.rajkot@glow.test', 'branch_manager', 'RJT', null],
  ['Ahmedabad Manager', 'manager.ahmedabad@glow.test', 'branch_manager', 'AMD', null],
  ['Rajkot Reception', 'reception.rajkot@glow.test', 'receptionist', 'RJT', null],
  ['Ahmedabad Reception', 'reception.ahmedabad@glow.test', 'receptionist', 'AMD', null],
  ['Rahul Shah', 'rahul@glow.test', 'staff', 'RJT', 'RJ001'],
  ['Priya Mehta', 'priya@glow.test', 'staff', 'RJT', 'RJ002'],
];
for (const [name, email, role, branch, staffCode] of logins) {
  must(await owner.post('/users').send({ fullName: name, email, roleId: roles.get(role), password: DEMO_PASSWORD, branchIds: [branchId[branch!]], allBranches: false, staffId: staffCode ? staffId.get(staffCode) : undefined }), `user ${email}`);
}
await admin.query(`update users set must_change_password = false where email like '%@glow.test'`);
const tokens = {
  RJT: { reception: await login('reception.rajkot@glow.test'), manager: await login('manager.rajkot@glow.test') },
  AMD: { reception: await login('reception.ahmedabad@glow.test'), manager: await login('manager.ahmedabad@glow.test') },
};

log('Holidays, leave, offers and packages');
const holidays = [
  [today.minus({ days: 33 }), 'Maha Shivratri'],
  [today.plus({ days: 17 }), 'Festival closure'],
] as const;
for (const [d, name] of holidays) must(await owner.post('/holidays').send({ date: d.toISODate(), name }), `holiday ${name}`);
// Leave created before history so no historical booking lands on it.
const leaveDay = (offset: number) => today.plus({ days: offset }).toISODate();
must(await owner.post('/staff-leaves').send({ staffId: staffId.get('RJ001'), startDate: leaveDay(-26), endDate: leaveDay(-25), leaveType: 'sick', reason: 'Fever' }), 'leave rahul');
must(await owner.post('/staff-leaves').send({ staffId: staffId.get('AH003'), startDate: leaveDay(-12), endDate: leaveDay(-12), leaveType: 'casual' }), 'leave riya');

const valid = { validFrom: today.minus({ days: 10 }).toISODate(), validTo: today.plus({ days: 30 }).toISODate() };
must(await owner.post('/offers').send({ name: 'Festive 10% off', code: 'FESTIVE10', description: 'Valid on all services', discountType: 'percentage', discountValue: 1000, maxDiscountAmount: 100000, ...valid }), 'offer festive');
must(await owner.post('/offers').send({ name: 'First visit 15% off', discountType: 'percentage', discountValue: 1500, eligibility: 'first_visit', autoApply: true, validFrom: today.minus({ days: 200 }).toISODate(), validTo: today.plus({ days: 150 }).toISODate(), usageLimitPerCustomer: 1 }), 'offer first');
must(await owner.post('/offers').send({ name: 'Birthday treat 20% off', code: 'BDAY20', discountType: 'percentage', discountValue: 2000, eligibility: 'birthday', birthdayWindowDays: 7, validFrom: today.minus({ days: 200 }).toISODate(), validTo: today.plus({ days: 150 }).toISODate(), maxDiscountAmount: 150000 }), 'offer birthday');
must(await owner.post('/offers').send({ name: 'Hair Spa + Head Massage combo', discountType: 'percentage', discountValue: 1500, appliesTo: 'combo', serviceIds: [serviceId.get('HSPA'), serviceId.get('HEADM')], ...valid }), 'offer combo');
must(await owner.post('/offers').send({ name: 'Summer sale (ended)', code: 'SUMMER20', discountType: 'percentage', discountValue: 2000, validFrom: today.minus({ days: 60 }).toISODate(), validTo: today.minus({ days: 20 }).toISODate() }), 'offer expired');
const bridal = must(await owner.post('/packages').send({ code: 'BRIDAL', name: 'Bridal Glow Package', description: 'Hair styling, makeup, facial and manicure for the big day', price: 650000, validityDays: 120, items: ['HSTY', 'PMKP', 'FACE', 'MANI'].map((c) => ({ serviceId: serviceId.get(c), quantity: 1 })) }), 'package bridal');
const spa3 = must(await owner.post('/packages').send({ code: 'SPA3', name: 'Hair Spa × 3', price: 320000, validityDays: 90, items: [{ serviceId: serviceId.get('HSPA'), quantity: 3 }] }), 'package spa');

log('Customers');
const customers: Array<{ id: string; branch: 'RJT' | 'AMD'; name: string; gender: 'female' | 'male'; creditPool: boolean; favorites: string[]; staffPref: string | null }> = [];
const usedMobiles = new Set<string>();
for (let i = 0; i < 80; i += 1) {
  const gender = random.chance(0.72) ? 'female' : 'male';
  const name = `${random.pick(gender === 'female' ? FIRST_NAMES_F : FIRST_NAMES_M)} ${random.pick(SURNAMES)}`;
  let mobile = `9${random.int(100000000, 999999999)}`;
  while (usedMobiles.has(mobile)) mobile = `9${random.int(100000000, 999999999)}`;
  usedMobiles.add(mobile);
  const branch: 'RJT' | 'AMD' = random.chance(0.58) ? 'RJT' : 'AMD';
  const dob = random.chance(0.7) ? today.minus({ years: random.int(19, 55), days: random.int(0, 364) }) : null;
  const res = must(
    await client(tokens[branch].reception).post('/customers').send({ fullName: name, mobile, gender, email: random.chance(0.5) ? `${name.toLowerCase().replace(/\s/g, '.')}@example.test` : undefined, dateOfBirth: dob?.toISODate(), marketingConsent: random.chance(0.65), preferredBranchId: branchId[branch], source: random.pick(['walk_in', 'phone', 'online', 'referral', 'social'] as const), tags: random.chance(0.12) ? ['VIP'] : [] }),
    `customer ${name}`,
  );
  const pool = SERVICES.filter((s) => (gender === 'male' ? s.gender !== 'female' : s.gender !== 'male'));
  customers.push({ id: res.body.data.id, branch, name, gender, creditPool: i < 14, favorites: [random.weighted(pool).code, random.weighted(pool).code], staffPref: null });
}
for (const c of customers.slice(0, 5)) must(await owner.put(`/customers/${c.id}`).send({ creditLimit: 2000000 }), 'credit limit');
await backdate(today.minus({ days: HISTORY_DAYS + 30 }).set({ hour: 11 }), t0Setup);

// ───────────── History ─────────────
log(`Building ${HISTORY_DAYS} days of history (bookings, bills, payments, credit)…`);
const staffByBranch = (b: 'RJT' | 'AMD') => STAFF.filter((s) => s.branch === b);
const qualified = new Map<string, string[]>(); // `${branch}:${serviceCode}` → staff codes
for (const s of SERVICES) for (const b of ['RJT', 'AMD'] as const) qualified.set(`${b}:${s.code}`, staffByBranch(b).filter((st) => st.expertise.some((e) => s.expertise.includes(e))).map((st) => st.code));
const outstandingBy = new Map<string, number>();
let visits = 0;
let failures = 0;

async function oneVisit(day: DateTime, branch: 'RJT' | 'AMD', allowOffers: boolean): Promise<void> {
  const cust = random.chance(0.45) ? random.pick(customers.filter((c) => c.branch === branch)) : random.pick(customers);
  const pool = SERVICES.filter((s) => (cust.gender === 'male' ? s.gender !== 'female' : s.gender !== 'male'));
  const favoriteCode = random.pick(cust.favorites);
  const first = random.chance(0.55) ? SERVICES.find((s) => s.code === favoriteCode)! : random.weighted(pool);
  const picked = [first];
  if (random.chance(0.3)) {
    const second = random.weighted(pool);
    if (second.code !== first.code) picked.push(second);
  }
  const people = qualified.get(`${branch}:${first.code}`)!.filter((code) => STAFF.find((s) => s.code === code)!.weeklyOff !== day.weekday);
  if (!people.length) return;
  const staffCode = random.pick(people);
  const startsAt = at(day, '10:00').plus({ minutes: random.int(0, 33) * 15 });
  const reception = client(tokens[branch].reception);

  // Services in a booking run back to back with one person when they are qualified for all; else split by person.
  let cursor = startsAt;
  const items = picked.map((s) => {
    const codes = qualified.get(`${branch}:${s.code}`)!.filter((c) => STAFF.find((x) => x.code === c)!.weeklyOff !== day.weekday);
    const code = codes.includes(staffCode) ? staffCode : (codes[0] ?? staffCode);
    const item = { serviceId: serviceId.get(s.code), staffId: staffId.get(code), startAt: cursor.toUTC().toISO() };
    cursor = cursor.plus({ minutes: s.minutes + (s.buffer ?? 0) });
    return item;
  });

  setClock(startsAt.minus({ hours: random.int(1, 40) }));
  const booked = await reception.post('/appointments').send({ branchId: branchId[branch], customerId: cust.id, source: random.pick(['phone', 'in_person', 'whatsapp', 'online'] as const), items, notifyCustomer: random.chance(0.4) });
  if (booked.status !== 201) {
    failures += 1; // slot taken or similar: a real receptionist would simply pick another time
    if (failures <= 3) console.log(`  (skipped slot: ${booked.body.errorCode ?? booked.status} ${String(booked.body.message ?? '').slice(0, 120)})`);
    return;
  }
  const id = booked.body.data.id as string;
  const roll = random.next();
  if (roll < 0.08) {
    setClock(startsAt.minus({ hours: 3 }));
    await client(tokens[branch].reception).post(`/appointments/${id}/status`).send({ status: 'cancelled', reason: random.pick(['Customer called to cancel', 'Not feeling well', 'Rescheduling later', 'Travel plans changed']), notifyCustomer: false });
    return;
  }
  if (roll < 0.12) {
    setClock(startsAt.plus({ minutes: 40 }));
    await client(tokens[branch].manager).post(`/appointments/${id}/status`).send({ status: 'no_show' });
    return;
  }
  setClock(startsAt.minus({ minutes: 5 }));
  await reception.post(`/appointments/${id}/status`).send({ status: 'checked_in' });
  setClock(startsAt);
  await reception.post(`/appointments/${id}/status`).send({ status: 'in_service' });
  setClock(cursor);
  await reception.post(`/appointments/${id}/status`).send({ status: 'completed' });

  const draft = must(await reception.get(`/billing/draft-from-appointment/${id}`), 'draft');
  const preview = must(await reception.post('/billing/preview').send({ branchId: branchId[branch], customerId: cust.id, appointmentId: id, lines: draft.body.data.lines }), 'preview');
  let offerId: string | undefined;
  if (allowOffers) {
    const auto = preview.body.data.applicableOffers.find((o: { autoApply: boolean }) => o.autoApply) ?? (random.chance(0.35) ? preview.body.data.applicableOffers[0] : undefined);
    offerId = auto?.id;
  }
  const total = preview.body.data.grandTotal as number;
  const scenario = random.next();
  const credit = cust.creditPool && (outstandingBy.get(cust.id) ?? 0) < 1500000 && scenario < 0.55;
  let payments: Array<{ method: string; amount: number }> = [];
  if (!credit) {
    const partial = !cust.creditPool && scenario > 0.93 && total > 100000;
    const paying = partial ? Math.round(total * 0.5) : total;
    const method = random.pick(['cash', 'upi', 'upi', 'card', 'cash'] as const);
    payments = [{ method, amount: paying }];
  }
  const inv = await reception.post('/billing/invoices').send({ branchId: branchId[branch], customerId: cust.id, appointmentId: id, lines: draft.body.data.lines, offerId, payments, allowCreditLimitOverride: false });
  if (inv.status !== 201) {
    failures += 1;
    return;
  }
  const left = inv.body.data.balanceDue as number;
  if (left > 0) outstandingBy.set(cust.id, (outstandingBy.get(cust.id) ?? 0) + left);
  visits += 1;
}

for (let d = HISTORY_DAYS; d >= 1; d -= 1) {
  const day = today.minus({ days: d });
  const t0 = realNow();
  for (const branch of ['RJT', 'AMD'] as const) {
    const base = day.weekday >= 6 ? 7 : day.weekday === 7 ? 5 : 4;
    const count = base + random.int(0, 3) + (branch === 'RJT' ? 1 : 0) + Math.floor((HISTORY_DAYS - d) / 25);
    for (let n = 0; n < count; n += 1) await oneVisit(day, branch, true);
  }
  // Customers on credit settle from time to time (some in full, some partly).
  for (const [customerId, owed] of [...outstandingBy.entries()]) {
    if (owed <= 0 || !random.chance(0.06)) continue;
    const cust = customers.find((c) => c.id === customerId)!;
    setClock(at(day, '16:30'));
    const amount = random.chance(0.6) ? owed : Math.round(owed / 2 / 100) * 100;
    const res = await client(tokens[cust.branch].reception).post('/payments/collect').send({ branchId: branchId[cust.branch], customerId, amount, method: random.pick(['cash', 'upi', 'bank_transfer'] as const) });
    if (res.status === 201) outstandingBy.set(customerId, owed - Math.min(owed, amount));
  }
  setClock(at(day, '12:00'));
  await backdate(at(day, '12:00'), t0);
  if (d % 10 === 0) log(`  …${HISTORY_DAYS - d + 1} of ${HISTORY_DAYS} days done (${visits} visits)`);
}
log(`History complete: ${visits} billed visits (${failures} slots skipped)`);

// A few customers bought packages in the past; a bridal booking is on the books.
{
  const t0 = realNow();
  const buyer = customers[3]!;
  setClock(today.minus({ days: 12 }).set({ hour: 12 }));
  const sale = await client(tokens.RJT.reception).post('/billing/invoices').send({ branchId: branchId.RJT, customerId: buyer.id, lines: [{ type: 'package_sale', key: 'p', packageId: spa3.body.data.id }], payments: [{ method: 'upi', amount: 320000 }] });
  must(sale, 'package sale');
  const buyer2 = customers[9]!;
  must(await client(tokens.RJT.reception).post('/billing/invoices').send({ branchId: branchId.RJT, customerId: buyer2.id, lines: [{ type: 'package_sale', key: 'p', packageId: bridal.body.data.id }], payments: [{ method: 'bank_transfer', amount: 300000 }] }), 'bridal sale');
  await backdate(today.minus({ days: 12 }).set({ hour: 12 }), t0);
}

// ───────────── Today and the week ahead (real clock) ─────────────
resetClock();
log('Today, upcoming bookings and the walk-in queue');
const recRjt = client(await login('reception.rajkot@glow.test'));
const recAmd = client(await login('reception.ahmedabad@glow.test'));
const nowLocal = DateTime.now().setZone(TZ);
const reception = { RJT: recRjt, AMD: recAmd };
let upcoming = 0;
for (let offset = 0; offset <= 6; offset += 1) {
  const day = today.plus({ days: offset });
  for (const branch of ['RJT', 'AMD'] as const) {
    const count = offset === 0 ? 5 : random.int(4, 8);
    for (let n = 0; n < count; n += 1) {
      const cust = random.pick(customers.filter((c) => c.branch === branch));
      const pool = SERVICES.filter((s) => (cust.gender === 'male' ? s.gender !== 'female' : s.gender !== 'male'));
      const svc = random.weighted(pool);
      const codes = qualified.get(`${branch}:${svc.code}`)!.filter((c) => STAFF.find((s) => s.code === c)!.weeklyOff !== day.weekday);
      if (!codes.length) continue;
      let start = at(day, '10:00').plus({ minutes: random.int(0, 30) * 15 });
      if (offset === 0 && start < nowLocal.plus({ minutes: 30 })) start = nowLocal.plus({ minutes: random.int(1, 8) * 30 }).startOf('hour');
      const res = await reception[branch].post('/appointments').send({ branchId: branchId[branch], customerId: cust.id, source: random.pick(['phone', 'whatsapp', 'in_person', 'online'] as const), status: random.chance(0.5) ? 'confirmed' : 'scheduled', items: [{ serviceId: serviceId.get(svc.code), staffId: staffId.get(random.pick(codes)), startAt: start.toUTC().toISO() }], notes: random.chance(0.15) ? 'Prefers a quiet corner' : undefined });
      if (res.status === 201) upcoming += 1;
    }
  }
}
log(`  ${upcoming} upcoming appointments`);
// Walk-ins right now at Rajkot: two waiting, one being served.
for (const [idx, c] of customers.filter((x) => x.branch === 'RJT').slice(20, 23).entries()) {
  const svc = idx === 0 ? 'HC-W' : idx === 1 ? 'MANI' : 'FACE';
  const w = await recRjt.post('/walkins').send({ branchId: branchId.RJT, customerId: c.id, items: [{ serviceId: serviceId.get(svc) }] });
  if (w.status === 201 && idx === 0) {
    const person = qualified.get(`RJT:${svc}`)!.find((code) => STAFF.find((s) => s.code === code)!.weeklyOff !== nowLocal.weekday)!;
    await recRjt.post(`/walkins/${w.body.data.id}/assign`).send({ version: w.body.data.version, assignments: [{ itemId: w.body.data.items[0].id, staffId: staffId.get(person) }], startNow: true });
  }
}

// ───────────── Attendance (device push, signed like a real device) ─────────────
log('Attendance device and punches');
const device = must(await owner.post('/integrations').send({ kind: 'biometric', provider: 'push_webhook', displayName: 'Front desk devices', config: {} }), 'device');
const secret = device.body.data.webhookSecretOnce as string;
const punches: Array<{ externalId: string; punchId: string; punchedAt: string; direction: 'in' | 'out' }> = [];
for (let d = 21; d >= 0; d -= 1) {
  const day = today.minus({ days: d });
  for (const s of STAFF) {
    if (s.weeklyOff === day.weekday) continue;
    if (d === 0 && nowLocal.hour < 11) continue;
    const roll = random.next();
    if (roll < 0.03) continue; // absent
    const late = roll < 0.12 ? random.int(15, 50) : 0;
    const inAt = at(day, '10:00').plus({ minutes: late ? late : random.int(-12, 6) });
    punches.push({ externalId: `${s.punchId}-${day.toISODate()}-in`, punchId: s.punchId, punchedAt: inAt.toUTC().toISO()!, direction: 'in' });
    const missing = d > 0 && roll > 0.97;
    if (!missing && d > 0) punches.push({ externalId: `${s.punchId}-${day.toISODate()}-out`, punchId: s.punchId, punchedAt: at(day, day.weekday === 7 ? '18:00' : '20:00').plus({ minutes: random.int(-5, 20) }).toUTC().toISO()!, direction: 'out' });
  }
}
for (let i = 0; i < punches.length; i += 400) {
  const payload = JSON.stringify({ punches: punches.slice(i, i + 400) });
  const sig = createHmac('sha256', secret).update(payload).digest('hex');
  must(await supertest(app).post(`/api/v1/webhooks/biometric/${device.body.data.id}`).set('Content-Type', 'application/json').set('X-Signature', `sha256=${sig}`).send(payload), 'punches');
}
log(`  ${punches.length} punches recorded`);

log('Refreshing customer statistics');
const org = await withSystem((tx) => tx.selectFrom('organizations').select('id').where('code', '=', 'glow').executeTakeFirstOrThrow());
for (const c of customers) await withSystem((tx) => refreshCustomerStats(tx, org.id, c.id));
await admin.end();
await closeDb();

console.log(`
Seed complete — Glow Salon Group
  Password for every demo login: ${DEMO_PASSWORD}

  Platform admin   admin@salonos.test
  Owner            owner@glow.test
  Managers         manager.rajkot@glow.test · manager.ahmedabad@glow.test
  Receptionists    reception.rajkot@glow.test · reception.ahmedabad@glow.test
  Team members     rahul@glow.test · priya@glow.test
  Online booking   /book/glow
`);
process.exit(0);
