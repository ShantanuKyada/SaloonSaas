import {
  campaignSchema,
  NOTIFICATION_EVENT_LABELS,
  notificationListQuery,
  renderTemplate,
  segmentFilterSchema,
  TEMPLATE_VARIABLES,
  templateUpdateSchema,
  type NotificationEventType,
  type NotificationLogItem,
} from '@salon/shared';
import { createHmac } from 'node:crypto';
import { sql } from 'kysely';
import { z } from 'zod';
import { env } from '../../config/env.js';
import { audit } from '../../core/audit.js';
import { requireOrgId } from '../../core/auth-context.js';
import { safeEqual } from '../../core/crypto.js';
import { AppError, notFound } from '../../core/errors.js';
import { createRouter, paged } from '../../core/router.js';
import { localDateConditions } from '../../core/sql.js';
import { loadSettings } from '../../core/validation.js';
import { canSeeContact, customerSearchCondition } from '../customers/service.js';
import { cancelCampaign, countRecipients, launchCampaign } from './campaigns.js';
import { applyDeliveryStatus } from './dispatcher.js';
import { availableChannels } from './outbox.js';

// ───────────── Templates ─────────────
const templates = createRouter('/notification-templates', 'Notifications');

templates.get('/', { summary: 'Message templates for every event and channel', permissions: ['notifications.view', 'notifications.manage'] }, async ({ tx, auth }) =>
  tx(async (t) => {
    const rows = await t.selectFrom('notificationTemplates').selectAll().where('organizationId', '=', requireOrgId(auth)).orderBy('eventType').orderBy('channel').execute();
    return rows.map((r) => ({
      id: r.id,
      eventType: r.eventType,
      eventLabel: NOTIFICATION_EVENT_LABELS[r.eventType as NotificationEventType] ?? r.eventType,
      channel: r.channel,
      name: r.name,
      subject: r.subject,
      body: r.body,
      isActive: r.isActive,
      providerTemplateName: r.providerTemplateName,
      variables: TEMPLATE_VARIABLES[r.eventType as NotificationEventType] ?? [],
    }));
  }),
);

const SAMPLE: Record<string, string> = {
  customerName: 'Meera', salonName: 'Glow Salon', branchName: 'Rajkot', services: 'Hair Spa', date: 'Sat, 15 October', time: '5:00 PM', staff: 'Rahul',
  bookingNumber: 'BK261015-001', branchPhone: '+91 98765 43210', manageLink: 'https://example.com/b/abc', amount: '₹4,500', receiptNumber: 'RCT-RJT-2627-00012',
  method: 'UPI', balance: '₹0', message: 'Enjoy 10% off this week.', daysSinceLastVisit: '60',
};

function checkPlaceholders(eventType: NotificationEventType, ...texts: Array<string | null | undefined>): string[] {
  const allowed = new Set(TEMPLATE_VARIABLES[eventType]);
  const unknown = new Set<string>();
  for (const text of texts) for (const m of (text ?? '').matchAll(/\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g)) if (!allowed.has(m[1]!)) unknown.add(m[1]!);
  return [...unknown];
}

templates.put('/:id', { summary: 'Edit a message template', permissions: ['notifications.manage'], body: templateUpdateSchema }, async ({ tx, auth, params, body }) =>
  tx(async (t) => {
    const orgId = requireOrgId(auth);
    const before = await t.selectFrom('notificationTemplates').selectAll().where('organizationId', '=', orgId).where('id', '=', params.id!).executeTakeFirst();
    if (!before) throw notFound('Template');
    const unknown = checkPlaceholders(before.eventType as NotificationEventType, body.body, body.subject);
    if (unknown.length) {
      throw new AppError(400, 'VALIDATION_ERROR', `These placeholders are not available for this message: ${unknown.map((u) => `{{${u}}}`).join(', ')}.`, { issues: [{ path: 'body', message: 'Unknown placeholder' }], allowed: TEMPLATE_VARIABLES[before.eventType as NotificationEventType] });
    }
    const after = await t.updateTable('notificationTemplates').set({ subject: body.subject, body: body.body, isActive: body.isActive, providerTemplateName: body.providerTemplateName }).where('id', '=', before.id).returningAll().executeTakeFirstOrThrow();
    await audit(t, auth, { action: 'template.updated', entityType: 'notification_template', entityId: before.id, summary: `Template "${before.name}" (${before.channel}) updated`, before, after });
    return after;
  }),
);

