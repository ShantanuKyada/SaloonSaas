// Generates docs/ERD.md from the live database schema (tables, key columns and foreign keys) so the diagram can never
// drift from the migrations.   npm run db:erd -w @salon/api
import { writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

const url = process.env.DATABASE_MIGRATION_URL;
if (!url) throw new Error('DATABASE_MIGRATION_URL is required');

const DOMAINS = [
  {
    title: 'Tenancy, users and access control',
    blurb: 'Every tenant-owned table carries `organization_id`; branch-scoped data also carries `branch_id`. Users reach branches through `user_branches` and permissions through their role.',
    tables: ['organizations', 'organization_settings', 'organization_integrations', 'branches', 'branch_hours', 'holidays', 'users', 'user_branches', 'roles', 'role_permissions', 'permissions', 'refresh_tokens'],
  },
  {
    title: 'Services, packages and offers',
    blurb: 'The catalogue. Services belong to a category, require expertise and are priced per branch when needed. Packages bundle services; offers discount bills.',
    tables: ['service_categories', 'services', 'service_branches', 'service_expertise', 'expertise', 'packages', 'package_items', 'package_branches', 'offers', 'offer_services', 'offer_categories', 'offer_branches', 'offer_customers'],
  },
  {
    title: 'Staff, schedules and attendance',
    blurb: 'Availability (shifts, breaks, leave, blocked time) is separate from attendance (what actually happened, from punches).',
    tables: ['staff', 'staff_expertise', 'staff_services', 'staff_shifts', 'staff_breaks', 'staff_schedule_overrides', 'staff_leaves', 'staff_time_blocks', 'attendance_punches', 'attendance_days'],
  },
  {
    title: 'Customers and appointments',
    blurb: '`appointment_items` holds one row per service; an exclusion constraint on (staff, time range) makes double-booking impossible at the database level.',
    tables: ['customers', 'customer_stats', 'customer_packages', 'customer_package_items', 'segments', 'appointments', 'appointment_items', 'appointment_events'],
  },
  {
    title: 'Billing, payments and the ledger',
    blurb: 'Invoices and payments are immutable once issued. `ledger_entries` is append-only and `customer_accounts` is maintained by a trigger, so balances are always derivable from the ledger.',
    tables: ['invoices', 'invoice_items', 'payments', 'payment_allocations', 'refunds', 'ledger_entries', 'ledger_adjustments', 'customer_accounts', 'offer_redemptions', 'package_redemptions', 'document_sequences'],
  },
  {
    title: 'Notifications, consent and platform tables',
    blurb: '`notifications` is a transactional outbox: rows are written in the same transaction as the business change and delivered by the worker.',
    tables: ['notification_templates', 'notifications', 'campaigns', 'customer_notification_preferences', 'consent_events', 'audit_logs', 'idempotency_keys', 'job_state'],
  },
];

const client = new pg.Client({ connectionString: url });
await client.connect();

const columns = (await client.query(`
  select c.table_name, c.column_name, c.data_type, c.is_nullable, c.ordinal_position
  from information_schema.columns c
  join information_schema.tables t on t.table_schema = c.table_schema and t.table_name = c.table_name and t.table_type = 'BASE TABLE'
  where c.table_schema = 'public' and c.table_name <> 'schema_migrations'
  order by c.table_name, c.ordinal_position`)).rows;

const primaryKeys = (await client.query(`
  select tc.table_name, kcu.column_name
  from information_schema.table_constraints tc
  join information_schema.key_column_usage kcu on kcu.constraint_name = tc.constraint_name and kcu.table_schema = tc.table_schema
  where tc.table_schema = 'public' and tc.constraint_type = 'PRIMARY KEY'`)).rows;

const foreignKeys = (await client.query(`
  select cl.relname as child, pcl.relname as parent,
         array(select a.attname::text from unnest(con.conkey) k join pg_attribute a on a.attrelid = con.conrelid and a.attnum = k order by array_position(con.conkey, k)) as child_cols
  from pg_constraint con
  join pg_class cl on cl.oid = con.conrelid
  join pg_class pcl on pcl.oid = con.confrelid
  join pg_namespace ns on ns.oid = cl.relnamespace and ns.nspname = 'public'
  where con.contype = 'f'`)).rows;

const rowSecurity = new Set((await client.query(`select relname from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname = 'public' and c.relrowsecurity`)).rows.map((r) => r.relname));
const migrations = (await client.query('select count(*)::int as n from schema_migrations')).rows[0].n;
await client.end();

const byTable = Map.groupBy(columns, (c) => c.table_name);
const pk = new Map();
for (const r of primaryKeys) pk.set(r.table_name, [...(pk.get(r.table_name) ?? []), r.column_name]);
const fkCols = new Map();
for (const fk of foreignKeys) for (const col of fk.child_cols) if (col !== 'organization_id') fkCols.set(`${fk.child}.${col}`, true);

const type = (t) => ({ 'timestamp with time zone': 'timestamptz', 'character varying': 'text', integer: 'int', bigint: 'bigint', boolean: 'bool', uuid: 'uuid', text: 'text', jsonb: 'jsonb', date: 'date', 'time without time zone': 'time', numeric: 'numeric', ARRAY: 'array', 'USER-DEFINED': 'citext', smallint: 'smallint', 'double precision': 'float' })[t] ?? t.replace(/\s+/g, '_');
const keyColumns = (table) => {
  const cols = byTable.get(table) ?? [];
  const shown = cols.filter((c) => (pk.get(table) ?? []).includes(c.column_name) || fkCols.has(`${table}.${c.column_name}`) || ['status', 'name', 'full_name', 'code', 'invoice_number', 'booking_number', 'amount', 'grand_total', 'start_at', 'end_at', 'blocked_until', 'email', 'date'].includes(c.column_name));
  return shown.slice(0, 12);
};

const allTables = new Set(byTable.keys());
const placed = new Set(DOMAINS.flatMap((d) => d.tables));
const missing = [...allTables].filter((t) => !placed.has(t));
if (missing.length) throw new Error(`Tables not assigned to a diagram: ${missing.join(', ')}`);

let out = `# Entity-relationship diagrams

Generated from the live schema by \`npm run db:erd -w @salon/api\` (${allTables.size} tables, ${migrations} migrations applied). Do not edit by hand:
re-run the script after adding a migration. Only key columns are shown; the SQL migrations in
\`apps/api/src/db/migrations\` are the full definition.

Conventions that hold for every table below:

* UUID primary keys; \`timestamptz\` for every instant; money in integer minor units (paise); statuses are text with CHECK constraints.
* Tenant-owned tables have \`organization_id\` and **row-level security** (${rowSecurity.size} tables). The runtime database role is not the table owner, so
  the policies always apply; migrations run as a separate owner role.
* Foreign keys to tenant-owned tables are composite \`(organization_id, id)\`, so a row can never point at another tenant's data.

`;

for (const domain of DOMAINS) {
  const tables = domain.tables.filter((t) => allTables.has(t));
  const inDomain = new Set(tables);
  out += `## ${domain.title}\n\n${domain.blurb}\n\n\`\`\`mermaid\nerDiagram\n`;
  const rels = new Map();
  for (const fk of foreignKeys) {
    if (!inDomain.has(fk.child) || !inDomain.has(fk.parent) || fk.child === fk.parent) continue;
    const label = fk.child_cols.filter((c) => c !== 'organization_id').join('+') || 'org';
    const key = `${fk.parent}|${fk.child}|${label}`;
    rels.set(key, `  ${fk.parent} ||--o{ ${fk.child} : "${label}"\n`);
  }
  out += [...rels.values()].sort().join('');
  for (const t of tables) {
    out += `  ${t} {\n`;
    for (const c of keyColumns(t)) {
      const tag = (pk.get(t) ?? []).includes(c.column_name) ? ' PK' : fkCols.has(`${t}.${c.column_name}`) ? ' FK' : '';
      out += `    ${type(c.data_type)} ${c.column_name}${tag}\n`;
    }
    out += '  }\n';
  }
  out += '```\n\n';
}

out += `## Where each rule is enforced

| Rule | Enforced by |
| --- | --- |
| No double-booking of a team member | exclusion constraint \`appointment_items_no_staff_overlap\` (gist on staff + time range) plus a per-staff advisory lock in the service layer |
| Tenant isolation | row-level security policies on \`app.org_id\`; composite foreign keys \`(organization_id, id)\` |
| Ledger and audit trail can never be edited or deleted | the runtime role has no UPDATE or DELETE on \`ledger_entries\`, \`audit_logs\`, \`appointment_events\`, \`invoice_items\`, \`refunds\`, \`ledger_adjustments\`, and no DELETE on \`invoices\`, \`payments\`, \`payment_allocations\` |
| Customer balance equals the sum of their ledger | \`customer_accounts\` is written only by a security-definer trigger on \`ledger_entries\`; \`GET /ledger/reconcile\` and the restore script verify it |
| Invoice and payment totals add up | deferred constraint triggers verify settlement at commit |
| Gapless invoice / receipt / booking numbers | \`document_sequences\` row locked inside the issuing transaction |
| A request is never processed twice | \`idempotency_keys\` unique per organization and key |
`;

const target = resolve(dirname(fileURLToPath(import.meta.url)), '../../../docs/ERD.md');
writeFileSync(target, out);
console.log(`Wrote ${target}`);
