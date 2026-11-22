import { availabilityQuery, publicBookingSchema, rebookSchema, repeatAppointmentSchema, zDateTime, type AppointmentDto, type AppointmentStatus } from '@salon/shared';
import { rateLimit } from 'express-rate-limit';
import { z } from 'zod';
import { scaledLimit } from '../../config/env.js';
import { systemContext, type AuthContext } from '../../core/auth-context.js';
import { AppError } from '../../core/errors.js';
import { createRouter } from '../../core/router.js';
import { addDays, localDateOf } from '../../core/time.js';
import { normalizePhoneOrThrow } from '../../core/validation.js';
import { withSystem, withTenant, type Tx } from '../../db/tenant.js';
import { createCustomerRecord, findCustomerByMobile } from '../customers/service.js';
import { loadOrg, loadSettings } from '../../core/validation.js';
import { loadServices } from '../catalog/routes.js';
import { addEvent, changeStatus, lockAppointment, moveAppointment } from '../appointments/service.js';
import { loadAppointmentDtos } from '../appointments/dto.js';
import { createAppointment } from '../appointments/service.js';
import { cancelFollowing, repeatAppointment } from '../appointments/series.js';
import { computeDayAvailability } from '../scheduling/routes.js';
import { createCustomerLink, resolveLink } from '../customer-portal/links.js';

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
      .select(['o.id', 'o.name', 'o.status', 'o.currency', 'o.disabledFeatures', 's.onlineBookingEnabled'])
      .where('o.code', '=', code.toLowerCase())
      .executeTakeFirst(),
  );
  if (!org || org.status !== 'active' || !org.onlineBookingEnabled || org.disabledFeatures.includes('online_booking')) throw new AppError(404, 'NOT_FOUND', 'Online booking is not available for this salon.');
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

// A full or closed day: the next day (within three weeks and the booking window) with a free time, in one request.
r.get('/:code/next-available', { summary: 'The next day with a free time after a given day', auth: 'public', query: availabilityQuery.pick({ branchId: true, date: true, serviceIds: true, staffId: true }), middleware: [limiter] }, async ({ params, query }) => {
  const org = await salonByCode(params.code!);
  return withTenant({ orgId: org.id }, async (t) => {
    let day = query.date;
    for (let i = 0; i < 21; i += 1) {
      day = addDays(day, 1);
      const a = await computeDayAvailability(t, org.id, { branchId: query.branchId, date: day, serviceIds: query.serviceIds, staffId: query.staffId, excludeAppointmentId: undefined, customerId: undefined }, { onlineOnly: true });
      if (a.beyondBookingWindowDays) return { date: null, firstStartAt: null };
      const free = query.staffId ? a.staff.find((s) => s.staffId === query.staffId)?.slots ?? [] : a.slots.map((s) => s.startAt);
      if (free.length) return { date: day, firstStartAt: free[0]! };
    }
    return { date: null, firstStartAt: null };
  });
});

const NOT_FOUND = 'We could not find this booking. The link may be incorrect.';
/** How a booking repeats, as the customer needs it: how often, and how many visits come after it. */
const repeatsOf = (d: { series: AppointmentDto['series'] }) => (d.series ? { everyWeeks: d.series.everyWeeks, later: d.series.later } : null);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const OPEN_STATUSES: readonly string[] = ['scheduled', 'confirmed'];
const CHANGE_CUTOFF_MS = 2 * 3600_000;
/** Customers can move or cancel online until two hours before the start. */
const changeable = (status: string, startAt: Date | string | null) => OPEN_STATUSES.includes(status) && (startAt ? new Date(startAt).getTime() : 0) > Date.now() + CHANGE_CUTOFF_MS;

