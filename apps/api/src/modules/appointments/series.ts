import type { AppointmentSource } from '@salon/shared';
import { DateTime } from 'luxon';
import { sql } from 'kysely';
import { audit } from '../../core/audit.js';
import type { AuthContext } from '../../core/auth-context.js';
import { AppError, notFound } from '../../core/errors.js';
import type { Tx } from '../../db/tenant.js';
import { loadServices } from '../catalog/routes.js';
import { computeDayAvailability } from '../scheduling/routes.js';
import { changeStatus, createAppointment } from './service.js';

// Repeating appointments: a booking repeated every few weeks at the same time of day. Each repeat is an ordinary
// appointment (moved or cancelled on its own); series_id ties them together for "this and the later ones".

export interface RepeatOptions {
  everyWeeks: number;
  /** How many visits in all, the first one included. */
  times: number;
  via: 'desk' | 'customer';
}

export interface RepeatResult {
  seriesId: string;
  booked: Array<{ id: string; startAt: string; staffNames: string[]; staffChanged: boolean }>;
  skipped: Array<{ startAt: string; reason: string }>;
}

const OPEN = ['scheduled', 'confirmed'];

/**
 * Books the repeats of an appointment. For each date: the same services, time and people when they are free; otherwise
 * one qualified person who is free at that time does them all; otherwise the date is skipped with the reason. Customers
 * get the online rules (only services and people that take online bookings). Repeats send no confirmation of their own
 * (the customer already has one for the first visit), but each gets its reminders.
 */
export async function repeatAppointment(tx: Tx, auth: AuthContext, orgId: string, appointmentId: string, opts: RepeatOptions): Promise<RepeatResult> {
  const a = await tx
    .selectFrom('appointments as a')
    .innerJoin('branches as b', 'b.id', 'a.branchId')
    .select(['a.id', 'a.branchId', 'a.customerId', 'a.status', 'a.startAt', 'a.seriesId', 'a.source', 'a.notes', 'a.bookingNumber', 'b.timezone'])
    .where('a.organizationId', '=', orgId)
    .where('a.id', '=', appointmentId)
    .forUpdate()
    .executeTakeFirst();
  if (!a) throw notFound('Appointment');
  if (!OPEN.includes(a.status) || !a.startAt) throw new AppError(409, 'CONFLICT', 'Only a booking that is still to come can be repeated.');
  if (a.seriesId) throw new AppError(409, 'CONFLICT', 'This booking already repeats.');

  const items = await tx
    .selectFrom('appointmentItems')
    .select(['serviceId', 'staffId', 'startAt'])
    .where('appointmentId', '=', a.id)
    .where('status', '!=', 'cancelled')
    .orderBy('sortOrder')
    .execute();
  if (!items.length || items.some((i) => !i.startAt || !i.staffId)) throw new AppError(409, 'CONFLICT', 'Give every service a team member and a time before repeating this booking.');

  const series = await tx
    .insertInto('appointmentSeries')
    .values({ organizationId: orgId, branchId: a.branchId, customerId: a.customerId, everyWeeks: opts.everyWeeks, occurrences: opts.times, createdVia: opts.via, createdBy: auth.userId || null })
    .returning('id')
    .executeTakeFirstOrThrow();
  await tx.updateTable('appointments').set({ seriesId: series.id }).where('id', '=', a.id).execute();

  const serviceIds = items.map((i) => i.serviceId);
  const services = await loadServices(tx, orgId, { ids: [...new Set(serviceIds)], branchId: a.branchId });
  const people = [...new Set(items.map((i) => i.staffId!))];
  const staffNames = async (ids: string[]) => (await tx.selectFrom('staff').select(['id', 'displayName']).where('id', 'in', ids).execute()).map((s) => s.displayName);
  const result: RepeatResult = { seriesId: series.id, booked: [], skipped: [] };
  const base = { branchId: a.branchId, customerId: a.customerId, source: opts.via === 'customer' ? ('online' as const) : (a.source as AppointmentSource), status: 'scheduled' as const, notes: a.notes, internalNotes: null, notifyCustomer: false, allowOutsideHours: false };

  for (let k = 1; k < opts.times; k += 1) {
    // Same time of day on the later date, in the branch's time zone.
    const shift = (d: Date) => DateTime.fromJSDate(d).setZone(a.timezone).plus({ weeks: k * opts.everyWeeks }).toUTC().toISO()!;
    const startAt = shift(items[0]!.startAt!);
    let reason = 'Nobody who does these services is free at that time.';

    // 1. Exactly as before: same services, times and people (the front desk only: customers book with the online rules).
    if (opts.via === 'desk') {
      const attempt = await tryBooking(tx, () => createAppointment(tx, auth, { ...base, items: items.map((i) => ({ serviceId: i.serviceId, staffId: i.staffId!, startAt: shift(i.startAt!) })) }));
      if (attempt.id) {
        result.booked.push({ id: attempt.id, startAt, staffNames: await staffNames(people), staffChanged: false });
        await tx.updateTable('appointments').set({ seriesId: series.id }).where('id', '=', attempt.id).execute();
        continue;
      }
      reason = attempt.reason;
    }

    // 2. One person who is free then does them back to back: the same person if they can, else whoever can.
    const date = DateTime.fromISO(startAt).setZone(a.timezone).toISODate()!;
    const availability = await computeDayAvailability(tx, orgId, { branchId: a.branchId, date, serviceIds, startAt }, { onlineOnly: opts.via === 'customer' }).catch((e: unknown) => {
      if (e instanceof AppError) {
        reason = e.message;
        return null;
      }
      throw e;
    });
    const free = availability?.staff.filter((s) => s.state === 'available' && s.slots.includes(startAt)) ?? [];
    const person = free.find((s) => people.length === 1 && s.staffId === people[0]) ?? free[0];
    if (availability?.beyondBookingWindowDays) reason = `Bookings can be made up to ${availability.beyondBookingWindowDays} days ahead.`;
    else if (availability && !person) reason = 'Nobody who does these services is free at that time.';
    if (person && !availability?.beyondBookingWindowDays) {
      let cursor = new Date(startAt).getTime();
      const sequential = serviceIds.map((id) => {
        const s = services.find((x) => x.id === id)!;
        const item = { serviceId: id, staffId: person.staffId, startAt: new Date(cursor).toISOString() };
        cursor += (s.durationMinutes + s.bufferMinutes) * 60_000;
        return item;
      });
      const attempt = await tryBooking(tx, () => createAppointment(tx, auth, { ...base, items: sequential }));
      if (attempt.id) {
        result.booked.push({ id: attempt.id, startAt, staffNames: [person.displayName], staffChanged: !(people.length === 1 && people[0] === person.staffId) });
        await tx.updateTable('appointments').set({ seriesId: series.id }).where('id', '=', attempt.id).execute();
        continue;
      }
      reason = attempt.reason;
    }
    result.skipped.push({ startAt, reason });
  }

  const skipped = result.skipped.length ? `, ${result.skipped.length} skipped` : '';
  await audit(tx, auth, {
    action: 'appointment.series_created',
    entityType: 'appointment',
    entityId: a.id,
    branchId: a.branchId,
    summary: `${a.bookingNumber} repeats every ${opts.everyWeeks === 1 ? 'week' : `${opts.everyWeeks} weeks`}${opts.via === 'customer' ? ' (booked by the customer)' : ''}: ${result.booked.length} more booked${skipped}`,
    after: { seriesId: series.id, everyWeeks: opts.everyWeeks, times: opts.times },
  });
  return result;
}

