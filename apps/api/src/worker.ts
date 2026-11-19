import { logger } from './core/logger.js';
import { closeDb, pool } from './db/pool.js';
import { startWorker } from './jobs/runner.js';

// Background worker as its own process: delivers queued notifications and runs scheduled jobs (see jobs/runner.ts).
// Single-service hosts can run the same work inside the API process instead (RUN_WORKER=true).

process.env.SERVICE_NAME ??= 'salonos-worker';
pool.on('error', (error) => logger.error({ err: error }, 'idle database client error'));

const worker = startWorker();

let stopping = false;
async function shutdown(signal: string): Promise<void> {
  if (stopping) return;
  stopping = true;
  logger.info({ signal }, 'worker shutting down');
  const force = setTimeout(() => process.exit(1), 20_000);
  force.unref();
  await worker.stop();
  await closeDb().catch(() => undefined);
  process.exit(0);
}
process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('unhandledRejection', (reason) => logger.error({ err: reason }, 'unhandled rejection'));
