import {
  MARKETING_CATEGORIES,
  NOTIFICATION_EVENT_CATEGORY,
  renderTemplate,
  type NotificationCategory,
  type NotificationChannel,
  type NotificationEventType,
} from '@salon/shared';
import { DateTime } from 'luxon';
import { env } from '../../config/env.js';
import type { Tx } from '../../db/tenant.js';

// The outbox: business code calls enqueueNotification() inside its own transaction. Nothing here talks to a
// provider, so a WhatsApp outage can never roll back an appointment or a payment (requirement 89).

export interface EnqueueArgs {
  orgId: string;
  branchId: string | null;
  customerId: string;
  eventType: NotificationEventType;
  sourceType: string;
  sourceId: string;
  variables: Record<string, string | number | null | undefined>;
  /** Stable key so retries and duplicate events never send twice. Channel is appended automatically. */
  dedupeKey: string;
  scheduledFor?: Date;
  createdBy?: string | null;
  campaignId?: string | null;
  /** Restrict to a single channel (campaigns). */
  channel?: NotificationChannel;
  /** Campaign text that replaces the template body. */
  bodyOverride?: { subject: string | null; body: string };
}

const PLATFORM_CHANNELS: Record<NotificationChannel, boolean> = {
  whatsapp: env.WHATSAPP_PROVIDER !== 'none' && !!env.WHATSAPP_API_KEY,
  email: env.EMAIL_PROVIDER !== 'none' && !!env.SMTP_HOST,
  sms: env.SMS_PROVIDER !== 'none' && !!env.SMS_API_URL,
};

/** Channels that can actually deliver for this organization right now. */
export async function availableChannels(tx: Tx, orgId: string): Promise<Set<NotificationChannel>> {
  if (env.NOTIFICATIONS_MODE === 'disabled') return new Set();
  if (env.NOTIFICATIONS_MODE === 'console') return new Set(['whatsapp', 'email', 'sms']);
  const integrations = await tx
    .selectFrom('organizationIntegrations')
    .select('kind')
    .where('organizationId', '=', orgId)
    .where('kind', 'in', ['whatsapp', 'email', 'sms'])
    .where('status', '=', 'active')
    .execute();
  const set = new Set<NotificationChannel>();
  for (const c of ['whatsapp', 'email', 'sms'] as const) {
    if (PLATFORM_CHANNELS[c] || integrations.some((i) => i.kind === c)) set.add(c);
  }
  return set;
}

function inQuietHours(local: DateTime, start: string, end: string): boolean {
  const minutes = local.hour * 60 + local.minute;
  const [sh, sm] = start.split(':').map(Number);
  const [eh, em] = end.split(':').map(Number);
  const s = sh! * 60 + sm!;
  const e = eh! * 60 + em!;
  return s > e ? minutes >= s || minutes < e : minutes >= s && minutes < e;
}

/**
 * Reminders that would land in quiet hours are sent just before quiet hours begin (earlier is better than late);
 * promotional and payment reminders wait until quiet hours end.
 */
function respectQuietHours(at: Date, timezone: string, category: NotificationCategory, quietStart: string, quietEnd: string): Date {
  if (category === 'appointment' || category === 'receipt') return at;
  const local = DateTime.fromJSDate(at).setZone(timezone);
  if (!inQuietHours(local, quietStart, quietEnd)) return at;
  const [sh, sm] = quietStart.split(':').map(Number);
  const [eh, em] = quietEnd.split(':').map(Number);
  if (category === 'reminder') {
    let before = local.set({ hour: sh!, minute: sm!, second: 0, millisecond: 0 }).minus({ minutes: 5 });
    if (before > local) before = before.minus({ days: 1 });
    return before.toJSDate();
  }
  let after = local.set({ hour: eh!, minute: em!, second: 0, millisecond: 0 });
  if (after < local) after = after.plus({ days: 1 });
  return after.toJSDate();
}

