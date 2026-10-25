import { availabilityQuery, publicBookingSchema, zDateTime } from '@salon/shared';
import { rateLimit } from 'express-rate-limit';
import { z } from 'zod';
import { env, scaledLimit } from '../../config/env.js';
import { systemContext, type AuthContext } from '../../core/auth-context.js';
import { randomToken, sha256 } from '../../core/crypto.js';
import { AppError } from '../../core/errors.js';
import { createRouter } from '../../core/router.js';
import { localDateOf } from '../../core/time.js';
import { normalizePhoneOrThrow } from '../../core/validation.js';
import { withSystem, withTenant, type Tx } from '../../db/tenant.js';
import { createCustomerRecord, findCustomerByMobile } from '../customers/service.js';
import { loadOrg, loadSettings } from '../../core/validation.js';
import { loadServices } from '../catalog/routes.js';
import { addEvent, changeStatus, lockAppointment, moveAppointment } from '../appointments/service.js';
import { loadAppointmentDtos } from '../appointments/dto.js';
import { createAppointment } from '../appointments/service.js';
import { computeDayAvailability } from '../scheduling/routes.js';

// Public, unauthenticated booking for a salon's own website or a "Book now" link. Off unless the owner enables it.
// Everything is validated server-side with the same rules as the front desk; the customer manages their booking
// through an unguessable signed link (no passwords, no accounts).

const r = createRouter('/public', 'Online booking');

const limiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: scaledLimit(40),
  standardHeaders: 'draft-8',
  legacyHeaders: false,
  handler: (_req, _res, next) => next(new AppError(429, 'RATE_LIMITED', 'Too many requests from this device. Please try again in a few minutes.')),
});
const bookingLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  limit: scaledLimit(8),
  standardHeaders: 'draft-8',
  legacyHeaders: false,
  handler: (_req, _res, next) => next(new AppError(429, 'RATE_LIMITED', 'Too many bookings from this device. Please call the salon to book.')),
});

async function salonByCode(code: string) {
  const org = await withSystem((tx) =>
    tx
      .selectFrom('organizations as o')
      .innerJoin('organizationSettings as s', 's.organizationId', 'o.id')
      .select(['o.id', 'o.name', 'o.status', 'o.currency', 's.onlineBookingEnabled'])
      .where('o.code', '=', code.toLowerCase())
      .executeTakeFirst(),
  );
  if (!org || org.status !== 'active' || !org.onlineBookingEnabled) throw new AppError(404, 'NOT_FOUND', 'Online booking is not available for this salon.');
  return org;
}

/** Context that can only touch the single branch being booked. */
function publicContext(orgId: string, branchId: string, ip: string | null): AuthContext {
  return { ...systemContext(orgId, 'public-booking'), branchIds: [branchId], ip };
}

r.get('/:code', { summary: 'Salon, bookable branches and services', auth: 'public', middleware: [limiter] }, async ({ params }) => {
  const org = await salonByCode(params.code!);
  return withTenant({ orgId: org.id }, async (t) => {
    const branches = await t.selectFrom('branches').select(['id', 'name', 'addressLine1', 'city', 'phone', 'timezone']).where('organizationId', '=', org.id).where('status', '=', 'active').orderBy('name').execute();
    const services = (await loadServices(t, org.id, {})).filter((s) => s.onlineBookable);
    return {
      salon: { name: org.name, currency: org.currency },
      branches,
      services: services.map((s) => ({ id: s.id, name: s.name, description: s.description, category: s.categoryName, durationMinutes: s.durationMinutes, price: s.price, allBranches: s.allBranches, branchIds: s.branches.map((b) => b.branchId) })),
    };
  });
});

r.get('/:code/availability', { summary: 'Valid start times only', auth: 'public', query: availabilityQuery, middleware: [limiter] }, async ({ params, query }) => {
  const org = await salonByCode(params.code!);
  return withTenant({ orgId: org.id }, async (t) => {
    const result = await computeDayAvailability(t, org.id, { ...query, excludeAppointmentId: undefined, customerId: undefined }, { onlineOnly: true });
    // Customers only need times and (optionally) who is free; hide internal status text and prices per person.
    return {
      date: result.date,
      timezone: result.timezone,
      beyondBookingWindowDays: result.beyondBookingWindowDays,
      totalDurationMinutes: result.totalDurationMinutes,
      staff: result.staff.filter((s) => s.slots.length > 0).map((s) => ({ staffId: s.staffId, displayName: s.displayName, slots: s.slots })),
      slots: result.slots,
    };
  });
});

