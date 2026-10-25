// Runs in every test worker before modules load: points the app at the isolated test database.
import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';

const envFile = resolve(__dirname, '../../../.env');
if (existsSync(envFile)) {
  for (const line of readFileSync(envFile, 'utf8').split(/\r?\n/)) {
    const m = /^([A-Z0-9_]+)=(.*)$/.exec(line);
    if (m && process.env[m[1]!] === undefined) process.env[m[1]!] = m[2]!.replace(/^"(.*)"$/, '$1');
  }
}
process.env.NODE_ENV = 'test';
if (process.env.TEST_DATABASE_URL) process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;
if (process.env.TEST_DATABASE_MIGRATION_URL) process.env.DATABASE_MIGRATION_URL = process.env.TEST_DATABASE_MIGRATION_URL;
process.env.NOTIFICATIONS_MODE = 'console';
process.env.LOG_LEVEL = process.env.TEST_LOG ? 'error' : 'silent';
