import {
  canTransition,
  type AppointmentItemInput,
  type AppointmentStatus,
  type AppointmentStatusInput,
  type CreateAppointmentInput,
  type CreateWalkInInput,
  type MoveAppointmentInput,
  type UpdateAppointmentInput,
} from '@salon/shared';
import { sql } from 'kysely';
import { DateTime } from 'luxon';
import { audit } from '../../core/audit.js';
import { assertBranchAccess, hasPermission, isOwnScopeOnly, requireOrgId, type AuthContext } from '../../core/auth-context.js';
import { AppError, notFound } from '../../core/errors.js';
import { nextBookingNumber, nextQueueNumber } from '../../core/sequences.js';
import { localDateOf, todayIn } from '../../core/time.js';
import { loadBranch, loadOrg, loadSettings, type BranchRow, type OrgSettings } from '../../core/validation.js';
import type { Tx } from '../../db/tenant.js';
import { createCustomerRecord, refreshCustomerStats } from '../customers/service.js';
import { computeAvailability, type Interval } from '../scheduling/engine.js';
import { effectiveBuffer, loadDayContext, loadServicesForBranch, loadStaffDays } from '../scheduling/loader.js';
import { cancelAppointmentReminders, queueAppointmentMessages } from './messages.js';
import { planItems, summarizePlans, type ExistingItem, type ItemPlan } from './planner.js';

const MINUTE = 60_000;
const BLOCKING: AppointmentStatus[] = ['scheduled', 'confirmed', 'checked_in', 'in_service', 'completed'];

type AppointmentRow = Awaited<ReturnType<typeof lockAppointment>>;

export async function addEvent(
  tx: Tx,
  auth: AuthContext,
  orgId: string,
  appointmentId: string,
  eventType: 'created' | 'status_changed' | 'rescheduled' | 'staff_changed' | 'services_changed' | 'restored' | 'billed' | 'note',
  data: Record<string, unknown> | null = null,
  statuses: { from?: string | null; to?: string | null } = {},
): Promise<void> {
  await tx
    .insertInto('appointmentEvents')
    .values({ organizationId: orgId, appointmentId, eventType, fromStatus: statuses.from ?? null, toStatus: statuses.to ?? null, data: data ? JSON.stringify(data) : null, actorUserId: auth.userId || null })
    .execute();
}

export async function lockAppointment(tx: Tx, auth: AuthContext, orgId: string, id: string) {
  const a = await tx.selectFrom('appointments').selectAll().where('organizationId', '=', orgId).where('id', '=', id).forUpdate().executeTakeFirst();
  if (!a) throw notFound('Appointment');
  assertBranchAccess(auth, a.branchId);
  if (isOwnScopeOnly(auth)) {
    const mine = auth.staffId
      ? await tx.selectFrom('appointmentItems').select('id').where('appointmentId', '=', id).where('staffId', '=', auth.staffId).limit(1).executeTakeFirst()
      : undefined;
    if (!mine) throw notFound('Appointment');
  }
  return a;
}

function assertVersion(a: { version: number }, version: number | undefined): void {
  if (version !== undefined && a.version !== version) {
    throw new AppError(409, 'STALE_VERSION', 'Someone else just changed this appointment. Refresh to see the latest details, then try again.', { currentVersion: a.version });
  }
}

function overrideHours(auth: AuthContext, settings: OrgSettings, requested: boolean): boolean {
  if (requested && !hasPermission(auth, 'appointments.override_hours')) {
    throw new AppError(403, 'FORBIDDEN', 'Only a manager can book outside working hours.');
  }
  return requested || settings.allowOutsideHours;
}

async function insertItems(tx: Tx, orgId: string, branchId: string, appointmentId: string, plans: ItemPlan[], blocks: boolean): Promise<void> {
  await tx
    .insertInto('appointmentItems')
    .values(
      plans.map((p) => ({
        organizationId: orgId,
        branchId,
        appointmentId,
        serviceId: p.serviceId,
        staffId: p.staffId,
        sortOrder: p.sortOrder,
        startAt: p.startAt,
        endAt: p.endAt,
        blockedUntil: p.blockedUntil,
        durationMinutes: p.durationMinutes,
        bufferMinutes: p.bufferMinutes,
        price: p.price,
        customerPackageItemId: p.customerPackageItemId,
        blocksSchedule: blocks && p.staffId !== null && p.startAt !== null,
      })),
    )
    .execute();
}

