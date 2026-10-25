import { MARKETING_CATEGORIES, TEMPLATE_VARIABLES, type NotificationChannel, type NotificationEventType } from '@salon/shared';
import { sql } from 'kysely';
import { env } from '../../config/env.js';
import { decryptSecret } from '../../core/crypto.js';
import { logger } from '../../core/logger.js';
import { metrics } from '../../core/metrics.js';
import { withSystem } from '../../db/tenant.js';
import {
  ConsoleProvider,
  organizationProvider,
  platformProvider,
  ProviderError,
  type NotificationProvider,
  type OutboundMessage,
  type ProviderConfig,
} from '../../integrations/notifications/providers.js';

// Delivery worker. Business code only INSERTs queued rows (see outbox.ts); this module claims them with
// FOR UPDATE SKIP LOCKED, so any number of workers can run side by side without sending anything twice.

const BACKOFF_SECONDS = [30, 120, 480, 1920, 3600];
const LOCK_MINUTES = 2;

interface CachedProvider {
  provider: NotificationProvider | null;
  expires: number;
}
const providerCache = new Map<string, CachedProvider>();

export function clearProviderCache(): void {
  providerCache.clear();
}

export async function resolveProvider(orgId: string, channel: NotificationChannel): Promise<NotificationProvider> {
  if (env.NOTIFICATIONS_MODE === 'console') return new ConsoleProvider(channel);
  if (env.NOTIFICATIONS_MODE === 'disabled') throw new ProviderError('Messaging is switched off for this environment.', false);
  const key = `${orgId}:${channel}`;
  const hit = providerCache.get(key);
  if (hit && hit.expires > Date.now()) {
    if (!hit.provider) throw new ProviderError(`${channel} messaging is not set up for this salon.`, false);
    return hit.provider;
  }
  const integration = await withSystem((tx) =>
    tx
      .selectFrom('organizationIntegrations')
      .select(['provider', 'config', 'secretsEncrypted'])
      .where('organizationId', '=', orgId)
      .where('kind', '=', channel)
      .where('status', '=', 'active')
      .executeTakeFirst(),
  );
  let provider: NotificationProvider | null = null;
  if (integration) {
    const secrets = integration.secretsEncrypted ? (JSON.parse(decryptSecret(integration.secretsEncrypted)) as Record<string, string>) : {};
    provider = organizationProvider(channel, integration.provider, (integration.config ?? {}) as ProviderConfig, secrets);
  }
  provider ??= platformProvider(channel);
  providerCache.set(key, { provider, expires: Date.now() + 60_000 });
  if (!provider) throw new ProviderError(`${channel} messaging is not set up for this salon.`, false);
  return provider;
}

/** Placeholder values in the order they appear in the template text (WhatsApp templates are positional). */
function orderedVariables(body: string, event: string, variables: Record<string, unknown>): string[] {
  const known = new Set(TEMPLATE_VARIABLES[event as NotificationEventType] ?? []);
  const names = [...body.matchAll(/\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g)].map((m) => m[1]!).filter((n) => known.has(n) || n in variables);
  return names.map((n) => String(variables[n] ?? ''));
}

export interface DispatchStats {
  claimed: number;
  sent: number;
  retried: number;
  failed: number;
  skipped: number;
}

/** Returns rows stuck in "processing" (worker crashed mid-send) to the queue. */
export async function reapStuck(): Promise<number> {
  const result = await withSystem((tx) =>
    tx
      .updateTable('notifications')
      .set({ status: 'queued', nextAttemptAt: new Date(), statusReason: 'Retrying after an interrupted attempt' })
      .where('status', '=', 'processing')
      .where('lockedUntil', '<', new Date())
      .executeTakeFirst(),
  );
  return Number(result.numUpdatedRows);
}

