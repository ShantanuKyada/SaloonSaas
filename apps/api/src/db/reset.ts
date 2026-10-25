import pg from 'pg';
import { env, isProduction } from '../config/env.js';
import { runMigrations } from './migrate.js';

// Development only: drops every object in the public schema, re-applies migrations. Refuses to run in production.

export async function resetSchema(connectionString: string): Promise<void> {
  const client = new pg.Client({ connectionString });
  await client.connect();
  try {
    await client.query('drop schema if exists public cascade');
    await client.query('create schema public');
  } finally {
    await client.end();
  }
}

if (process.argv[1]?.endsWith('reset.ts') || process.argv[1]?.endsWith('reset.js')) {
  if (isProduction) {
    console.error('Refusing to reset a production database.');
    process.exit(1);
  }
  const url = env.DATABASE_MIGRATION_URL ?? env.DATABASE_URL;
  await resetSchema(url);
  await runMigrations({ connectionString: url, appRole: env.DB_APP_ROLE });
  console.log('Schema reset and migrated. Run npm run db:seed to load demo data.');
}