// ───────────── Create ─────────────
export async function createAppointment(tx: Tx, auth: AuthContext, input: CreateAppointmentInput & { source: NonNullable<CreateAppointmentInput['source']> }): Promise<string> {
  const orgId = requireOrgId(auth);
  assertBranchAccess(auth, input.branchId);
  const [branch, settings] = await Promise.all([loadBranch(tx, orgId, input.branchId), loadSettings(tx, orgId)]);
  const customer = await tx.selectFrom('customers').select(['id', 'fullName', 'status']).where('organizationId', '=', orgId).where('id', '=', input.customerId).executeTakeFirst();
  if (!customer) throw notFound('Customer');
  if (customer.status === 'archived') throw new AppError(409, 'CONFLICT', 'This customer has been archived. Restore them to book an appointment.');

  const latest = Date.now() + settings.maxAdvanceBookingDays * 86_400_000;
  if (input.items.some((i) => i.startAt && new Date(i.startAt).getTime() > latest)) {
    throw new AppError(422, 'BOOKING_TOO_FAR', `Bookings can be made up to ${settings.maxAdvanceBookingDays} days ahead. Choose an earlier date.`);
  }
  const plans = await planItems(tx, input.items, {
    orgId,
    branch,
    settings,
    customerId: customer.id,
    allowOutsideHours: overrideHours(auth, settings, input.allowOutsideHours ?? false),
  });
  const sum = summarizePlans(plans);
  const localDate = localDateOf(sum.startAt, branch.timezone);
  const bookingNumber = await nextBookingNumber(tx, orgId, settings.bookingPrefix, localDate);
  const status = input.status ?? 'scheduled';

  const row = await tx
    .insertInto('appointments')
    .values({
      organizationId: orgId,
      branchId: branch.id,
      bookingNumber,
      customerId: customer.id,
      source: input.source,
      status,
      localDate,
      startAt: sum.startAt,
      endAt: sum.endAt,
      totalDurationMinutes: sum.totalDurationMinutes,
      estimatedAmount: sum.estimatedAmount,
      notes: input.notes ?? null,
      internalNotes: input.internalNotes ?? null,
      createdBy: auth.userId || null,
      updatedBy: auth.userId || null,
    })
    .returning('id')
    .executeTakeFirstOrThrow();
  await insertItems(tx, orgId, branch.id, row.id, plans, true);
  await addEvent(tx, auth, orgId, row.id, 'created', { source: input.source, items: plans.length }, { to: status });
  await audit(tx, auth, {
    action: 'appointment.created',
    entityType: 'appointment',
    entityId: row.id,
    branchId: branch.id,
    summary: `Booking ${bookingNumber} created for ${customer.fullName}`,
    after: { bookingNumber, customerId: customer.id, startAt: sum.startAt, services: plans.map((p) => p.serviceId), staff: plans.map((p) => p.staffId) },
  });
  await queueAppointmentMessages(tx, auth, orgId, settings, row.id, 'confirmation', { reminders: true, message: input.notifyCustomer ?? true });
  return row.id;
}

// ───────────── Edit / move ─────────────
const signature = (items: Array<{ serviceId: string; staffId: string | null; startAt: Date | null; durationMinutes: number }>) =>
  items.map((i) => `${i.serviceId}|${i.staffId}|${i.startAt?.getTime() ?? 'x'}|${i.durationMinutes}`).join(',');

