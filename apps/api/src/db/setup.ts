import pg from 'pg';
import { env } from '../config/env.js';
import { parseConnectionUrl } from './connection-info.js';

// Bootstrap: creates the owner (migration) role and the runtime role that row-level security applies to, and gives
// the owner a database to migrate into. Run it with an administrator connection (DATABASE_SUPERUSER_URL):
//
// - Local/dev: a real superuser. Missing databases are created, owned by the owner role.
// - Managed PostgreSQL such as Supabase: the platform's admin role (Supabase's `postgres` can create roles but is
//   not a superuser) and the platform's existing database. That database stays owned by the platform; the owner role
//   is granted what migrations need (connect, create, and create on schema public).
//
// Safe to run repeatedly. A role that cannot sign in with the password in its URL gets that password, so rotating a
// password is: change the secret, run this again. Passwords that still work are left alone: setting one again, even to
// the same value, gives it a new SCRAM salt, and poolers that cache credentials (Supabase's) then refuse correct
// sign-ins for a while.

// Extensions the migrations need (see 0001_foundation.sql). On a managed database the admin role installs them, into
// schema public like the migrations would, because platforms may restrict who can create extensions.
const REQUIRED_EXTENSIONS = ['citext', 'btree_gist', 'pg_trgm'];

interface Target {
  database: string;
  ownerRole: string;
  appRole: string;
}

function ident(name: string): string {
  if (!/^[a-z_][a-z0-9_]*$/.test(name)) throw new Error(`Unsafe identifier: ${name}`);
  return `"${name}"`;
}

function literal(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

/** Whether `url` signs in, i.e. its role already has that password (and may connect). */
async function canSignIn(url: string): Promise<boolean> {
  const probe = new pg.Client({ connectionString: url, connectionTimeoutMillis: 15_000 });
  try {
    await probe.connect();
    return true;
  } catch {
    return false;
  } finally {
    await probe.end().catch(() => undefined);
  }
}

async function ensureRole(client: pg.Client, role: string, password: string, url: string): Promise<void> {
  const { rowCount } = await client.query('select 1 from pg_roles where rolname = $1', [role]);
  if (rowCount === 0) {
    await client.query(`create role ${ident(role)} login password ${literal(password)} nosuperuser nocreatedb nocreaterole`);
    console.log(`Created role ${role}`);
  } else if (!(await canSignIn(url))) {
    await client.query(`alter role ${ident(role)} login password ${literal(password)}`);
    console.log(`Set the password of ${role} from its URL`);
  }
}

/** The admin URL pointed at another database on the same server. */
function adminUrlFor(database: string): string {
  const url = new URL(env.DATABASE_SUPERUSER_URL!);
  url.pathname = `/${encodeURIComponent(database)}`;
  return url.toString();
}

async function ensureDatabase(client: pg.Client, target: Target): Promise<void> {
  const { rows } = await client.query<{ owner: string }>(
    'select pg_get_userbyid(datdba) as owner from pg_database where datname = $1',
    [target.database],
  );
  if (rows.length === 0) {
    await client.query(`create database ${ident(target.database)} owner ${ident(target.ownerRole)} encoding 'UTF8' template template0`);
    console.log(`Created database ${target.database}`);
  } else if (rows[0]!.owner !== target.ownerRole) {
    // An existing database we do not own (a managed platform's). Let the owner role create the schema in it.
    await client.query(`grant connect, create, temporary on database ${ident(target.database)} to ${ident(target.ownerRole)}`);
    const db = new pg.Client({ connectionString: adminUrlFor(target.database) });
    await db.connect();
    try {
      await db.query(`grant usage, create on schema public to ${ident(target.ownerRole)}`);
      for (const extension of REQUIRED_EXTENSIONS) await db.query(`create extension if not exists ${ident(extension)} with schema public`);
    } finally {
      await db.end();
    }
    console.log(`Using existing database ${target.database} (owned by ${rows[0]!.owner}); ${target.ownerRole} may create the schema in it`);
  }
  await client.query(`grant connect on database ${ident(target.database)} to ${ident(target.appRole)}`);
}

async function main(): Promise<void> {
  if (!env.DATABASE_SUPERUSER_URL) {
    throw new Error('DATABASE_SUPERUSER_URL is required for db:setup');
  }
  const app = parseConnectionUrl(env.DATABASE_URL);
  const owner = parseConnectionUrl(env.DATABASE_MIGRATION_URL ?? env.DATABASE_URL);
  if (app.role !== env.DB_APP_ROLE) {
    throw new Error(`DATABASE_URL signs in as ${app.role}, but DB_APP_ROLE is ${env.DB_APP_ROLE}; they must name the same role`);
  }
  const targets: Target[] = [
    { database: app.database, ownerRole: owner.role, appRole: app.role },
  ];
  if (process.env.TEST_DATABASE_URL) {
    const testApp = parseConnectionUrl(process.env.TEST_DATABASE_URL);
    targets.push({ ...targets[0]!, database: testApp.database });
  }

  const client = new pg.Client({ connectionString: env.DATABASE_SUPERUSER_URL });
  await client.connect();
  try {
    // Roles belong to the whole server, so once is enough for every target database.
    await ensureRole(client, owner.role, owner.password, env.DATABASE_MIGRATION_URL ?? env.DATABASE_URL);
    await ensureRole(client, app.role, app.password, env.DATABASE_URL);
    for (const target of targets) await ensureDatabase(client, target);
  } finally {
    await client.end();
  }
  console.log('Database setup complete. Next: npm run db:migrate && npm run db:seed');
}

main().catch((error: Error) => {
  console.error(error.message);
  process.exit(1);
});