templates.post('/preview', { summary: 'Preview a template with sample data', permissions: ['notifications.manage'], body: z.object({ eventType: z.string(), body: z.string().max(4000), subject: z.string().max(200).nullish() }), status: 200 }, async ({ body }) => ({
  body: renderTemplate(body.body, SAMPLE),
  subject: body.subject ? renderTemplate(body.subject, SAMPLE) : null,
  unknownPlaceholders: checkPlaceholders(body.eventType as NotificationEventType, body.body, body.subject),
}));

// ───────────── Delivery log ─────────────
const logs = createRouter('/notifications', 'Notifications');

logs.get('/', { summary: 'Delivery log (sent, delivered, read, failed)', permissions: ['notifications.view'], query: notificationListQuery }, async ({ tx, auth, query }) =>
  tx(async (t) => {
    const orgId = requireOrgId(auth);
    const settings = await loadSettings(t, orgId);
    const visible = canSeeContact(auth, settings);
    let base = t
      .selectFrom('notifications as n')
      .leftJoin('customers as c', 'c.id', 'n.customerId')
      .innerJoin('organizations as o', 'o.id', 'n.organizationId')
      .where('n.organizationId', '=', orgId)
      .where((eb) => eb.or([eb('n.branchId', 'is', null), eb('n.branchId', 'in', auth.branchIds.length ? auth.branchIds : ['00000000-0000-0000-0000-000000000000'])]));
    if (query.status.length) base = base.where('n.status', 'in', query.status);
    if (query.channel) base = base.where('n.channel', '=', query.channel);
    if (query.eventType) base = base.where('n.eventType', '=', query.eventType);
    if (query.customerId) base = base.where('n.customerId', '=', query.customerId);
    for (const cond of localDateConditions('n.created_at', 'o.timezone', query.from, query.to)) base = base.where(cond);
    if (query.search) base = base.where(customerSearchCondition(query.search));
    const { n } = await base.select((eb) => eb.fn.countAll<number>().as('n')).executeTakeFirstOrThrow();
    const rows = await base
      .select(['n.id', 'n.createdAt', 'n.eventType', 'n.category', 'n.channel', 'n.recipient', 'n.customerId', 'c.fullName as customerName', 'n.status', 'n.statusReason', 'n.attempts', 'n.scheduledFor', 'n.sentAt', 'n.deliveredAt', 'n.readAt', 'n.lastError', 'n.body'])
      .orderBy('n.createdAt', 'desc')
      .limit(query.pageSize)
      .offset((query.page - 1) * query.pageSize)
      .execute();
    const items: NotificationLogItem[] = rows.map((r) => ({
      id: r.id,
      createdAt: r.createdAt.toISOString(),
      eventType: r.eventType,
      category: r.category as NotificationLogItem['category'],
      channel: r.channel as NotificationLogItem['channel'],
      recipient: visible ? r.recipient : '••••••',
      customerId: r.customerId,
      customerName: r.customerName,
      status: r.status as NotificationLogItem['status'],
      statusReason: r.statusReason,
      attempts: r.attempts,
      scheduledFor: r.scheduledFor.toISOString(),
      sentAt: r.sentAt?.toISOString() ?? null,
      deliveredAt: r.deliveredAt?.toISOString() ?? null,
      readAt: r.readAt?.toISOString() ?? null,
      lastError: r.lastError,
      body: r.body,
    }));
    return paged(items, n, query.page, query.pageSize);
  }),
);