async function applyItemChange(
  tx: Tx,
  auth: AuthContext,
  orgId: string,
  branch: BranchRow,
  settings: OrgSettings,
  a: AppointmentRow,
  items: AppointmentItemInput[],
  opts: { allowOutsideHours: boolean; notifyCustomer: boolean },
): Promise<{ rescheduled: boolean }> {
  if (a.invoiceId) throw new AppError(409, 'APPOINTMENT_ALREADY_BILLED', 'This appointment has already been billed, so its services cannot be changed.');
  if (['completed', 'cancelled', 'no_show'].includes(a.status)) {
    throw new AppError(409, 'INVALID_STATUS_TRANSITION', `A ${a.status === 'completed' ? 'completed' : 'cancelled'} appointment cannot be rescheduled. Restore it first.`);
  }
  const existing = await tx
    .selectFrom('appointmentItems')
    .select(['serviceId', 'staffId', 'startAt', 'durationMinutes', 'sortOrder'])
    .where('appointmentId', '=', a.id)
    .orderBy('sortOrder')
    .execute();
  const existingItems: ExistingItem[] = existing.map((e) => ({ serviceId: e.serviceId, staffId: e.staffId, startAt: e.startAt }));

  const plans = await planItems(tx, items, {
    orgId,
    branch,
    settings,
    customerId: a.customerId,
    excludeAppointmentId: a.id,
    allowOutsideHours: opts.allowOutsideHours,
    allowPast: ['checked_in', 'in_service'].includes(a.status),
    existing: existingItems,
  });
  const sum = summarizePlans(plans);
  const before = signature(existing);
  const after = signature(plans.map((p) => ({ serviceId: p.serviceId, staffId: p.staffId, startAt: p.startAt, durationMinutes: p.durationMinutes })));
  const servicesChanged = existing.map((e) => e.serviceId).join() !== plans.map((p) => p.serviceId).join();
  const staffChanged = existing.map((e) => e.staffId).join() !== plans.map((p) => p.staffId).join();
  const timeChanged = existing.map((e) => e.startAt?.getTime()).join() !== plans.map((p) => p.startAt!.getTime()).join();

  if (before !== after) {
    await tx.deleteFrom('appointmentItems').where('appointmentId', '=', a.id).execute();
    await insertItems(tx, orgId, branch.id, a.id, plans, true);
    if (['in_service'].includes(a.status)) {
      await tx.updateTable('appointmentItems').set({ status: 'in_service' }).where('appointmentId', '=', a.id).where('sortOrder', '=', 0).execute();
    }
  }
  // A waiting walk-in being given a time is a first booking, not a reschedule.
  const isReschedule = timeChanged && a.status !== 'waiting';
  await tx
    .updateTable('appointments')
    .set({
      status: a.status === 'waiting' ? 'scheduled' : a.status,
      startAt: sum.startAt,
      endAt: sum.endAt,
      localDate: localDateOf(sum.startAt, branch.timezone),
      totalDurationMinutes: sum.totalDurationMinutes,
      estimatedAmount: sum.estimatedAmount,
      ...(isReschedule ? { rescheduleCount: a.rescheduleCount + 1, lastRescheduledAt: new Date() } : {}),
    })
    .where('id', '=', a.id)
    .execute();

  if (isReschedule) await addEvent(tx, auth, orgId, a.id, 'rescheduled', { from: a.startAt?.toISOString(), to: sum.startAt.toISOString() });
  if (staffChanged && !timeChanged) await addEvent(tx, auth, orgId, a.id, 'staff_changed', { from: existing.map((e) => e.staffId), to: plans.map((p) => p.staffId) });
  if (servicesChanged) await addEvent(tx, auth, orgId, a.id, 'services_changed', { from: existing.map((e) => e.serviceId), to: plans.map((p) => p.serviceId) });

  if (timeChanged) {
    await cancelAppointmentReminders(tx, orgId, a.id, 'Appointment was rescheduled');
    await queueAppointmentMessages(tx, auth, orgId, settings, a.id, 'rescheduled', { reminders: true, message: opts.notifyCustomer && isReschedule });
  }
  return { rescheduled: isReschedule };
}

export async function updateAppointment(tx: Tx, auth: AuthContext, id: string, input: UpdateAppointmentInput): Promise<void> {
  const orgId = requireOrgId(auth);
  const a = await lockAppointment(tx, auth, orgId, id);
  assertVersion(a, input.version);
  const [branch, settings] = await Promise.all([loadBranch(tx, orgId, a.branchId), loadSettings(tx, orgId)]);

  if (input.customerId && input.customerId !== a.customerId) {
    if (a.invoiceId) throw new AppError(409, 'APPOINTMENT_ALREADY_BILLED', 'This appointment has already been billed.');
    const c = await tx.selectFrom('customers').select('id').where('organizationId', '=', orgId).where('id', '=', input.customerId).where('status', '!=', 'archived').executeTakeFirst();
    if (!c) throw notFound('Customer');
    await tx.updateTable('appointments').set({ customerId: input.customerId }).where('id', '=', id).execute();
  }

  if (input.items) {
    await applyItemChange(tx, auth, orgId, branch, settings, { ...a, customerId: input.customerId ?? a.customerId }, input.items, {
      allowOutsideHours: overrideHours(auth, settings, input.allowOutsideHours ?? false),
      notifyCustomer: input.notifyCustomer ?? true,
    });
  }

  await tx
    .updateTable('appointments')
    .set({
      ...(input.notes !== undefined ? { notes: input.notes } : {}),
      ...(input.internalNotes !== undefined ? { internalNotes: input.internalNotes } : {}),
      updatedBy: auth.userId || null,
      version: a.version + 1,
    })
    .where('id', '=', id)
    .execute();
  await audit(tx, auth, { action: 'appointment.updated', entityType: 'appointment', entityId: id, branchId: a.branchId, summary: `Booking ${a.bookingNumber} updated`, after: { items: input.items?.length, notes: input.notes } });
}

