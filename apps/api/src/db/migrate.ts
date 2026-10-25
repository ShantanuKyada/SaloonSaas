import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import pg from 'pg';
import { PERMISSIONS } from '@salon/shared';

// Plain-SQL migration runner. Each file runs once, in order, inside its own transaction. Applied files are
// checksummed: editing an applied migration is an error (write a new migration instead).

const MIGRATIONS_DIR = fileURLToPath(new URL('./migrations/', import.meta.url));
const LOCK_KEY = 815_204_771; // arbitrary constant for pg_advisory_lock

export interface MigrateOptions {
  connectionString: string;
  appRole: string;
  log?: (message: string) => void;
}

function quoteIdent(name: string): string {
  if (!/^[a-z_][a-z0-9_]*$/.test(name)) throw new Error(`Unsafe identifier: ${name}`);
  return `"${name}"`;
}

export async function runMigrations({ connectionString, appRole, log = console.log }: MigrateOptions): Promise<string[]> {
  const client = new pg.Client({ connectionString, application_name: 'salonos-migrate' });
  await client.connect();
  const applied: string[] = [];
  try {
    await client.query('select pg_advisory_lock($1)', [LOCK_KEY]);
    await client.query(`
      create table if not exists schema_migrations (
        version    text primary key,
        checksum   text not null,
        applied_at timestamptz not null default now()
      )`);
    const { rows } = await client.query<{ version: string; checksum: string }>('select version, checksum from schema_migrations');
    const done = new Map(rows.map((r) => [r.version, r.checksum]));

    const files = readdirSync(MIGRATIONS_DIR)
      .filter((f) => /^\d{4}_.+\.sql$/.test(f))
      .sort();

    for (const file of files) {
      const sqlText = readFileSync(`${MIGRATIONS_DIR}${file}`, 'utf8');
      const checksum = createHash('sha256').update(sqlText).digest('hex');
      const previous = done.get(file);
      if (previous) {
        if (previous !== checksum) {
          throw new Error(`Migration ${file} was modified after being applied. Create a new migration instead.`);
        }
        continue;
      }
      log(`Applying ${file}`);
      await client.query('begin');
      try {
        await client.query(sqlText);
        await client.query('insert into schema_migrations (version, checksum) values ($1, $2)', [file, checksum]);
        await client.query('commit');
        applied.push(file);
      } catch (error) {
        await client.query('rollback');
        throw new Error(`Migration ${file} failed: ${(error as Error).message}`);
      }
    }

    await syncPermissions(client);
    await applyGrants(client, appRole);
    return applied;
  } finally {
    await client.query('select pg_advisory_unlock($1)', [LOCK_KEY]).catch(() => undefined);
    await client.end();
  }
}

async function syncPermissions(client: pg.Client): Promise<void> {
  const entries = Object.entries(PERMISSIONS);
  await client.query('begin');
  try {
    for (const [key, def] of entries) {
      await client.query(
        `insert into permissions (key, module, label) values ($1, $2, $3)
         on conflict (key) do update set module = excluded.module, label = excluded.label`,
        [key, def.module, def.label],
      );
    }
    await client.query('delete from permissions where not (key = any($1::text[]))', [entries.map(([k]) => k)]);
    await client.query('commit');
  } catch (error) {
    await client.query('rollback');
    throw error;
  }
}

/** Least-privilege grants for the runtime role (RLS applies to it; it does not own any table). */
async function applyGrants(client: pg.Client, appRole: string): Promise<void> {
  const role = quoteIdent(appRole);
  const exists = await client.query('select 1 from pg_roles where rolname = $1', [appRole]);
  if (exists.rowCount === 0) {
    console.warn(`Role ${appRole} does not exist; skipping grants (run npm run db:setup).`);
    return;
  }
  await client.query(`
    grant usage on schema public to ${role};
    grant select, insert, update, delete on all tables in schema public to ${role};
    grant usage, select on all sequences in schema public to ${role};
    grant execute on all functions in schema public to ${role};
    revoke insert, update, delete on permissions, schema_migrations from ${role};
    revoke update, delete on ledger_entries, audit_logs, appointment_events, invoice_items, refunds, ledger_adjustments from ${role};
    revoke delete on invoices, payments, payment_allocations from ${role};
    revoke insert, update, delete on customer_accounts from ${role};
    alter function ledger_entries_apply_balance() security definer;
    alter function ledger_entries_apply_balance() set search_path = public;
  `);
}

// CLI: npm run db:migrate
if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const { env } = await import('../config/env.js');
  const url = env.DATABASE_MIGRATION_URL ?? env.DATABASE_URL;
  runMigrations({ connectionString: url, appRole: env.DB_APP_ROLE })
    .then((applied) => {
      console.log(applied.length ? `Applied ${applied.length} migration(s).` : 'Database is up to date.');
    })
    .catch((error: Error) => {
      console.error(error.message);
      process.exit(1);
    });
}
