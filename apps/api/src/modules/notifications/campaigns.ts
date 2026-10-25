import type { NotificationChannel, SegmentFilter } from '@salon/shared';
import { sql } from 'kysely';
import { audit } from '../../core/audit.js';
import { requireOrgId, type AuthContext } from '../../core/auth-context.js';
import { AppError, notFound } from '../../core/errors.js';
import type { Tx } from '../../db/tenant.js';
import { segmentQuery } from '../customers/service.js';
import { availableChannels } from './outbox.js';

// Campaigns are queued with a single INSERT … SELECT so a segment of 100k customers costs one statement, not
// hundreds of thousands. Only customers with marketing consent and without an opt-out for the channel are reached.

const MAX_RECIPIENTS = 100_000;

export async function countRecipients(tx: Tx, orgId: string, filter: SegmentFilter, channel: NotificationChannel): Promise<number> {
  const recipientColumn = channel === 'email' ? sql`c.email` : channel === 'sms' ? sql`c.mobile` : sql`coalesce(c.whatsapp_number, c.mobile)`;
  const row = await segmentQuery(tx, orgId, { ...filter, marketingConsentOnly: true })
    .where(sql<boolean>`${recipientColumn} is not null`)
    .where(sql<boolean>`not exists (select 1 from customer_notification_preferences p where p.customer_id = c.id and p.channel = ${channel} and p.category = 'offers' and not p.enabled)`)
    .select((eb) => eb.fn.countAll<number>().as('n'))
    .executeTakeFirstOrThrow();
  return row.n;
}

export async function launchCampaign(tx: Tx, auth: AuthContext, campaignId: string): Promise<number> {
  const orgId = requireOrgId(auth);
  const campaign = await tx.selectFrom('campaigns').selectAll().where('organizationId', '=', orgId).where('id', '=', campaignId).forUpdate().executeTakeFirst();
  if (!campaign) throw notFound('Campaign');
  if (!['draft', 'scheduled'].includes(campaign.status)) throw new AppError(409, 'CONFLICT', 'This campaign has already been sent or cancelled.');
  const channel = campaign.channel as NotificationChannel;
  if (!(await availableChannels(tx, orgId)).has(channel)) {
    throw new AppError(409, 'CONFLICT', `${channel === 'whatsapp' ? 'WhatsApp' : channel === 'sms' ? 'SMS' : 'Email'} is not connected yet. Set it up under Settings → Messaging first.`);
  }
  const filter = campaign.segmentFilter as SegmentFilter;
  const recipient = channel === 'email' ? sql<string>`c.email` : channel === 'sms' ? sql<string>`c.mobile` : sql<string>`coalesce(c.whatsapp_number, c.mobile)`;
  const org = await tx.selectFrom('organizations').select('name').where('id', '=', orgId).executeTakeFirstOrThrow();
  const category = 'offers';

  const result = await tx
    .insertInto('notifications')
    .columns(['organizationId', 'customerId', 'campaignId', 'eventType', 'category', 'channel', 'recipient', 'subject', 'body', 'templateVariables', 'sourceType', 'sourceId', 'dedupeKey', 'createdBy'])
    .expression(
      segmentQuery(tx, orgId, { ...filter, marketingConsentOnly: true })
        .where(sql<boolean>`${recipient} is not null`)
        .where(sql<boolean>`not exists (select 1 from customer_notification_preferences p where p.customer_id = c.id and p.channel = ${channel} and p.category = ${category} and not p.enabled)`)
        .select([
          sql<string>`${orgId}::uuid`.as('organizationId'),
          'c.id as customerId',
          sql<string>`${campaignId}::uuid`.as('campaignId'),
          sql<string>`${campaign.eventType}::text`.as('eventType'),
          sql<string>`${category}::text`.as('category'),
          sql<string>`${channel}::text`.as('channel'),
          recipient.as('recipient'),
          sql<string | null>`${channel === 'email' ? campaign.subject : null}::text`.as('subject'),
          sql<string>`replace(replace(${campaign.body}::text, '{{customerName}}', split_part(c.full_name, ' ', 1)), '{{salonName}}', ${org.name}::text)`.as('body'),
          sql<string>`jsonb_build_object('customerName', split_part(c.full_name, ' ', 1), 'salonName', ${org.name}::text)`.as('templateVariables'),
          sql<string>`'campaign'`.as('sourceType'),
          sql<string>`${campaignId}::uuid`.as('sourceId'),
          sql<string>`'campaign:' || ${campaignId} || ':' || c.id || ':' || ${channel}`.as('dedupeKey'),
          sql<string | null>`${auth.userId || null}::uuid`.as('createdBy'),
        ])
        .limit(MAX_RECIPIENTS),
    )
    .onConflict((oc) => oc.columns(['organizationId', 'dedupeKey']).doNothing())
    .executeTakeFirst();
  const queued = Number(result.numInsertedOrUpdatedRows ?? 0);
  await tx.updateTable('campaigns').set({ status: queued > 0 ? 'sending' : 'completed', recipientsCount: queued }).where('id', '=', campaignId).execute();
  await audit(tx, auth, { action: 'campaign.sent', entityType: 'campaign', entityId: campaignId, summary: `Campaign "${campaign.name}" queued for ${queued} customers`, after: { channel, recipients: queued } });
  return queued;
}

export async function cancelCampaign(tx: Tx, auth: AuthContext, campaignId: string): Promise<void> {
  const orgId = requireOrgId(auth);
  const campaign = await tx.selectFrom('campaigns').select(['id', 'name', 'status']).where('organizationId', '=', orgId).where('id', '=', campaignId).forUpdate().executeTakeFirst();
  if (!campaign) throw notFound('Campaign');
  if (['completed', 'cancelled'].includes(campaign.status)) throw new AppError(409, 'CONFLICT', 'This campaign is already finished.');
  await tx.updateTable('notifications').set({ status: 'cancelled', statusReason: 'Campaign cancelled' }).where('campaignId', '=', campaignId).where('status', '=', 'queued').execute();
  await tx.updateTable('campaigns').set({ status: 'cancelled' }).where('id', '=', campaignId).execute();
  await audit(tx, auth, { action: 'campaign.cancelled', entityType: 'campaign', entityId: campaignId, summary: `Campaign "${campaign.name}" cancelled` });
}