export async function moveAppointment(tx: Tx, auth: AuthContext, id: string, input: MoveAppointmentInput): Promise<void> {
  const orgId = requireOrgId(auth);
  const a = await lockAppointment(tx, auth, orgId, id);
  assertVersion(a, input.version);
  const [branch, settings] = await Promise.all([loadBranch(tx, orgId, a.branchId), loadSettings(tx, orgId)]);
  const rows = await tx
    .selectFrom('appointmentItems')
    .select(['id', 'serviceId', 'staffId', 'startAt', 'durationMinutes', 'customerPackageItemId'])
    .where('appointmentId', '=', id)
    .orderBy('sortOrder')
    .execute();
  const dragged = rows.find((r) => r.id === input.itemId);
  if (!dragged) throw notFound('Service line');
  if (a.status === 'waiting') throw new AppError(409, 'INVALID_STATUS_TRANSITION', 'Assign a team member to this walk-in before placing it on the calendar.');
  const items: AppointmentItemInput[] = rows.map((r) => {
    if (!r.staffId || !r.startAt) throw new AppError(409, 'CONFLICT', 'Every service needs a team member and a time.');
    const isDragged = r.id === input.itemId;
    return {
      serviceId: r.serviceId,
      staffId: isDragged && input.staffId ? input.staffId : r.staffId,
      startAt: isDragged ? input.startAt : r.startAt.toISOString(),
      durationMinutes: isDragged && input.durationMinutes ? input.durationMinutes : r.durationMinutes,
      customerPackageItemId: r.customerPackageItemId,
    };
  });
  const { rescheduled } = await applyItemChange(tx, auth, orgId, branch, settings, a, items, {
    allowOutsideHours: overrideHours(auth, settings, input.allowOutsideHours ?? false),
    notifyCustomer: input.notifyCustomer ?? true,
  });
  await tx.updateTable('appointments').set({ updatedBy: auth.userId || null, version: a.version + 1 }).where('id', '=', id).execute();
  await audit(tx, auth, {
    action: rescheduled ? 'appointment.rescheduled' : 'appointment.staff_reassigned',
    entityType: 'appointment',
    entityId: id,
    branchId: a.branchId,
    summary: `Booking ${a.bookingNumber} ${rescheduled ? 'moved' : 'reassigned'}`,
    before: { startAt: dragged.startAt, staffId: dragged.staffId, durationMinutes: dragged.durationMinutes },
    after: { startAt: input.startAt, staffId: input.staffId ?? dragged.staffId, durationMinutes: input.durationMinutes ?? dragged.durationMinutes },
  });
}

// ───────────── Status changes ─────────────
const OWN_SCOPE_ALLOWED: AppointmentStatus[] = ['in_service', 'completed'];

