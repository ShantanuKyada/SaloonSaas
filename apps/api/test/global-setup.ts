// Once per test run: rebuild the test database schema from the migrations so tests start from a known state.
import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import pg from 'pg';
import { runMigrations } from '../src/db/migrate.js';

export default async function setup(): Promise<void> {
  const envFile = resolve(__dirname, '../../../.env');
  if (existsSync(envFile)) {
    for (const line of readFileSync(envFile, 'utf8').split(/\r?\n/)) {
      const m = /^([A-Z0-9_]+)=(.*)$/.exec(line);
      if (m && process.env[m[1]!] === undefined) process.env[m[1]!] = m[2]!;
    }
  }
  const url = process.env.TEST_DATABASE_MIGRATION_URL;
  if (!url) return; // pure unit tests can still run without a database
  if (!/test/.test(new URL(url).pathname)) throw new Error('Refusing to reset a database whose name does not contain "test"');
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  await client.query('drop schema if exists public cascade; create schema public;');
  await client.end();
  await runMigrations({ connectionString: url, appRole: process.env.DB_APP_ROLE ?? 'salon_app', log: () => undefined });
}