export async function dispatchDue(limit = env.WORKER_BATCH_SIZE): Promise<DispatchStats> {
  const claimed = await withSystem(async (tx) => {
    const rows = await sql<{ id: string }>`
      update notifications set status = 'processing', locked_until = now() + make_interval(mins => ${LOCK_MINUTES}), attempts = attempts + 1, updated_at = now()
       where id in (select id from notifications
                     where status = 'queued' and next_attempt_at <= now() and scheduled_for <= now()
                     order by next_attempt_at, id limit ${limit} for update skip locked)
      returning id`.execute(tx);
    return rows.rows.map((r) => r.id);
  });
  const stats: DispatchStats = { claimed: claimed.length, sent: 0, retried: 0, failed: 0, skipped: 0 };
  let cursor = 0;
  const worker = async () => {
    while (cursor < claimed.length) {
      const id = claimed[cursor++]!;
      try {
        const outcome = await deliver(id);
        stats[outcome] += 1;
      } catch (error) {
        logger.error({ err: error, notificationId: id }, 'unexpected dispatcher error');
        await markOutcome(id, { kind: 'retry', reason: 'Internal error while sending', retryable: true }).catch(() => undefined);
        stats.retried += 1;
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(env.WORKER_CONCURRENCY, claimed.length) }, worker));
  return stats;
}

type Outcome = { kind: 'sent'; providerMessageId: string | null; provider: string } | { kind: 'skip'; reason: string } | { kind: 'retry'; reason: string; retryable: boolean };

async function deliver(id: string): Promise<'sent' | 'retried' | 'failed' | 'skipped'> {
  const n = await withSystem((tx) =>
    tx
      .selectFrom('notifications as n')
      .leftJoin('notificationTemplates as t', 't.id', 'n.templateId')
      .select(['n.id', 'n.organizationId', 'n.customerId', 'n.channel', 'n.category', 'n.eventType', 'n.recipient', 'n.subject', 'n.body', 'n.templateVariables', 'n.sourceType', 'n.sourceId', 'n.attempts', 'n.maxAttempts', 't.providerTemplateName'])
      .where('n.id', '=', id)
      .executeTakeFirst(),
  );
  if (!n) return 'skipped';

  const skip = await shouldSkip(n);
  if (skip) {
    await markOutcome(id, { kind: 'skip', reason: skip });
    return 'skipped';
  }

  const channel = n.channel as NotificationChannel;
  let outcome: Outcome;
  try {
    const provider = await resolveProvider(n.organizationId, channel);
    const variables = (n.templateVariables ?? {}) as Record<string, unknown>;
    const message: OutboundMessage = {
      notificationId: n.id,
      organizationId: n.organizationId,
      channel,
      to: n.recipient,
      subject: n.subject,
      body: n.body,
      providerTemplateName: n.providerTemplateName,
      orderedVariables: orderedVariables(n.body, n.eventType, variables),
    };
    const result = await provider.send(message);
    outcome = { kind: 'sent', providerMessageId: result.providerMessageId, provider: provider.name };
    metrics.notificationsSent.inc({ channel });
  } catch (error) {
    metrics.notificationsFailed.inc({ channel });
    const retryable = error instanceof ProviderError ? error.retryable : true;
    const reason = error instanceof Error ? error.message : String(error);
    logger.warn({ notificationId: id, channel, attempts: n.attempts, retryable, reason }, 'notification attempt failed');
    outcome = { kind: 'retry', reason, retryable };
  }
  return markOutcome(id, outcome, n.attempts, n.maxAttempts);
}

