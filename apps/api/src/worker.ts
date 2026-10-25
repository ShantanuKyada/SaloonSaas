import { sql } from 'kysely';
import { env } from './config/env.js';
import { logger } from './core/logger.js';
import { metrics } from './core/metrics.js';
import { closeDb, pool } from './db/pool.js';
import { withSystem } from './db/tenant.js';
import { jobs, type JobDefinition } from './jobs/jobs.js';
import { dispatchDue } from './modules/notifications/dispatcher.js';

// Background worker: delivers queued notifications continuously and runs scheduled jobs. Any number of instances can
// run; delivery uses FOR UPDATE SKIP LOCKED and each job is guarded by an advisory lock.

process.env.SERVICE_NAME ??= 'salonos-worker';
pool.on('error', (error) => logger.error({ err: error }, 'idle database client error'));

let running = true;
const lastRun = new Map<string, number>();

/** Runs a job only if no other worker is already running it (transaction-scoped advisory lock). */
async function runExclusive(job: JobDefinition): Promise<void> {
  await withSystem(async (lockTx) => {
    const locked = await sql<{ ok: boolean }>`select pg_try_advisory_xact_lock(hashtextextended(${`job:${job.name}`}, 0)) as ok`.execute(lockTx);
    if (!locked.rows[0]?.ok) return;
    const started = Date.now();
    await lockTx
      .insertInto('jobState')
      .values({ name: job.name, lastStartedAt: new Date(started), runCount: 1 })
      .onConflict((oc) => oc.column('name').doUpdateSet((eb) => ({ lastStartedAt: new Date(started), runCount: eb('jobState.runCount', '+', 1) })))
      .execute();
    let status = 'ok';
    let error: string | null = null;
    try {
      const result = await job.run();
      logger.info({ job: job.name, ms: Date.now() - started, ...(result ?? {}) }, 'job finished');
      metrics.jobRuns.inc({ job: job.name, outcome: 'ok' });
    } catch (err) {
      status = 'failed';
      error = err instanceof Error ? err.message : String(err);
      logger.error({ job: job.name, err }, 'job failed');
      metrics.jobRuns.inc({ job: job.name, outcome: 'failed' });
    }
    await lockTx.updateTable('jobState').set({ lastFinishedAt: new Date(), lastStatus: status, lastError: error?.slice(0, 500) ?? null }).where('name', '=', job.name).execute();
  });
}

async function schedulerLoop(): Promise<void> {
  while (running) {
    for (const job of jobs) {
      if (!running) break;
      const due = (lastRun.get(job.name) ?? 0) + job.everyMs <= Date.now();
      if (!due) continue;
      lastRun.set(job.name, Date.now());
      await runExclusive(job).catch((error) => logger.error({ job: job.name, err: error }, 'scheduler error'));
    }
    await new Promise((r) => setTimeout(r, 5_000));
  }
}

async function dispatcherLoop(): Promise<void> {
  while (running) {
    try {
      const stats = await dispatchDue();
      if (stats.claimed > 0) logger.info(stats, 'notifications dispatched');
      if (stats.claimed >= env.WORKER_BATCH_SIZE) continue; // more waiting: go again straight away
    } catch (error) {
      logger.error({ err: error }, 'dispatcher loop error');
    }
    await new Promise((r) => setTimeout(r, env.WORKER_POLL_INTERVAL_MS));
  }
}

logger.info({ jobs: jobs.map((j) => j.name) }, 'worker started');
const loops = Promise.all([dispatcherLoop(), schedulerLoop()]);

async function shutdown(signal: string): Promise<void> {
  if (!running) return;
  running = false;
  logger.info({ signal }, 'worker shutting down');
  const force = setTimeout(() => process.exit(1), 20_000);
  force.unref();
  await loops.catch(() => undefined);
  await closeDb().catch(() => undefined);
  process.exit(0);
}
process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('unhandledRejection', (reason) => logger.error({ err: reason }, 'unhandled rejection'));
