import { renderTemplate, type NotificationChannel } from '@salon/shared';
import { DateTime } from 'luxon';
import type { AuthContext } from '../../core/auth-context.js';
import type { OrgSettings } from '../../core/validation.js';
import type { Tx } from '../../db/tenant.js';
import { availableChannels } from '../notifications/outbox.js';

// Team members hear about their own bookings: an in-app feed (the bell) for every change, and for a new booking also a
// message to their phone (WhatsApp, else SMS, else email) through the usual outbox, when the salon has a channel set up
// and has not switched these messages off. Nobody is told about a change they made themselves.

export type StaffNoticeKind = 'booking_new' | 'booking_moved' | 'booking_removed' | 'booking_cancelled' | 'request_answered' | 'leave_answered';

export interface StaffNotice {
  staffId: string;
  branchId: string;
  kind: StaffNoticeKind;
  title: string;
  body?: string | null;
  link?: string | null;
  appointmentId?: string | null;
}

export async function notifyStaff(tx: Tx, auth: AuthContext, orgId: string, notices: StaffNotice[]): Promise<void> {
  const rows = notices.filter((n) => n.staffId !== auth.staffId);
  if (!rows.length) return;
  await tx
    .insertInto('staffNotifications')
    .values(rows.map((n) => ({ organizationId: orgId, branchId: n.branchId, staffId: n.staffId, kind: n.kind, title: n.title.slice(0, 200), body: n.body ?? null, link: n.link ?? '/my-appointments', appointmentId: n.appointmentId ?? null })))
    .execute();
}

/** Who has which services in a booking and when their part starts (first service), before a change. */
export type StaffStarts = Map<string, Date | null>;

export async function staffStarts(tx: Tx, appointmentId: string): Promise<StaffStarts> {
  const rows = await tx.selectFrom('appointmentItems').select(['staffId', 'startAt']).where('appointmentId', '=', appointmentId).where('status', '!=', 'cancelled').orderBy('sortOrder').execute();
  const map: StaffStarts = new Map();
  for (const r of rows) if (r.staffId && !map.has(r.staffId)) map.set(r.staffId, r.startAt);
  return map;
}

async function bookingContext(tx: Tx, orgId: string, appointmentId: string, includeCancelled: boolean) {
  const a = await tx
    .selectFrom('appointments as a')
    .innerJoin('customers as c', 'c.id', 'a.customerId')
    .innerJoin('branches as b', 'b.id', 'a.branchId')
    .innerJoin('organizations as o', 'o.id', 'a.organizationId')
    .select(['a.id', 'a.branchId', 'a.bookingNumber', 'c.fullName as customerName', 'b.name as branchName', 'b.timezone', 'o.name as salonName'])
    .where('a.organizationId', '=', orgId)
    .where('a.id', '=', appointmentId)
    .executeTakeFirstOrThrow();
  let q = tx
    .selectFrom('appointmentItems as ai')
    .innerJoin('services as s', 's.id', 'ai.serviceId')
    .innerJoin('staff as st', 'st.id', 'ai.staffId')
    .select(['ai.staffId', 'ai.startAt', 's.name as serviceName', 'st.displayName', 'st.mobile', 'st.email'])
    .where('ai.appointmentId', '=', appointmentId)
    .orderBy('ai.sortOrder');
  if (!includeCancelled) q = q.where('ai.status', '!=', 'cancelled');
  const perStaff = new Map<string, { name: string; mobile: string | null; email: string | null; services: string[]; startAt: Date | null }>();
  for (const i of await q.execute()) {
    const p = perStaff.get(i.staffId!) ?? { name: i.displayName, mobile: i.mobile, email: i.email, services: [], startAt: i.startAt };
    p.services.push(i.serviceName);
    perStaff.set(i.staffId!, p);
  }
  return { ...a, perStaff };
}

const when = (d: Date | null, tz: string) => (d ? DateTime.fromJSDate(d).setZone(tz).toFormat('ccc d LLL, h:mm a') : 'time to be set');

/**
 * Tells team members what a change to a booking means for them. `before` is who had it and when their part started
 * before the change (empty for a new booking). New to someone → "New booking" (plus a phone message); same person, new
 * time → "Booking moved"; no longer theirs → "Taken off your list"; cancelled → "Booking cancelled".
 */
