import { sql } from 'kysely';
import { systemContext } from '../core/auth-context.js';
import { logger } from '../core/logger.js';
import { todayIn } from '../core/time.js';
import { withSystem } from '../db/tenant.js';
import { recomputeBranch, remapUnmappedPunches, syncIntegration } from '../modules/attendance/service.js';
import { sendOutstandingReminder } from '../modules/collections/service.js';
import { refreshCustomerStats } from '../modules/customers/service.js';
import { launchCampaign } from '../modules/notifications/campaigns.js';
import { reapStuck } from '../modules/notifications/dispatcher.js';
import { enqueueNotification } from '../modules/notifications/outbox.js';
import type { BranchRow } from '../core/validation.js';

// Background jobs. Each is idempotent and safe to run on several worker instances: the scheduler elects one runner
// per job with an advisory lock, and every job de-duplicates its own output.

export interface JobDefinition {
  name: string;
  everyMs: number;
  run: () => Promise<Record<string, unknown> | void>;
}

const MIN = 60_000;
const HOUR = 60 * MIN;

async function activeOrgIds(): Promise<string[]> {
  const rows = await withSystem((tx) => tx.selectFrom('organizations').select('id').where('status', '=', 'active').execute());
  return rows.map((r) => r.id);
}

export const jobs: JobDefinition[] = [
  {
    name: 'notifications.reap_stuck',
    everyMs: MIN,
    run: async () => ({ requeued: await reapStuck() }),
  },
  {
    name: 'campaigns.launch_scheduled',
    everyMs: MIN,
    run: async () => {
      const due = await withSystem((tx) => tx.selectFrom('campaigns').select(['id', 'organizationId']).where('status', '=', 'scheduled').where('scheduledAt', '<=', new Date()).execute());
      let launched = 0;
      for (const c of due) {
        try {
          await withSystem((tx) => launchCampaign(tx, systemContext(c.organizationId), c.id));
          launched += 1;
        } catch (error) {
          // A campaign whose channel was disconnected must not block the others; it is cancelled with a visible reason.
          logger.warn({ campaignId: c.id, err: error }, 'scheduled campaign could not be launched');
          await withSystem((tx) => tx.updateTable('campaigns').set({ status: 'cancelled' }).where('id', '=', c.id).execute());
        }
      }
      return { launched };
    },
  },
  {
    name: 'campaigns.complete_finished',
    everyMs: MIN,
    run: async () => {
      const res = await withSystem((tx) =>
        sql`update campaigns c set status = 'completed', updated_at = now()
             where c.status = 'sending' and not exists (select 1 from notifications n where n.campaign_id = c.id and n.status in ('queued','processing'))`.execute(tx),
      );
      return { completed: Number(res.numAffectedRows ?? 0) };
    },
  },
  {
    name: 'outstanding.auto_reminders',
    everyMs: 3 * HOUR,
    run: async () => {
      let queued = 0;
      for (const orgId of await activeOrgIds()) {
        const candidates = await withSystem((tx) =>
          tx
            .selectFrom('customerAccounts as ca')
            .innerJoin('organizationSettings as s', 's.organizationId', 'ca.organizationId')
            .select('ca.customerId')
            .where('ca.organizationId', '=', orgId)
            .where('s.outstandingReminderEnabled', '=', true)
            .whereRef('ca.balance', '>=', 's.outstandingReminderMinAmount')
            .limit(2000)
            .execute(),
        );
        for (const c of candidates) {
          try {
            queued += (await withSystem((tx) => sendOutstandingReminder(tx, systemContext(orgId), c.customerId, 'auto'))).queued;
          } catch (error) {
            logger.warn({ customerId: c.customerId, err: error }, 'auto reminder skipped');
          }
        }
      }
      return { queued };
    },
  },
  {
    name: 'customers.birthday_messages',
    everyMs: HOUR,
    run: async () => {
      let queued = 0;
      for (const orgId of await activeOrgIds()) {
        const org = await withSystem((tx) => tx.selectFrom('organizations').select(['name', 'timezone']).where('id', '=', orgId).executeTakeFirstOrThrow());
        const today = todayIn(org.timezone);
        const localHour = Number(new Intl.DateTimeFormat('en-GB', { hour: '2-digit', hour12: false, timeZone: org.timezone }).format(new Date()));
        if (localHour < 9) continue;
        const [, month, day] = today.split('-').map(Number) as [number, number, number];
        const customers = await withSystem((tx) =>
          tx
            .selectFrom('customers')
            .select(['id', 'preferredBranchId'])
            .where('organizationId', '=', orgId)
            .where('status', '=', 'active')
            .where('marketingConsent', '=', true)
            .where(sql<boolean>`extract(month from date_of_birth) = ${month} and extract(day from date_of_birth) = ${day}`)
            .limit(5000)
            .execute(),
        );
        for (const c of customers) {
          queued += await withSystem((tx) =>
            enqueueNotification(tx, {
              orgId,
              branchId: c.preferredBranchId,
              customerId: c.id,
              eventType: 'birthday',
              sourceType: 'birthday',
              sourceId: c.id,
              dedupeKey: `birthday:${c.id}:${today.slice(0, 4)}`,
              variables: { salonName: org.name, message: 'Wishing you a wonderful year ahead! Visit us this week to celebrate.' },
            }),
          );
        }
      }
      return { queued };
    },
  },
  {
    name: 'attendance.sync_and_compute',
    everyMs: 5 * MIN,
    run: async () => {
      const integrations = await withSystem((tx) => tx.selectFrom('organizationIntegrations').select(['id', 'organizationId']).where('kind', '=', 'biometric').where('status', '!=', 'inactive').execute());
      let failed = 0;
      for (const i of integrations) {
        const outcome = await syncIntegration(i.id); // contained: never throws
        if (!outcome.ok) failed += 1;
      }
      let rows = 0;
      for (const orgId of await activeOrgIds()) {
        await withSystem(async (tx) => {
          await remapUnmappedPunches(tx, orgId);
          const branches = (await tx.selectFrom('branches').selectAll().where('organizationId', '=', orgId).where('status', '=', 'active').execute()) as BranchRow[];
          for (const b of branches) {
            const today = todayIn(b.timezone);
            const yesterday = new Date(Date.parse(`${today}T00:00:00Z`) - 86_400_000).toISOString().slice(0, 10);
            rows += await recomputeBranch(tx, orgId, b, yesterday, today);
          }
        });
      }
      return { integrations: integrations.length, failed, rows };
    },
  },
  {
    name: 'customers.refresh_recent_stats',
    everyMs: 6 * HOUR,
    run: async () => {
      let refreshed = 0;
      for (const orgId of await activeOrgIds()) {
        const ids = await withSystem(async (tx) => {
          const rows = await sql<{ id: string }>`
            select distinct customer_id as id from (
              select customer_id from invoices where organization_id = ${orgId} and updated_at > now() - interval '3 days'
              union select customer_id from appointments where organization_id = ${orgId} and updated_at > now() - interval '3 days'
            ) x`.execute(tx);
          return rows.rows.map((r) => r.id);
        });
        for (const id of ids) {
          await withSystem((tx) => refreshCustomerStats(tx, orgId, id));
          refreshed += 1;
        }
      }
      return { refreshed };
    },
  },
  {
    name: 'packages.expire',
    everyMs: HOUR,
    run: async () => {
      const res = await withSystem((tx) => tx.updateTable('customerPackages').set({ status: 'expired' }).where('status', '=', 'active').where('expiresAt', '<', new Date()).executeTakeFirst());
      return { expired: Number(res.numUpdatedRows) };
    },
  },
  {
    name: 'idempotency.cleanup',
    everyMs: 6 * HOUR,
    run: async () => {
      const res = await withSystem((tx) => tx.deleteFrom('idempotencyKeys').where('createdAt', '<', new Date(Date.now() - 48 * HOUR)).executeTakeFirst());
      return { deleted: Number(res.numDeletedRows) };
    },
  },
];