logs.get('/summary', { summary: 'Delivery counts for the last 7 days and connected channels', permissions: ['notifications.view'] }, async ({ tx, auth }) =>
  tx(async (t) => {
    const orgId = requireOrgId(auth);
    const rows = await t
      .selectFrom('notifications')
      .select(['status', (eb) => eb.fn.countAll<number>().as('n')])
      .where('organizationId', '=', orgId)
      .where('createdAt', '>', sql<Date>`now() - interval '7 days'`)
      .groupBy('status')
      .execute();
    const channels = await availableChannels(t, orgId);
    return { last7Days: Object.fromEntries(rows.map((r) => [r.status, Number(r.n)])), connectedChannels: [...channels], mode: env.NOTIFICATIONS_MODE };
  }),
);

logs.post('/:id/retry', { summary: 'Try a failed message again', permissions: ['notifications.manage'], status: 200 }, async ({ tx, auth, params }) =>
  tx(async (t) => {
    const row = await t
      .updateTable('notifications')
      .set({ status: 'queued', attempts: 0, nextAttemptAt: new Date(), failedAt: null, statusReason: 'Retry requested', lastError: null })
      .where('organizationId', '=', requireOrgId(auth))
      .where('id', '=', params.id!)
      .where('status', '=', 'failed')
      .returning('id')
      .executeTakeFirst();
    if (!row) throw new AppError(409, 'CONFLICT', 'Only failed messages can be retried.');
    return { id: row.id, status: 'queued' };
  }),
);

logs.post('/:id/cancel', { summary: 'Stop a message that has not been sent yet', permissions: ['notifications.manage'], status: 200 }, async ({ tx, auth, params }) =>
  tx(async (t) => {
    const row = await t
      .updateTable('notifications')
      .set({ status: 'cancelled', statusReason: 'Cancelled by a team member' })
      .where('organizationId', '=', requireOrgId(auth))
      .where('id', '=', params.id!)
      .where('status', '=', 'queued')
      .returning('id')
      .executeTakeFirst();
    if (!row) throw new AppError(409, 'CONFLICT', 'Only messages waiting to be sent can be cancelled.');
    return { id: row.id, status: 'cancelled' };
  }),
);

// ───────────── Campaigns ─────────────
const campaigns = createRouter('/campaigns', 'Notifications');

campaigns.get('/', { summary: 'Campaigns with delivery results', permissions: ['campaigns.manage', 'notifications.view'] }, async ({ tx, auth }) =>
  tx(async (t) => {
    const orgId = requireOrgId(auth);
    const rows = await t.selectFrom('campaigns').selectAll().where('organizationId', '=', orgId).orderBy('createdAt', 'desc').limit(200).execute();
    const stats = rows.length
      ? await t.selectFrom('notifications').select(['campaignId', 'status', (eb) => eb.fn.countAll<number>().as('n')]).where('campaignId', 'in', rows.map((r) => r.id)).groupBy(['campaignId', 'status']).execute()
      : [];
    return rows.map((c) => ({ ...c, results: Object.fromEntries(stats.filter((s) => s.campaignId === c.id).map((s) => [s.status, Number(s.n)])) }));
  }),
);

campaigns.post('/', { summary: 'Create a campaign for a customer segment', permissions: ['campaigns.manage'], body: campaignSchema }, async ({ tx, auth, body }) =>
  tx(async (t) => {
    const orgId = requireOrgId(auth);
    const recipients = await countRecipients(t, orgId, body.segmentFilter, body.channel);
    const row = await t
      .insertInto('campaigns')
      .values({ organizationId: orgId, name: body.name, eventType: body.eventType, channel: body.channel, segmentFilter: JSON.stringify(body.segmentFilter), subject: body.subject, body: body.body, status: body.scheduledAt ? 'scheduled' : 'draft', scheduledAt: body.scheduledAt ? new Date(body.scheduledAt) : null, recipientsCount: recipients, createdBy: auth.userId })
      .returningAll()
      .executeTakeFirstOrThrow();
    await audit(t, auth, { action: 'campaign.created', entityType: 'campaign', entityId: row.id, summary: `Campaign "${body.name}" created for ${recipients} customers` });
    return row;
  }),
);

