import pg from 'pg';
import { env } from '../config/env.js';

// Local/dev bootstrap: creates the owner (migration) role, the runtime role subject to RLS, and the databases.
// Production databases are provisioned by infrastructure code; see docs/DEPLOYMENT.md.

interface Target {
  database: string;
  ownerRole: string;
  ownerPassword: string;
  appRole: string;
  appPassword: string;
}

function parse(url: string) {
  const u = new URL(url);
  return { user: decodeURIComponent(u.username), password: decodeURIComponent(u.password), database: u.pathname.slice(1) };
}

function ident(name: string): string {
  if (!/^[a-z_][a-z0-9_]*$/.test(name)) throw new Error(`Unsafe identifier: ${name}`);
  return `"${name}"`;
}

function literal(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

async function ensureRole(client: pg.Client, role: string, password: string): Promise<void> {
  const { rowCount } = await client.query('select 1 from pg_roles where rolname = $1', [role]);
  if (rowCount === 0) {
    await client.query(`create role ${ident(role)} login password ${literal(password)} nosuperuser nocreatedb nocreaterole`);
    console.log(`Created role ${role}`);
  }
}

async function ensureDatabase(client: pg.Client, target: Target): Promise<void> {
  const { rowCount } = await client.query('select 1 from pg_database where datname = $1', [target.database]);
  if (rowCount === 0) {
    await client.query(`create database ${ident(target.database)} owner ${ident(target.ownerRole)} encoding 'UTF8' template template0`);
    console.log(`Created database ${target.database}`);
  }
  await client.query(`grant connect on database ${ident(target.database)} to ${ident(target.appRole)}`);
}

async function main(): Promise<void> {
  if (!env.DATABASE_SUPERUSER_URL) {
    throw new Error('DATABASE_SUPERUSER_URL is required for db:setup');
  }
  const app = parse(env.DATABASE_URL);
  const owner = parse(env.DATABASE_MIGRATION_URL ?? env.DATABASE_URL);
  const targets: Target[] = [
    { database: app.database, ownerRole: owner.user, ownerPassword: owner.password, appRole: app.user, appPassword: app.password },
  ];
  if (process.env.TEST_DATABASE_URL) {
    const testApp = parse(process.env.TEST_DATABASE_URL);
    targets.push({ ...targets[0]!, database: testApp.database });
  }

  const client = new pg.Client({ connectionString: env.DATABASE_SUPERUSER_URL });
  await client.connect();
  try {
    for (const target of targets) {
      await ensureRole(client, target.ownerRole, target.ownerPassword);
      await ensureRole(client, target.appRole, target.appPassword);
      await ensureDatabase(client, target);
    }
  } finally {
    await client.end();
  }
  console.log('Database setup complete. Next: npm run db:migrate && npm run db:seed');
}

main().catch((error: Error) => {
  console.error(error.message);
  process.exit(1);
});