export async function changeStatus(tx: Tx, auth: AuthContext, id: string, input: AppointmentStatusInput): Promise<void> {
  const orgId = requireOrgId(auth);
  const a = await lockAppointment(tx, auth, orgId, id);
  assertVersion(a, input.version);
  const from = a.status as AppointmentStatus;
  let to = input.status;
  const settings = await loadSettings(tx, orgId);

  const needsCancelPermission = ['cancelled', 'no_show'].includes(to) || ['cancelled', 'no_show'].includes(from);
  if (needsCancelPermission && !hasPermission(auth, 'appointments.cancel')) {
    throw new AppError(403, 'FORBIDDEN', "You don't have permission to cancel or restore appointments. Ask your manager.");
  }
  if (!needsCancelPermission && !hasPermission(auth, 'appointments.status')) {
    throw new AppError(403, 'FORBIDDEN', "You don't have permission to update appointment status.");
  }
  if (isOwnScopeOnly(auth) && !OWN_SCOPE_ALLOWED.includes(to)) {
    throw new AppError(403, 'FORBIDDEN', 'You can start and complete your own services. Ask the front desk for other changes.');
  }

  // A cancelled walk-in that never got a time returns to the waiting list, not to the calendar.
  if (to === 'scheduled' && from !== 'waiting' && !a.startAt) to = 'waiting';
  if (from === to) return;
  if (!canTransition(from, to) && !(to === 'waiting' && ['cancelled', 'no_show'].includes(from))) {
    throw new AppError(409, 'INVALID_STATUS_TRANSITION', `This appointment is ${from.replace('_', ' ')}, so it cannot be changed to ${to.replace('_', ' ')}.`, { from, to });
  }
  if (a.invoiceId && ['cancelled', 'no_show', 'scheduled', 'confirmed', 'checked_in', 'in_service', 'waiting'].includes(to)) {
    throw new AppError(409, 'APPOINTMENT_ALREADY_BILLED', 'This appointment has already been billed. Cancel the bill first if it needs to change.');
  }
  if (from === 'waiting' && ['checked_in', 'in_service'].includes(to)) {
    throw new AppError(422, 'STAFF_UNAVAILABLE', 'Choose a team member for this walk-in first, then start the service.');
  }

  const now = new Date();
  const patch: Record<string, unknown> = { status: to, updatedBy: auth.userId || null, version: a.version + 1 };
  const itemPatch: Record<string, unknown> = {};

  switch (to) {
    case 'checked_in':
      Object.assign(patch, { checkedInAt: a.checkedInAt ?? now, arrivedAt: a.arrivedAt ?? now });
      if (from === 'in_service') {
        Object.assign(patch, { serviceStartedAt: null });
        Object.assign(itemPatch, { status: 'pending' });
      }
      break;
    case 'in_service':
      Object.assign(patch, { serviceStartedAt: a.serviceStartedAt ?? now, checkedInAt: a.checkedInAt ?? now, arrivedAt: a.arrivedAt ?? now, completedAt: null });
      Object.assign(itemPatch, { status: 'in_service' });
      break;
    case 'completed':
      Object.assign(patch, { completedAt: now, serviceStartedAt: a.serviceStartedAt ?? now });
      Object.assign(itemPatch, { status: 'completed' });
      break;
    case 'cancelled':
    case 'no_show':
      Object.assign(patch, to === 'cancelled' ? { cancelledAt: now, cancelledBy: auth.userId || null, cancellationReason: input.reason ?? null } : { noShowAt: now, cancellationReason: input.reason ?? null });
      Object.assign(itemPatch, { status: 'cancelled', blocksSchedule: false });
      break;
    case 'scheduled':
    case 'confirmed':
      if (['cancelled', 'no_show'].includes(from)) {
        Object.assign(patch, { cancelledAt: null, cancelledBy: null, cancellationReason: null, noShowAt: null });
      }
      break;
    case 'waiting':
      Object.assign(patch, { cancelledAt: null, cancelledBy: null, cancellationReason: null });
      break;
    default:
      break;
  }

  // Restoring something that blocks a stylist's time must pass the same availability checks as a new booking.
  const restoring = ['cancelled', 'no_show'].includes(from) && BLOCKING.includes(to);
  if (restoring) {
    const branch = await loadBranch(tx, orgId, a.branchId);
    const rows = await tx
      .selectFrom('appointmentItems')
      .select(['serviceId', 'staffId', 'startAt', 'durationMinutes', 'customerPackageItemId'])
      .where('appointmentId', '=', id)
      .orderBy('sortOrder')
      .execute();
    const items: AppointmentItemInput[] = rows.map((r) => ({ serviceId: r.serviceId, staffId: r.staffId!, startAt: r.startAt!.toISOString(), durationMinutes: r.durationMinutes, customerPackageItemId: r.customerPackageItemId }));
    await planItems(tx, items, { orgId, branch, settings, customerId: a.customerId, excludeAppointmentId: id, allowOutsideHours: true, allowPast: true });
    await tx.updateTable('appointmentItems').set({ status: 'pending', blocksSchedule: true }).where('appointmentId', '=', id).execute();
    await addEvent(tx, auth, orgId, id, 'restored', null, { from, to });
  }

  if (Object.keys(itemPatch).length && !restoring) {
    let q = tx.updateTable('appointmentItems').set(itemPatch).where('appointmentId', '=', id).where('status', '!=', 'cancelled');
    if (to === 'in_service' && from !== 'completed') q = q.where('status', 'in', ['pending', 'in_service']);
    await q.execute();
  }
  if (to === 'completed') {
    // Finishing early gives the unused time back, so the next customer or walk-in can take it: the service ends now
    // (clean-up time still follows) and later services of the same visit that never started are released.
    // Whole minutes, like every start time the planner offers, so the next walk-in can begin right away.
    await sql`update appointment_items set
                blocked_until = case when ${now}::timestamptz < end_at
                                     then greatest(date_trunc('minute', ${now}::timestamptz), start_at + interval '1 minute') + buffer_minutes * interval '1 minute'
                                     else greatest(date_trunc('minute', ${now}::timestamptz), end_at) end,
                end_at = case when ${now}::timestamptz < end_at then greatest(date_trunc('minute', ${now}::timestamptz), start_at + interval '1 minute') else end_at end
              where appointment_id = ${id} and blocks_schedule and start_at <= ${now}::timestamptz and blocked_until > ${now}::timestamptz`.execute(tx);
    await sql`update appointment_items set blocks_schedule = false
              where appointment_id = ${id} and blocks_schedule and status <> 'cancelled' and start_at > ${now}::timestamptz`.execute(tx);
  }
  if (to === 'in_service' && from === 'completed') {
    // Undoing "completed": take the team member's time back (this fails with a clear message if it was booked meanwhile).
    await sql`update appointment_items set
                end_at = start_at + duration_minutes * interval '1 minute',
                blocked_until = start_at + (duration_minutes + buffer_minutes) * interval '1 minute',
                blocks_schedule = true
              where appointment_id = ${id} and status <> 'cancelled' and staff_id is not null and start_at is not null`.execute(tx);
  }
  await tx.updateTable('appointments').set(patch).where('id', '=', id).execute();
  await addEvent(tx, auth, orgId, id, 'status_changed', input.reason ? { reason: input.reason } : null, { from, to });
  await audit(tx, auth, {
    action: `appointment.${to}`,
    entityType: 'appointment',
    entityId: id,
    branchId: a.branchId,
    summary: `Booking ${a.bookingNumber}: ${from} → ${to}`,
    before: { status: from },
    after: { status: to, reason: input.reason },
  });

  if (to === 'cancelled' || to === 'no_show') {
    await cancelAppointmentReminders(tx, orgId, id, to === 'cancelled' ? 'Appointment was cancelled' : 'Marked as no-show');
    if (to === 'cancelled') await queueAppointmentMessages(tx, auth, orgId, settings, id, 'cancellation', { reminders: false, message: input.notifyCustomer ?? true });
  }
  if (restoring && a.startAt) {
    await queueAppointmentMessages(tx, auth, orgId, settings, id, 'confirmation', { reminders: true, message: false });
  }
  if (['completed', 'cancelled', 'no_show'].includes(to) || ['completed', 'cancelled', 'no_show'].includes(from)) {
    await refreshCustomerStats(tx, orgId, a.customerId);
  }
}