export async function enqueueNotification(tx: Tx, args: EnqueueArgs): Promise<number> {
  const category = NOTIFICATION_EVENT_CATEGORY[args.eventType];
  const customer = await tx
    .selectFrom('customers')
    .select(['id', 'fullName', 'mobile', 'whatsappNumber', 'email', 'marketingConsent', 'status'])
    .where('organizationId', '=', args.orgId)
    .where('id', '=', args.customerId)
    .executeTakeFirst();
  if (!customer || customer.status === 'archived') return 0;

  const isMarketing = MARKETING_CATEGORIES.includes(category);
  if (isMarketing && !customer.marketingConsent) return 0;

  const [prefs, channels, settings, org] = await Promise.all([
    tx.selectFrom('customerNotificationPreferences').select(['channel', 'category', 'enabled']).where('customerId', '=', customer.id).execute(),
    availableChannels(tx, args.orgId),
    tx.selectFrom('organizationSettings').select(['quietHoursStart', 'quietHoursEnd']).where('organizationId', '=', args.orgId).executeTakeFirstOrThrow(),
    tx.selectFrom('organizations').select(['timezone']).where('id', '=', args.orgId).executeTakeFirstOrThrow(),
  ]);

  const recipients: Record<NotificationChannel, string | null> = {
    whatsapp: customer.whatsappNumber ?? customer.mobile,
    sms: customer.mobile,
    email: customer.email,
  };
  const prefFor = (channel: NotificationChannel): boolean | undefined => prefs.find((p) => p.channel === channel && p.category === category)?.enabled;

  // Channel policy: WhatsApp and email by default; SMS only when explicitly enabled or when WhatsApp cannot be used.
  let selected: NotificationChannel[] = (['whatsapp', 'email', 'sms'] as const).filter((channel) => {
    if (args.channel && channel !== args.channel) return false;
    if (!recipients[channel] || !channels.has(channel)) return false;
    const pref = prefFor(channel);
    if (pref === false) return false;
    if (channel === 'sms' && pref !== true && !args.channel) return false;
    return true;
  });
  if (!args.channel && !selected.includes('whatsapp') && recipients.sms && channels.has('sms') && prefFor('sms') !== false && prefFor('whatsapp') !== false) {
    selected = [...selected, 'sms'];
  }
  if (!selected.length) return 0;

  const templates = await tx
    .selectFrom('notificationTemplates')
    .select(['id', 'channel', 'subject', 'body', 'isActive'])
    .where('organizationId', '=', args.orgId)
    .where('eventType', '=', args.eventType)
    .execute();

  const scheduledFor = respectQuietHours(args.scheduledFor ?? new Date(), org.timezone, category, settings.quietHoursStart, settings.quietHoursEnd);
  const variables = { customerName: customer.fullName.split(' ')[0], ...args.variables };
  let queued = 0;
  for (const channel of selected) {
    const template = templates.find((t) => t.channel === channel);
    if (!args.bodyOverride && (!template || !template.isActive)) continue;
    const body = renderTemplate(args.bodyOverride?.body ?? template!.body, variables);
    const subjectSource = args.bodyOverride ? args.bodyOverride.subject : template!.subject;
    const subject = channel === 'email' && subjectSource ? renderTemplate(subjectSource, variables) : null;
    const result = await tx
      .insertInto('notifications')
      .values({
        organizationId: args.orgId,
        branchId: args.branchId,
        customerId: customer.id,
        campaignId: args.campaignId ?? null,
        eventType: args.eventType,
        category,
        channel,
        recipient: recipients[channel]!,
        subject,
        body,
        templateId: template?.id ?? null,
        templateVariables: JSON.stringify(variables),
        sourceType: args.sourceType,
        sourceId: args.sourceId,
        dedupeKey: `${args.dedupeKey}:${channel}`,
        scheduledFor,
        nextAttemptAt: scheduledFor,
        createdBy: args.createdBy ?? null,
      })
      .onConflict((oc) => oc.columns(['organizationId', 'dedupeKey']).doNothing())
      .executeTakeFirst();
    queued += Number(result.numInsertedOrUpdatedRows ?? 0);
  }
  return queued;
}

/** Cancels messages that have not been sent yet (e.g. reminders for a cancelled or moved booking). */
export async function cancelPendingNotifications(
  tx: Tx,
  orgId: string,
  sourceType: string,
  sourceId: string,
  eventTypes: NotificationEventType[],
  reason: string,
): Promise<void> {
  await tx
    .updateTable('notifications')
    .set({ status: 'cancelled', statusReason: reason })
    .where('organizationId', '=', orgId)
    .where('sourceType', '=', sourceType)
    .where('sourceId', '=', sourceId)
    .where('eventType', 'in', eventTypes)
    .where('status', '=', 'queued')
    .execute();
}
