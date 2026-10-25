import { DateTime } from 'luxon';
import type { AuthContext } from '../../core/auth-context.js';
import type { OrgSettings } from '../../core/validation.js';
import type { Tx } from '../../db/tenant.js';
import { cancelPendingNotifications, enqueueNotification } from '../notifications/outbox.js';

const MINUTE = 60_000;
const REMINDER_EVENTS = ['appointment_reminder'] as const;

async function loadContext(tx: Tx, orgId: string, appointmentId: string) {
  const a = await tx
    .selectFrom('appointments as a')
    .innerJoin('branches as b', 'b.id', 'a.branchId')
    .innerJoin('organizations as o', 'o.id', 'a.organizationId')
    .select(['a.id', 'a.bookingNumber', 'a.customerId', 'a.branchId', 'a.startAt', 'a.status', 'a.version', 'b.name as branchName', 'b.phone as branchPhone', 'b.timezone', 'o.name as salonName'])
    .where('a.organizationId', '=', orgId)
    .where('a.id', '=', appointmentId)
    .executeTakeFirstOrThrow();
  const items = await tx
    .selectFrom('appointmentItems as ai')
    .innerJoin('services as s', 's.id', 'ai.serviceId')
    .leftJoin('staff as st', 'st.id', 'ai.staffId')
    .select(['s.name as serviceName', 'st.displayName as staffName', 'ai.sortOrder'])
    .where('ai.appointmentId', '=', appointmentId)
    .orderBy('ai.sortOrder')
    .execute();
  const local = a.startAt ? DateTime.fromJSDate(a.startAt).setZone(a.timezone) : null;
  return {
    appointment: a,
    variables: {
      salonName: a.salonName,
      branchName: a.branchName,
      branchPhone: a.branchPhone ?? '',
      bookingNumber: a.bookingNumber,
      services: items.map((i) => i.serviceName).join(', '),
      staff: [...new Set(items.map((i) => i.staffName).filter(Boolean))].join(', ') || 'our team',
      date: local ? local.toFormat('ccc, d LLLL') : '',
      time: local ? local.toFormat('h:mm a') : '',
      manageLink: '',
    },
  };
}

export type AppointmentMessage = 'confirmation' | 'cancellation' | 'rescheduled';

/**
 * Queues customer messages for an appointment inside the caller's transaction. Delivery happens later in the
 * worker; if no channel is configured or the customer opted out, nothing is queued and booking still succeeds.
 */
export async function queueAppointmentMessages(
  tx: Tx,
  auth: AuthContext,
  orgId: string,
  settings: OrgSettings,
  appointmentId: string,
  kind: AppointmentMessage,
  options: { reminders: boolean; message: boolean } = { reminders: kind !== 'cancellation', message: true },
): Promise<void> {
  const { appointment: a, variables } = await loadContext(tx, orgId, appointmentId);
  const startMs = a.startAt?.getTime() ?? 0;
  const base = { orgId, branchId: a.branchId, customerId: a.customerId, sourceType: 'appointment', sourceId: a.id, variables, createdBy: auth.userId || null };

  if (options.message) {
    if (kind === 'confirmation') {
      await enqueueNotification(tx, { ...base, eventType: 'appointment_confirmation', dedupeKey: `appt:${a.id}:confirm:${startMs}` });
    } else if (kind === 'rescheduled') {
      await enqueueNotification(tx, { ...base, eventType: 'appointment_rescheduled', dedupeKey: `appt:${a.id}:resched:${startMs}` });
    } else {
      await enqueueNotification(tx, { ...base, eventType: 'appointment_cancellation', dedupeKey: `appt:${a.id}:cancel:${a.version}` });
    }
  }

  if (options.reminders && a.startAt) {
    const now = Date.now();
    for (const offset of settings.reminderOffsetsMinutes) {
      const when = startMs - offset * MINUTE;
      if (when <= now + MINUTE) continue;
      await enqueueNotification(tx, {
        ...base,
        eventType: 'appointment_reminder',
        dedupeKey: `appt:${a.id}:reminder:${offset}:${startMs}`,
        scheduledFor: new Date(when),
      });
    }
  }
}

/** Reminders for a booking that was cancelled or moved must never go out. */
export async function cancelAppointmentReminders(tx: Tx, orgId: string, appointmentId: string, reason: string): Promise<void> {
  await cancelPendingNotifications(tx, orgId, 'appointment', appointmentId, [...REMINDER_EVENTS], reason);
}