// ───────────── Walk-ins ─────────────
export async function createWalkIn(tx: Tx, auth: AuthContext, input: CreateWalkInInput): Promise<string> {
  const orgId = requireOrgId(auth);
  assertBranchAccess(auth, input.branchId);
  const [org, branch, settings] = await Promise.all([loadOrg(tx, orgId), loadBranch(tx, orgId, input.branchId), loadSettings(tx, orgId)]);

  if (input.startNow && input.items.some((i) => !i.staffId)) {
    throw new AppError(422, 'STAFF_UNAVAILABLE', 'Choose a team member for each service to start right away.');
  }
  let customerId = input.customerId ?? null;
  if (!customerId) {
    if (!hasPermission(auth, 'customers.create')) throw new AppError(403, 'FORBIDDEN', "You don't have permission to add customers.");
    customerId = await createCustomerRecord(tx, auth, org, input.newCustomer!, { registeredBranchId: branch.id });
  } else {
    const c = await tx.selectFrom('customers').select(['id', 'status']).where('organizationId', '=', orgId).where('id', '=', customerId).executeTakeFirst();
    if (!c) throw notFound('Customer');
    if (c.status === 'archived') throw new AppError(409, 'CONFLICT', 'This customer has been archived.');
  }

  const services = await loadServicesForBranch(tx, orgId, branch.id, input.items.map((i) => i.serviceId));
  const staffIds = [...new Set(input.items.map((i) => i.staffId).filter((v): v is string => !!v))];
  const qualified = staffIds.length
    ? await tx.selectFrom('staffServices').select(['staffId', 'serviceId', 'durationMinutes']).where('staffId', 'in', staffIds).where('isActive', '=', true).execute()
    : [];
  const today = todayIn(branch.timezone);
  const bookingNumber = await nextBookingNumber(tx, orgId, settings.bookingPrefix, today);
  const queueNumber = await nextQueueNumber(tx, orgId, branch.id, today);

  const lines = input.items.map((item, index) => {
    const service = services.get(item.serviceId)!;
    if (item.staffId) {
      const map = qualified.find((q) => q.staffId === item.staffId && q.serviceId === item.serviceId);
      if (!map) throw new AppError(422, 'STAFF_NOT_QUALIFIED', `That team member is not set up to perform "${service.name}". Choose someone else.`);
      return { item, index, service, duration: map.durationMinutes ?? service.durationMinutes };
    }
    return { item, index, service, duration: service.durationMinutes };
  });

  const appt = await tx
    .insertInto('appointments')
    .values({
      organizationId: orgId,
      branchId: branch.id,
      bookingNumber,
      customerId,
      source: 'walk_in',
      status: 'waiting',
      localDate: today,
      queueNumber,
      totalDurationMinutes: lines.reduce((a, l) => a + l.duration, 0),
      estimatedAmount: lines.reduce((a, l) => a + l.service.price, 0),
      notes: input.notes ?? null,
      arrivedAt: new Date(),
      createdBy: auth.userId,
      updatedBy: auth.userId,
    })
    .returning('id')
    .executeTakeFirstOrThrow();
  await tx
    .insertInto('appointmentItems')
    .values(
      lines.map((l) => ({
        organizationId: orgId,
        branchId: branch.id,
        appointmentId: appt.id,
        serviceId: l.item.serviceId,
        staffId: l.item.staffId ?? null,
        sortOrder: l.index,
        durationMinutes: l.duration,
        bufferMinutes: effectiveBuffer([l.service], settings),
        price: l.service.price,
        blocksSchedule: false,
      })),
    )
    .execute();
  await addEvent(tx, auth, orgId, appt.id, 'created', { source: 'walk_in', queueNumber }, { to: 'waiting' });
  await audit(tx, auth, { action: 'walkin.created', entityType: 'appointment', entityId: appt.id, branchId: branch.id, summary: `Walk-in ${bookingNumber} (queue #${queueNumber})`, after: { customerId, services: input.items.map((i) => i.serviceId) } });

  if (input.startNow) {
    await assignWalkIn(tx, auth, appt.id, { assignments: lines.map((l) => ({ index: l.index, staffId: l.item.staffId! })), startNow: true });
  }
  return appt.id;
}