async function bookingByToken(tx: Tx, token: string) {
  const row = await tx
    .selectFrom('appointments')
    .select(['id', 'organizationId', 'branchId', 'status', 'version', 'startAt'])
    .where('manageTokenHash', '=', sha256(token))
    .executeTakeFirst();
  if (!row) throw new AppError(404, 'NOT_FOUND', 'We could not find this booking. The link may be incorrect.');
  return row;
}

function view(dto: Awaited<ReturnType<typeof loadAppointmentDtos>>[number], extras: { salonName: string; salonCode: string; branchPhone: string | null; timezone: string; canChange: boolean }) {
  return {
    bookingNumber: dto.bookingNumber,
    status: dto.status,
    startAt: dto.startAt,
    endAt: dto.endAt,
    branchName: dto.branchName,
    branchPhone: extras.branchPhone,
    salonName: extras.salonName,
    salonCode: extras.salonCode,
    timezone: extras.timezone,
    branchId: dto.branchId,
    serviceIds: dto.items.map((i) => i.serviceId),
    customerName: dto.customer.fullName,
    services: dto.items.map((i) => ({ name: i.serviceName, staffName: i.staffName, startAt: i.startAt, durationMinutes: i.durationMinutes, price: i.price })),
    total: dto.estimatedAmount,
    canChange: extras.canChange,
  };
}

r.post('/:code/bookings', { summary: 'Book online', auth: 'public', body: publicBookingSchema, middleware: [bookingLimiter] }, async ({ params, body, auth }) => {
  const org = await salonByCode(params.code!);
  if (body.website) throw new AppError(400, 'BAD_REQUEST', 'Something went wrong. Please try again.'); // honeypot
  const token = randomToken(32);
  const result = await withTenant({ orgId: org.id }, async (t) => {
    const ctx = publicContext(org.id, body.branchId, auth.ip);
    const orgCtx = await loadOrg(t, org.id);
    const settings = await loadSettings(t, org.id);
    const branch = await t.selectFrom('branches').select(['id', 'status', 'phone', 'timezone']).where('organizationId', '=', org.id).where('id', '=', body.branchId).executeTakeFirst();
    if (!branch || branch.status !== 'active') throw new AppError(404, 'NOT_FOUND', 'This branch is not available for online booking.');

    const mobile = normalizePhoneOrThrow(body.customer.mobile, orgCtx.callingCode, 'customer.mobile');
    const existing = await findCustomerByMobile(t, org.id, mobile);
    const customerId =
      existing?.id ??
      (await createCustomerRecord(t, ctx, orgCtx, { fullName: body.customer.fullName, mobile: body.customer.mobile, email: body.customer.email ?? undefined, marketingConsent: body.customer.marketingConsent, source: 'online', preferredBranchId: body.branchId }, { registeredBranchId: body.branchId, consentSource: 'online_form' }));

    // Services are performed back to back by the chosen person, or by whoever is free at the requested time.
    const day = body.startAt;
    const availability = await computeDayAvailability(t, org.id, { branchId: body.branchId, date: localDateOf(new Date(day), branch.timezone), serviceIds: body.serviceIds, startAt: day, staffId: body.staffId ?? undefined }, { onlineOnly: true });
    const candidate = availability.staff.find((s) => s.state === 'available' && s.slots.includes(new Date(day).toISOString()));
    if (!candidate) throw new AppError(409, 'APPOINTMENT_CONFLICT', 'Sorry, that time was just taken. Please choose another time.');

    const services = await loadServices(t, org.id, { ids: body.serviceIds, branchId: body.branchId });
    const ordered = body.serviceIds.map((id) => services.find((s) => s.id === id)!);
    let cursor = new Date(day).getTime();
    const items = ordered.map((s) => {
      const item = { serviceId: s.id, staffId: candidate.staffId, startAt: new Date(cursor).toISOString() };
      cursor += (s.durationMinutes + s.bufferMinutes) * 60_000;
      return item;
    });
    const id = await createAppointment(t, ctx, { branchId: body.branchId, customerId, source: 'online', status: 'scheduled', notes: body.notes ?? null, internalNotes: null, items, notifyCustomer: true, allowOutsideHours: false });
    await t.updateTable('appointments').set({ manageTokenHash: sha256(token) }).where('id', '=', id).execute();
    const [dto] = await loadAppointmentDtos(t, ctx, org.id, [id], settings);
    return view(dto!, { salonName: org.name, salonCode: params.code!.toLowerCase(), branchPhone: branch.phone, timezone: branch.timezone, canChange: true });
  });
  return { ...result, manageLink: `${env.APP_BASE_URL}/book/manage/${token}` };
});