export async function bookingChanged(tx: Tx, auth: AuthContext, orgId: string, settings: OrgSettings, appointmentId: string, before: StaffStarts, opts: { cancelled?: boolean; walkIn?: boolean } = {}): Promise<void> {
  const ctx = await bookingContext(tx, orgId, appointmentId, !!opts.cancelled);
  const tz = ctx.timezone;
  const base = { branchId: ctx.branchId, appointmentId: ctx.id };
  const notices: StaffNotice[] = [];
  const fresh: string[] = [];

  if (opts.cancelled) {
    for (const [staffId, p] of ctx.perStaff) if (before.has(staffId)) notices.push({ ...base, staffId, kind: 'booking_cancelled', title: `Booking cancelled: ${ctx.customerName}`, body: `${p.services.join(', ')} · was ${when(before.get(staffId) ?? p.startAt, tz)}` });
  } else {
    for (const [staffId, p] of ctx.perStaff) {
      const was = before.get(staffId);
      if (!before.has(staffId) || was === null) {
        fresh.push(staffId);
        notices.push(opts.walkIn
          ? { ...base, staffId, kind: 'booking_new', title: `Walk-in for you: ${ctx.customerName}`, body: `${p.services.join(', ')} · ${p.startAt ? when(p.startAt, tz) : 'waiting at the desk'}`, link: '/my-day' }
          : { ...base, staffId, kind: 'booking_new', title: `New booking: ${ctx.customerName}`, body: `${p.services.join(', ')} · ${when(p.startAt, tz)}` });
      } else if (was?.getTime() !== p.startAt?.getTime()) {
        notices.push({ ...base, staffId, kind: 'booking_moved', title: `Booking moved: ${ctx.customerName}`, body: `${p.services.join(', ')} · now ${when(p.startAt, tz)}` });
      }
    }
    for (const [staffId, was] of before) {
      if (!ctx.perStaff.has(staffId)) notices.push({ ...base, staffId, kind: 'booking_removed', title: `No longer with you: ${ctx.customerName}`, body: `Booking ${ctx.bookingNumber}${was ? ` (${when(was, tz)})` : ''} is now with someone else.` });
    }
  }
  await notifyStaff(tx, auth, orgId, notices);
  if (fresh.length && !opts.walkIn && settings.notifyStaffOfBookings) await queueStaffMessages(tx, auth, orgId, ctx, fresh.filter((id) => id !== auth.staffId));
}

/** The phone message for a new booking: WhatsApp if possible, else SMS, else email, with the salon's own template. */
async function queueStaffMessages(tx: Tx, auth: AuthContext, orgId: string, ctx: Awaited<ReturnType<typeof bookingContext>>, staffIds: string[]): Promise<void> {
  if (!staffIds.length) return;
  const [channels, templates] = await Promise.all([
    availableChannels(tx, orgId),
    tx.selectFrom('notificationTemplates').select(['id', 'channel', 'subject', 'body', 'isActive']).where('organizationId', '=', orgId).where('eventType', '=', 'staff_new_booking').execute(),
  ]);
  if (!channels.size) return;
  for (const staffId of staffIds) {
    const p = ctx.perStaff.get(staffId)!;
    const recipients: Record<NotificationChannel, string | null> = { whatsapp: p.mobile, sms: p.mobile, email: p.email };
    const channel = (['whatsapp', 'sms', 'email'] as const).find((c) => channels.has(c) && recipients[c] && templates.some((t) => t.channel === c && t.isActive));
    if (!channel) continue;
    const template = templates.find((t) => t.channel === channel)!;
    const local = p.startAt ? DateTime.fromJSDate(p.startAt).setZone(ctx.timezone) : null;
    const variables = { staffName: p.name, customerName: ctx.customerName, salonName: ctx.salonName, branchName: ctx.branchName, services: p.services.join(', '), date: local ? local.toFormat('ccc, d LLLL') : '', time: local ? local.toFormat('h:mm a') : '', bookingNumber: ctx.bookingNumber };
    await tx
      .insertInto('notifications')
      .values({
        organizationId: orgId,
        branchId: ctx.branchId,
        customerId: null,
        staffId,
        eventType: 'staff_new_booking',
        category: 'appointment',
        channel,
        recipient: recipients[channel]!,
        subject: channel === 'email' && template.subject ? renderTemplate(template.subject, variables) : null,
        body: renderTemplate(template.body, variables),
        templateId: template.id,
        templateVariables: JSON.stringify(variables),
        sourceType: 'appointment',
        sourceId: ctx.id,
        dedupeKey: `staff:${ctx.id}:${staffId}:${p.startAt?.getTime() ?? 'walk-in'}:${channel}`,
        createdBy: auth.userId || null,
      })
      .onConflict((oc) => oc.columns(['organizationId', 'dedupeKey']).doNothing())
      .execute();
  }
}