/** Tries one booking inside a savepoint, so a refused time leaves the rest of the series untouched. */
async function tryBooking(tx: Tx, book: () => Promise<string>): Promise<{ id: string; reason: string }> {
  await sql`savepoint repeat_visit`.execute(tx);
  try {
    const id = await book();
    await sql`release savepoint repeat_visit`.execute(tx);
    return { id, reason: '' };
  } catch (e) {
    await sql`rollback to savepoint repeat_visit`.execute(tx);
    if (e instanceof AppError) return { id: '', reason: e.message };
    throw e;
  }
}

/** Cancels this visit and the later ones of its series that are still to come. Returns how many were cancelled. */
export async function cancelFollowing(tx: Tx, auth: AuthContext, orgId: string, appointmentId: string, reason: string, notifyCustomer: boolean): Promise<number> {
  const a = await tx.selectFrom('appointments').select(['id', 'seriesId', 'startAt']).where('organizationId', '=', orgId).where('id', '=', appointmentId).executeTakeFirst();
  if (!a) throw notFound('Appointment');
  if (!a.seriesId || !a.startAt) throw new AppError(409, 'CONFLICT', 'This booking does not repeat.');
  const ids = await tx
    .selectFrom('appointments')
    .select('id')
    .where('organizationId', '=', orgId)
    .where('seriesId', '=', a.seriesId)
    .where('status', 'in', OPEN)
    .where('startAt', '>=', a.startAt)
    .orderBy('startAt')
    .execute();
  // One message to the customer for the lot (on the first), not one per visit.
  for (const [i, row] of ids.entries()) await changeStatus(tx, auth, row.id, { status: 'cancelled', reason, notifyCustomer: notifyCustomer && i === 0 });
  return ids.length;
}