campaigns.post('/audience', { summary: 'How many customers would receive a message on a channel?', permissions: ['campaigns.manage'], body: z.object({ channel: z.enum(['whatsapp', 'email', 'sms']), segmentFilter: segmentFilterSchema }), status: 200 }, async ({ tx, auth, body }) =>
  tx(async (t) => ({ recipients: await countRecipients(t, requireOrgId(auth), body.segmentFilter, body.channel) })),
);

campaigns.post('/:id/send', { summary: 'Send a campaign now', permissions: ['campaigns.manage'], status: 200 }, async ({ tx, auth, params }) =>
  tx(async (t) => ({ queued: await launchCampaign(t, auth, params.id!) })),
);

campaigns.post('/:id/cancel', { summary: 'Cancel a campaign and its unsent messages', permissions: ['campaigns.manage'], status: 204 }, async ({ tx, auth, params }) =>
  tx(async (t) => {
    await cancelCampaign(t, auth, params.id!);
    return undefined;
  }),
);

// ───────────── Provider webhooks (public, signature-verified) ─────────────
const webhooks = createRouter('/webhooks', 'Webhooks');

webhooks.get('/whatsapp', { summary: 'WhatsApp webhook verification handshake', auth: 'public', status: 200 }, async ({ req, res }) => {
  const mode = req.query['hub.mode'];
  const token = String(req.query['hub.verify_token'] ?? '');
  if (mode === 'subscribe' && env.WHATSAPP_WEBHOOK_VERIFY_TOKEN && safeEqual(token, env.WHATSAPP_WEBHOOK_VERIFY_TOKEN)) {
    res.status(200).type('text/plain').send(String(req.query['hub.challenge'] ?? ''));
    return undefined;
  }
  throw new AppError(403, 'FORBIDDEN', 'Verification failed.');
});

webhooks.post('/whatsapp', { summary: 'WhatsApp delivery receipts (sent, delivered, read, failed)', auth: 'public', status: 200 }, async ({ req }) => {
  const secret = env.WHATSAPP_APP_SECRET;
  const raw = (req as unknown as { rawBody?: Buffer }).rawBody;
  const signature = req.get('x-hub-signature-256') ?? '';
  if (!secret || !raw || !safeEqual(signature, `sha256=${createHmac('sha256', secret).update(raw).digest('hex')}`)) {
    throw new AppError(401, 'UNAUTHENTICATED', 'Invalid signature.');
  }
  const payload = req.body as { entry?: Array<{ changes?: Array<{ value?: { statuses?: Array<{ id: string; status: string; timestamp?: string; errors?: Array<{ title?: string; message?: string }> }> } }> }> };
  let applied = 0;
  for (const entry of payload.entry ?? []) {
    for (const change of entry.changes ?? []) {
      for (const s of change.value?.statuses ?? []) {
        if (!['sent', 'delivered', 'read', 'failed'].includes(s.status)) continue;
        const ok = await applyDeliveryStatus({ provider: 'meta_cloud', providerMessageId: s.id, status: s.status as 'sent' | 'delivered' | 'read' | 'failed', at: s.timestamp ? new Date(Number(s.timestamp) * 1000) : new Date(), error: s.errors?.[0]?.title ?? s.errors?.[0]?.message });
        if (ok) applied += 1;
      }
    }
  }
  return { received: true, applied };
});

export const templateRoutes = templates;
export const notificationRoutes = logs;
export const campaignRoutes = campaigns;
export const webhookRoutes = webhooks;