r.get('/manage/:token', { summary: 'See a booking from its private link', auth: 'public', middleware: [limiter] }, async ({ params, auth }) => {
  const peek = await withSystem((tx) => bookingByToken(tx, params.token!));
  return withTenant({ orgId: peek.organizationId }, async (t) => {
    const ctx = publicContext(peek.organizationId, peek.branchId, auth.ip);
    const [dto] = await loadAppointmentDtos(t, ctx, peek.organizationId, [peek.id], await loadSettings(t, peek.organizationId));
    const org = await t.selectFrom('organizations').select(['name', 'code']).where('id', '=', peek.organizationId).executeTakeFirstOrThrow();
    const branch = await t.selectFrom('branches').select(['phone', 'timezone']).where('id', '=', peek.branchId).executeTakeFirstOrThrow();
    return view(dto!, { salonName: org.name, salonCode: org.code, branchPhone: branch.phone, timezone: branch.timezone, canChange: ['scheduled', 'confirmed'].includes(peek.status) && (peek.startAt?.getTime() ?? 0) > Date.now() + 2 * 3600_000 });
  });
});

r.post('/manage/:token/cancel', { summary: 'Cancel from the private link (up to 2 hours before)', auth: 'public', status: 200, middleware: [limiter] }, async ({ params, auth }) => {
  const peek = await withSystem((tx) => bookingByToken(tx, params.token!));
  if (!['scheduled', 'confirmed'].includes(peek.status)) throw new AppError(409, 'INVALID_STATUS_TRANSITION', 'This booking can no longer be cancelled online. Please call the salon.');
  if ((peek.startAt?.getTime() ?? 0) < Date.now() + 2 * 3600_000) throw new AppError(409, 'CONFLICT', 'It is too close to the appointment time to cancel online. Please call the salon.');
  await withTenant({ orgId: peek.organizationId }, async (t) => {
    const ctx = { ...publicContext(peek.organizationId, peek.branchId, auth.ip), permissions: new Set(['appointments.cancel' as const, 'appointments.status' as const]) };
    await changeStatus(t, ctx, peek.id, { status: 'cancelled', reason: 'Cancelled by customer (online)', notifyCustomer: true });
  });
  return { cancelled: true };
});

r.post('/manage/:token/reschedule', { summary: 'Move to another valid time from the private link', auth: 'public', body: z.object({ startAt: zDateTime }), status: 200, middleware: [limiter] }, async ({ params, body, auth }) => {
  const peek = await withSystem((tx) => bookingByToken(tx, params.token!));
  if (!['scheduled', 'confirmed'].includes(peek.status)) throw new AppError(409, 'INVALID_STATUS_TRANSITION', 'This booking can no longer be changed online. Please call the salon.');
  if ((peek.startAt?.getTime() ?? 0) < Date.now() + 2 * 3600_000) throw new AppError(409, 'CONFLICT', 'It is too close to the appointment time to change online. Please call the salon.');
  return withTenant({ orgId: peek.organizationId }, async (t) => {
    const ctx = { ...publicContext(peek.organizationId, peek.branchId, auth.ip), permissions: new Set(['appointments.update' as const]) };
    const a = await lockAppointment(t, ctx, peek.organizationId, peek.id);
    const first = await t.selectFrom('appointmentItems').select('id').where('appointmentId', '=', peek.id).orderBy('sortOrder').executeTakeFirstOrThrow();
    await moveAppointment(t, ctx, peek.id, { version: a.version, itemId: first.id, startAt: body.startAt, notifyCustomer: true, allowOutsideHours: false });
    await addEvent(t, ctx, peek.organizationId, peek.id, 'note', { by: 'customer', via: 'online link' });
    return { rescheduled: true };
  });
});

export const publicBookingRoutes = r;