/** Last-moment checks: consent can be withdrawn and bookings can change between queueing and sending. */
async function shouldSkip(n: { organizationId: string; customerId: string | null; channel: string; category: string; eventType: string; sourceType: string | null; sourceId: string | null }): Promise<string | null> {
  if (!n.customerId) return null;
  return withSystem(async (tx) => {
    const customer = await tx.selectFrom('customers').select(['status', 'marketingConsent']).where('id', '=', n.customerId!).executeTakeFirst();
    if (!customer || customer.status === 'archived') return 'Customer no longer active';
    if (MARKETING_CATEGORIES.includes(n.category as never) && !customer.marketingConsent) return 'Customer withdrew marketing consent';
    const pref = await tx
      .selectFrom('customerNotificationPreferences')
      .select('enabled')
      .where('customerId', '=', n.customerId!)
      .where('channel', '=', n.channel as NotificationChannel)
      .where('category', '=', n.category as 'appointment')
      .executeTakeFirst();
    if (pref && !pref.enabled) return 'Customer opted out of this type of message';
    if (n.eventType === 'appointment_reminder' && n.sourceType === 'appointment' && n.sourceId) {
      const a = await tx.selectFrom('appointments').select(['status', 'startAt']).where('id', '=', n.sourceId).executeTakeFirst();
      if (!a || !['scheduled', 'confirmed'].includes(a.status) || !a.startAt || a.startAt.getTime() < Date.now()) return 'Appointment is no longer upcoming';
    }
    if (n.eventType === 'outstanding_reminder') {
      const acct = await tx.selectFrom('customerAccounts').select('balance').where('customerId', '=', n.customerId!).executeTakeFirst();
      if (!acct || acct.balance <= 0) return 'Nothing pending any more';
    }
    return null;
  });
}

async function markOutcome(id: string, outcome: Outcome, attempts = 1, maxAttempts = 5): Promise<'sent' | 'retried' | 'failed' | 'skipped'> {
  return withSystem(async (tx) => {
    if (outcome.kind === 'sent') {
      await tx
        .updateTable('notifications')
        .set({ status: 'sent', sentAt: new Date(), provider: outcome.provider, providerMessageId: outcome.providerMessageId, lastError: null, statusReason: null, lockedUntil: null })
        .where('id', '=', id)
        .execute();
      return 'sent';
    }
    if (outcome.kind === 'skip') {
      await tx.updateTable('notifications').set({ status: 'skipped', statusReason: outcome.reason, lockedUntil: null }).where('id', '=', id).execute();
      return 'skipped';
    }
    if (outcome.retryable && attempts < maxAttempts) {
      const delay = BACKOFF_SECONDS[Math.min(attempts - 1, BACKOFF_SECONDS.length - 1)]!;
      await tx
        .updateTable('notifications')
        .set({ status: 'queued', lastError: outcome.reason.slice(0, 500), statusReason: `Will retry (attempt ${attempts} of ${maxAttempts})`, nextAttemptAt: new Date(Date.now() + delay * 1000), lockedUntil: null })
        .where('id', '=', id)
        .execute();
      return 'retried';
    }
    await tx
      .updateTable('notifications')
      .set({ status: 'failed', failedAt: new Date(), lastError: outcome.reason.slice(0, 500), statusReason: outcome.retryable ? 'Gave up after repeated attempts' : 'Could not be delivered', lockedUntil: null })
      .where('id', '=', id)
      .execute();
    return 'failed';
  });
}

const STATUS_RANK: Record<string, number> = { queued: 0, processing: 1, sent: 2, delivered: 3, read: 4 };

/** Applies a delivery receipt from a provider webhook (sent → delivered → read, or failed). */
export async function applyDeliveryStatus(args: { provider: string; providerMessageId: string; status: 'sent' | 'delivered' | 'read' | 'failed'; at: Date; error?: string }): Promise<boolean> {
  return withSystem(async (tx) => {
    const row = await tx
      .selectFrom('notifications')
      .select(['id', 'status'])
      .where('provider', '=', args.provider)
      .where('providerMessageId', '=', args.providerMessageId)
      .forUpdate()
      .executeTakeFirst();
    if (!row) return false;
    if (args.status === 'failed') {
      if (row.status === 'read') return true;
      await tx.updateTable('notifications').set({ status: 'failed', failedAt: args.at, lastError: args.error?.slice(0, 500) ?? 'Delivery failed', statusReason: 'Provider reported a delivery failure' }).where('id', '=', row.id).execute();
      return true;
    }
    if ((STATUS_RANK[args.status] ?? 0) <= (STATUS_RANK[row.status] ?? 0)) return true;
    await tx
      .updateTable('notifications')
      .set({ status: args.status, ...(args.status === 'delivered' ? { deliveredAt: args.at } : {}), ...(args.status === 'read' ? { readAt: args.at, deliveredAt: args.at } : {}) })
      .where('id', '=', row.id)
      .execute();
    return true;
  });
}