interface WalkInAssignment {
  /** Appointment item id, or the zero-based position when the item ids are not known yet. */
  itemId?: string;
  index?: number;
  staffId: string;
}

export async function assignWalkIn(tx: Tx, auth: AuthContext, id: string, input: { version?: number; assignments: WalkInAssignment[]; startNow: boolean }): Promise<void> {
  const orgId = requireOrgId(auth);
  const a = await lockAppointment(tx, auth, orgId, id);
  if (a.status !== 'waiting') throw new AppError(409, 'INVALID_STATUS_TRANSITION', 'This customer has already been assigned to a team member.');
  assertVersion(a, input.version);
  const [branch, settings] = await Promise.all([loadBranch(tx, orgId, a.branchId), loadSettings(tx, orgId)]);
  const rows = await tx.selectFrom('appointmentItems').selectAll().where('appointmentId', '=', id).orderBy('sortOrder').execute();

  const staffFor = rows.map((r, i) => input.assignments.find((x) => x.itemId === r.id)?.staffId ?? input.assignments.find((x) => x.index === i)?.staffId ?? r.staffId);
  if (staffFor.some((s) => !s)) throw new AppError(422, 'STAFF_UNAVAILABLE', 'Choose a team member for each service.');

  const services = await loadServicesForBranch(tx, orgId, branch.id, rows.map((r) => r.serviceId));
  const tz = branch.timezone;
  const fmt = (ms: number) => DateTime.fromMillis(ms, { zone: tz }).toFormat('h:mm a');
  let cursor = Math.floor(Date.now() / MINUTE) * MINUTE;
  const extraBusy = new Map<string, Interval[]>();
  const planInput: AppointmentItemInput[] = [];

  for (const [i, row] of rows.entries()) {
    const staffId = staffFor[i]!;
    const service = services.get(row.serviceId)!;
    const date = localDateOf(new Date(cursor), tz);
    const day = await loadDayContext(tx, orgId, branch, date);
    const load = await loadStaffDays(tx, orgId, branch, day, { staffIds: [staffId], serviceIds: [row.serviceId], services, excludeAppointmentId: id, extraBusy, includeUnqualified: true });
    const staffDay = load.days[0];
    if (!staffDay) throw new AppError(422, 'STAFF_UNAVAILABLE', 'This team member does not work at this branch.');
    if (!staffDay.qualified) throw new AppError(422, 'STAFF_NOT_QUALIFIED', `${staffDay.displayName} is not set up to perform "${service.name}". Choose someone else.`);
    const buffer = effectiveBuffer([service], settings);
    // "Start now" begins at the current minute and runs the services back-to-back; otherwise take the first free slot.
    let start = cursor;
    if (!input.startNow) {
      const result = computeAvailability({
        branchOpen: day.branchOpen,
        holiday: day.holiday,
        now: cursor,
        minNoticeMinutes: 0,
        slotIntervalMinutes: settings.slotIntervalMinutes,
        bufferMinutes: buffer,
        allowOutsideHours: false,
        staff: [staffDay],
        formatTime: fmt,
      });
      const slot = result.staff[0]?.slots[0];
      if (slot === undefined) throw new AppError(422, 'STAFF_UNAVAILABLE', `${staffDay.displayName} has no free time left today. Choose another team member.`, { staffId });
      start = slot;
    }
    planInput.push({ serviceId: row.serviceId, staffId, startAt: new Date(start).toISOString(), durationMinutes: row.durationMinutes, customerPackageItemId: row.customerPackageItemId });
    const end = start + row.durationMinutes * MINUTE;
    extraBusy.set(staffId, [...(extraBusy.get(staffId) ?? []), { start, end: end + buffer * MINUTE }]);
    cursor = end + buffer * MINUTE;
  }

  const plans = await planItems(tx, planInput, { orgId, branch, settings, customerId: a.customerId, excludeAppointmentId: id, allowOutsideHours: false, allowPast: true });
  for (const [i, row] of rows.entries()) {
    const p = plans[i]!;
    await tx
      .updateTable('appointmentItems')
      .set({
        staffId: p.staffId,
        startAt: p.startAt,
        endAt: p.endAt,
        blockedUntil: p.blockedUntil,
        durationMinutes: p.durationMinutes,
        bufferMinutes: p.bufferMinutes,
        price: p.price,
        blocksSchedule: true,
        status: input.startNow && i === 0 ? 'in_service' : 'pending',
      })
      .where('id', '=', row.id)
      .execute();
  }
  const sum = summarizePlans(plans);
  const now = new Date();
  const to = input.startNow ? 'in_service' : 'checked_in';
  await tx
    .updateTable('appointments')
    .set({
      status: to,
      startAt: sum.startAt,
      endAt: sum.endAt,
      localDate: localDateOf(sum.startAt, tz),
      totalDurationMinutes: sum.totalDurationMinutes,
      estimatedAmount: sum.estimatedAmount,
      checkedInAt: now,
      ...(input.startNow ? { serviceStartedAt: now } : {}),
      version: a.version + 1,
      updatedBy: auth.userId,
    })
    .where('id', '=', id)
    .execute();
  await addEvent(tx, auth, orgId, id, 'status_changed', { assignments: planInput.map((p) => ({ serviceId: p.serviceId, staffId: p.staffId, startAt: p.startAt })) }, { from: 'waiting', to });
  await audit(tx, auth, { action: 'walkin.assigned', entityType: 'appointment', entityId: id, branchId: a.branchId, summary: `Walk-in ${a.bookingNumber} assigned${input.startNow ? ' and started' : ''}`, after: { staff: planInput.map((p) => p.staffId), startAt: sum.startAt } });
}