/** What a customer holding a link can do at this salon right now. */
async function salonState(tx: Tx, orgId: string) {
  const o = await tx
    .selectFrom('organizations as o')
    .innerJoin('organizationSettings as s', 's.organizationId', 'o.id')
    .select(['o.id', 'o.name', 'o.code', 'o.currency', 'o.status', 'o.disabledFeatures', 's.onlineBookingEnabled'])
    .where('o.id', '=', orgId)
    .executeTakeFirst();
  if (!o || o.status === 'archived') throw new AppError(404, 'NOT_FOUND', NOT_FOUND);
  return {
    name: o.name,
    code: String(o.code),
    currency: o.currency,
    /** Times can be chosen online (needed to move a booking or book again). */
    onlineOpen: o.status === 'active' && o.onlineBookingEnabled && !o.disabledFeatures.includes('online_booking'),
    /** Customer self-service: the customer's other visits and "Book again". */
    selfService: !o.disabledFeatures.includes('customer_portal'),
    /** Repeating appointments. */
    recurring: !o.disabledFeatures.includes('recurring'),
  };
}

/** The booking behind a private link or, with self-service, another booking of the same customer. */
async function bookingFor(token: string, appointmentId?: string) {
  return withSystem(async (tx) => {
    const link = await resolveLink(tx, token);
    const salon = await salonState(tx, link.orgId);
    const id = appointmentId ?? link.appointmentId;
    if (!UUID.test(id)) throw new AppError(404, 'NOT_FOUND', NOT_FOUND);
    if (id !== link.appointmentId && !salon.selfService) throw new AppError(403, 'FEATURE_OFF', 'Please call the salon to manage your other bookings.');
    const booking = await tx
      .selectFrom('appointments')
      .select(['id', 'branchId', 'status', 'version', 'startAt', 'customerId', 'seriesId'])
      .where('organizationId', '=', link.orgId)
      .where('id', '=', id)
      .executeTakeFirst();
    if (!booking || booking.customerId !== link.customerId) throw new AppError(404, 'NOT_FOUND', NOT_FOUND);
    return { link, salon, booking };
  });
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

/**
 * Books a customer online at one branch: the chosen person, or whoever is free at that time, does the services back to
 * back. Same rules as the booking page (online-bookable services and people, the salon's hours and booking window).
 */
async function placeOnlineBooking(t: Tx, ctx: AuthContext, orgId: string, branch: { id: string; timezone: string }, input: { serviceIds: string[]; staffId?: string | null; startAt: string; notes?: string | null; customerId: string }): Promise<string> {
  const day = input.startAt;
  const availability = await computeDayAvailability(t, orgId, { branchId: branch.id, date: localDateOf(new Date(day), branch.timezone), serviceIds: input.serviceIds, startAt: day, staffId: input.staffId ?? undefined }, { onlineOnly: true });
  const candidate = availability.staff.find((s) => s.state === 'available' && s.slots.includes(new Date(day).toISOString()));
  if (!candidate) throw new AppError(409, 'APPOINTMENT_CONFLICT', 'Sorry, that time was just taken. Please choose another time.');

  const services = await loadServices(t, orgId, { ids: input.serviceIds, branchId: branch.id });
  const ordered = input.serviceIds.map((id) => services.find((s) => s.id === id)!);
  let cursor = new Date(day).getTime();
  const items = ordered.map((s) => {
    const item = { serviceId: s.id, staffId: candidate.staffId, startAt: new Date(cursor).toISOString() };
    cursor += (s.durationMinutes + s.bufferMinutes) * 60_000;
    return item;
  });
  return createAppointment(t, ctx, { branchId: branch.id, customerId: input.customerId, source: 'online', status: 'scheduled', notes: input.notes ?? null, internalNotes: null, items, notifyCustomer: true, allowOutsideHours: false });
}

async function bookableBranch(t: Tx, orgId: string, branchId: string) {
  const branch = await t.selectFrom('branches').select(['id', 'status', 'phone', 'timezone']).where('organizationId', '=', orgId).where('id', '=', branchId).executeTakeFirst();
  if (!branch || branch.status !== 'active') throw new AppError(404, 'NOT_FOUND', 'This branch is not available for online booking.');
  return branch;
}

/** The new booking as the customer sees it, with whether a confirmation message really went out. */
async function bookedView(t: Tx, ctx: AuthContext, orgId: string, salon: { name: string; code: string }, branch: { phone: string | null; timezone: string }, id: string, manageLink: string) {
  const [dto] = await loadAppointmentDtos(t, ctx, orgId, [id], await loadSettings(t, orgId));
  // Only promise a confirmation message when one was really queued (none is when the salon has no messaging set up).
  const confirmation = await t.selectFrom('notifications').select('channel').where('organizationId', '=', orgId).where('sourceId', '=', id).where('eventType', '=', 'appointment_confirmation').executeTakeFirst();
  return { ...view(dto!, { salonName: salon.name, salonCode: salon.code, branchPhone: branch.phone, timezone: branch.timezone, canChange: true }), confirmationSent: !!confirmation, manageLink };
}

r.post('/:code/bookings', { summary: 'Book online', auth: 'public', body: publicBookingSchema, middleware: [bookingLimiter] }, async ({ params, body, auth }) => {
  const org = await salonByCode(params.code!);
  if (body.website) throw new AppError(400, 'BAD_REQUEST', 'Something went wrong. Please try again.'); // honeypot
  return withTenant({ orgId: org.id }, async (t) => {
    const ctx = publicContext(org.id, body.branchId, auth.ip);
    const orgCtx = await loadOrg(t, org.id);
    const branch = await bookableBranch(t, org.id, body.branchId);

    const mobile = normalizePhoneOrThrow(body.customer.mobile, orgCtx.callingCode, 'customer.mobile');
    const existing = await findCustomerByMobile(t, org.id, mobile);
    const customerId =
      existing?.id ??
      (await createCustomerRecord(t, ctx, orgCtx, { fullName: body.customer.fullName, mobile: body.customer.mobile, email: body.customer.email ?? undefined, marketingConsent: body.customer.marketingConsent, source: 'online', preferredBranchId: body.branchId }, { registeredBranchId: body.branchId, consentSource: 'online_form' }));

    const id = await placeOnlineBooking(t, ctx, org.id, branch, { serviceIds: body.serviceIds, staffId: body.staffId, startAt: body.startAt, notes: body.notes, customerId });
    const manageLink = await createCustomerLink(t, org.id, id, customerId);
    return bookedView(t, ctx, org.id, { name: org.name, code: params.code!.toLowerCase() }, branch, id, manageLink);
  });
});

r.get('/manage/:token', { summary: 'See a booking from its private link', auth: 'public', middleware: [limiter] }, async ({ params, auth }) => {
  const { link, salon, booking } = await bookingFor(params.token!);
  return withTenant({ orgId: link.orgId }, async (t) => {
    const ctx = publicContext(link.orgId, booking.branchId, auth.ip);
    const [dto] = await loadAppointmentDtos(t, ctx, link.orgId, [booking.id], await loadSettings(t, link.orgId));
    const branch = await t.selectFrom('branches').select(['phone', 'timezone']).where('id', '=', booking.branchId).executeTakeFirstOrThrow();
    return {
      ...view(dto!, { salonName: salon.name, salonCode: salon.code, branchPhone: branch.phone, timezone: branch.timezone, canChange: changeable(booking.status, booking.startAt) }),
      canMove: salon.onlineOpen,
      selfService: salon.selfService,
      repeats: repeatsOf(dto!),
      canRepeat: salon.selfService && salon.recurring && salon.onlineOpen && !dto!.series && changeable(booking.status, booking.startAt),
    };
  });
});

// ───────────── Customer self-service: the customer's visits, from any of their private links ─────────────

const UPCOMING: AppointmentStatus[] = ['scheduled', 'confirmed', 'checked_in', 'in_service'];
const VISITS_SHOWN = 20;

r.get('/manage/:token/visits', { summary: "The customer's visits: coming up, before, and what to book again", auth: 'public', middleware: [limiter] }, async ({ params, auth }) => {
  const { link, salon } = await bookingFor(params.token!);
  if (!salon.selfService) throw new AppError(403, 'FEATURE_OFF', 'Customer self-service is not available for this salon.');
  const orgId = link.orgId;
  return withTenant({ orgId }, async (t) => {
    const branches = await t.selectFrom('branches').select(['id', 'name', 'status', 'phone', 'timezone']).where('organizationId', '=', orgId).execute();
    const ctx: AuthContext = { ...systemContext(orgId, 'customer-portal'), branchIds: branches.map((b) => b.id), ip: auth.ip };
    const now = new Date();
    const recent = new Date(now.getTime() - 12 * 3600_000); // today's visit stays under "coming up" while it happens
    const mine = t.selectFrom('appointments').select('id').where('organizationId', '=', orgId).where('customerId', '=', link.customerId).where('startAt', 'is not', null);
    const [upcomingRows, pastRows, customer] = await Promise.all([
      mine.where('status', 'in', UPCOMING).where('startAt', '>=', recent).orderBy('startAt', 'asc').limit(VISITS_SHOWN).execute(),
      mine
        .where((eb) => eb.or([eb('status', 'in', ['completed', 'no_show']), eb.and([eb('status', '=', 'cancelled'), eb('startAt', '<', now)])]))
        .orderBy('startAt', 'desc')
        .limit(VISITS_SHOWN)
        .execute(),
      t.selectFrom('customers').select('fullName').where('id', '=', link.customerId).executeTakeFirstOrThrow(),
    ]);
    const dtos = await loadAppointmentDtos(t, ctx, orgId, [...upcomingRows, ...pastRows].map((x) => x.id), await loadSettings(t, orgId));
    const byId = new Map(dtos.map((d) => [d.id, d]));

    // "Book again" only where it will work: services still bookable online at that branch, and the same person if they
    // still take online bookings.
    const bookable = new Map<string, Set<string>>();
    let people = new Set<string>();
    if (salon.onlineOpen) {
      for (const b of branches.filter((x) => x.status === 'active')) {
        bookable.set(b.id, new Set((await loadServices(t, orgId, { branchId: b.id })).filter((s) => s.onlineBookable && s.status === 'active').map((s) => s.id)));
      }
      const staff = await t.selectFrom('staff').select('id').where('organizationId', '=', orgId).where('employmentStatus', 'in', ['active', 'on_notice']).where('isBookable', '=', true).where('onlineBookable', '=', true).execute();
      people = new Set(staff.map((x) => x.id));
    }

    const toVisit = (d: (typeof dtos)[number], past: boolean) => {
      const branch = branches.find((b) => b.id === d.branchId);
      const serviceIds = [...new Set(d.items.map((i) => i.serviceId))];
      const staffIds = [...new Set(d.items.map((i) => i.staffId).filter((x): x is string => !!x))];
      const can = bookable.get(d.branchId);
      const person = staffIds.length === 1 && people.has(staffIds[0]!) ? staffIds[0]! : null;
      return {
        id: d.id,
        bookingNumber: d.bookingNumber,
        status: d.status,
        startAt: d.startAt,
        branchId: d.branchId,
        branchName: d.branchName,
        branchPhone: branch?.phone ?? null,
        timezone: branch?.timezone ?? 'Asia/Kolkata',
        services: d.items.map((i) => ({ serviceId: i.serviceId, name: i.serviceName, staffName: i.staffName, durationMinutes: i.durationMinutes })),
        total: d.estimatedAmount,
        isThis: d.id === link.appointmentId,
        canChange: !past && changeable(d.status, d.startAt),
        repeats: past ? null : repeatsOf(d),
        rebook: past && can && serviceIds.length <= 5 && serviceIds.every((id) => can.has(id)) ? { branchId: d.branchId, serviceIds, staffId: person, staffName: person ? d.items.find((i) => i.staffId === person)?.staffName ?? null : null } : null,
      };
    };
    const upcoming = upcomingRows.map((x) => byId.get(x.id)).filter((d) => !!d).map((d) => toVisit(d, false));
    const past = pastRows.map((x) => byId.get(x.id)).filter((d) => !!d).map((d) => toVisit(d, true));

    // Their usual: the same services at the same branch, done at least twice (the most often, then the most recent),
    // with the person who did them most often.
    const groups = new Map<string, typeof past>();
    for (const v of past) {
      if (v.status !== 'completed' || !v.rebook) continue;
      const key = `${v.branchId}|${[...v.rebook.serviceIds].sort().join(',')}`;
      groups.set(key, [...(groups.get(key) ?? []), v]);
    }
    const favourite = [...groups.values()].filter((g) => g.length >= 2).sort((a, b) => b.length - a.length)[0];
    let usual = null;
    if (favourite) {
      const counts = new Map<string, { n: number; name: string | null }>();
      for (const v of favourite) if (v.rebook!.staffId) counts.set(v.rebook!.staffId, { n: (counts.get(v.rebook!.staffId)?.n ?? 0) + 1, name: v.rebook!.staffName });
      const top = [...counts.entries()].sort((a, b) => b[1].n - a[1].n)[0];
      const latest = favourite[0]!;
      usual = { ...latest.rebook!, staffId: top?.[0] ?? null, staffName: top?.[1].name ?? null, services: latest.services.map((s) => s.name), branchName: latest.branchName, timezone: latest.timezone, times: favourite.length };
    }

    return { customerName: customer.fullName, salonName: salon.name, salonCode: salon.code, currency: salon.currency, canBook: salon.onlineOpen, upcoming, past, usual };
  });
});

r.post('/manage/:token/book', { summary: 'Book again from the private link', auth: 'public', body: rebookSchema, middleware: [bookingLimiter] }, async ({ params, body, auth }) => {
  const { link, salon } = await bookingFor(params.token!);
  if (!salon.selfService) throw new AppError(403, 'FEATURE_OFF', 'Customer self-service is not available for this salon.');
  if (!salon.onlineOpen) throw new AppError(409, 'CONFLICT', 'Online booking is closed at the moment. Please call the salon to book.');
  return withTenant({ orgId: link.orgId }, async (t) => {
    const ctx = publicContext(link.orgId, body.branchId, auth.ip);
    const branch = await bookableBranch(t, link.orgId, body.branchId);
    const id = await placeOnlineBooking(t, ctx, link.orgId, branch, { ...body, customerId: link.customerId });
    await addEvent(t, ctx, link.orgId, id, 'note', { by: 'customer', via: 'book again' });
    const manageLink = await createCustomerLink(t, link.orgId, id, link.customerId);
    return bookedView(t, ctx, link.orgId, salon, branch, id, manageLink);
  });
});

// ───────────── Cancel or move: the link's own booking, or (self-service) another of the customer's bookings ─────────────

async function cancelOnline(token: string, appointmentId: string | undefined, ip: string | null, following = false) {
  const { link, booking } = await bookingFor(token, appointmentId);
  if (!OPEN_STATUSES.includes(booking.status)) throw new AppError(409, 'INVALID_STATUS_TRANSITION', 'This booking can no longer be cancelled online. Please call the salon.');
  if (!changeable(booking.status, booking.startAt)) throw new AppError(409, 'CONFLICT', 'It is too close to the appointment time to cancel online. Please call the salon.');
  await withTenant({ orgId: link.orgId }, async (t) => {
    const ctx = { ...publicContext(link.orgId, booking.branchId, ip), permissions: new Set(['appointments.cancel' as const, 'appointments.status' as const]) };
    // "This and the later ones" for a repeating booking; otherwise just this visit.
    if (following && booking.seriesId) await cancelFollowing(t, ctx, link.orgId, booking.id, 'Cancelled by customer (online)', true);
    else await changeStatus(t, ctx, booking.id, { status: 'cancelled', reason: 'Cancelled by customer (online)', notifyCustomer: true });
  });
  return { cancelled: true };
}

async function moveOnline(token: string, appointmentId: string | undefined, startAt: string, ip: string | null) {
  const { link, salon, booking } = await bookingFor(token, appointmentId);
  if (!OPEN_STATUSES.includes(booking.status)) throw new AppError(409, 'INVALID_STATUS_TRANSITION', 'This booking can no longer be changed online. Please call the salon.');
  if (!changeable(booking.status, booking.startAt)) throw new AppError(409, 'CONFLICT', 'It is too close to the appointment time to change online. Please call the salon.');
  if (!salon.onlineOpen) throw new AppError(409, 'CONFLICT', 'Times cannot be changed online at the moment. Please call the salon.');
  return withTenant({ orgId: link.orgId }, async (t) => {
    const ctx = { ...publicContext(link.orgId, booking.branchId, ip), permissions: new Set(['appointments.update' as const]) };
    const a = await lockAppointment(t, ctx, link.orgId, booking.id);
    const first = await t.selectFrom('appointmentItems').select('id').where('appointmentId', '=', booking.id).orderBy('sortOrder').executeTakeFirstOrThrow();
    await moveAppointment(t, ctx, booking.id, { version: a.version, itemId: first.id, startAt, notifyCustomer: true, allowOutsideHours: false });
    await addEvent(t, ctx, link.orgId, booking.id, 'note', { by: 'customer', via: 'online link' });
    return { rescheduled: true };
  });
}

const moveBody = z.object({ startAt: zDateTime });
const cancelBody = z.object({ following: z.boolean().optional() });
r.post('/manage/:token/cancel', { summary: 'Cancel from the private link (up to 2 hours before)', auth: 'public', body: cancelBody, status: 200, middleware: [limiter] }, async ({ params, body, auth }) => cancelOnline(params.token!, undefined, auth.ip, body.following));
r.post('/manage/:token/reschedule', { summary: 'Move to another valid time from the private link', auth: 'public', body: moveBody, status: 200, middleware: [limiter] }, async ({ params, body, auth }) => moveOnline(params.token!, undefined, body.startAt, auth.ip));
r.post('/manage/:token/visits/:id/cancel', { summary: 'Cancel another of the customer’s bookings (self-service)', auth: 'public', body: cancelBody, status: 200, middleware: [limiter] }, async ({ params, body, auth }) => cancelOnline(params.token!, params.id!, auth.ip, body.following));

// The customer repeats their booking every few weeks, with the online rules (same person when they are free).
const customerRepeat = repeatAppointmentSchema.extend({ times: z.number().int().min(2).max(12) });
r.post('/manage/:token/repeat', { summary: 'Repeat the booking every few weeks (self-service)', auth: 'public', body: customerRepeat, status: 200, middleware: [bookingLimiter] }, async ({ params, body, auth }) => {
  const { link, salon, booking } = await bookingFor(params.token!);
  if (!salon.selfService || !salon.recurring) throw new AppError(403, 'FEATURE_OFF', 'Please call the salon to set up repeating visits.');
  if (!salon.onlineOpen) throw new AppError(409, 'CONFLICT', 'Online booking is closed at the moment. Please call the salon.');
  if (!changeable(booking.status, booking.startAt)) throw new AppError(409, 'CONFLICT', 'Only a booking that is still to come can be repeated online.');
  return withTenant({ orgId: link.orgId }, async (t) => {
    const ctx = publicContext(link.orgId, booking.branchId, auth.ip);
    return repeatAppointment(t, ctx, link.orgId, booking.id, { everyWeeks: body.everyWeeks, times: body.times, via: 'customer' });
  });
});
r.post('/manage/:token/visits/:id/reschedule', { summary: 'Move another of the customer’s bookings (self-service)', auth: 'public', body: moveBody, status: 200, middleware: [limiter] }, async ({ params, body, auth }) => moveOnline(params.token!, params.id!, body.startAt, auth.ip));

export const publicBookingRoutes = r;
