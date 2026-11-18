#!/usr/bin/env bash
# Loads a data-only dump into a database whose schema was created by `npm run db:migrate`, as the table owner.
# Used to copy the demo salon into a hosted staging database (see .github/workflows/staging-database.yml), where the
# seed itself would be too slow over a long network path and cannot run (it needs a superuser).
#
#   deploy/scripts/load-data.sh "$DATABASE_MIGRATION_URL" demo-data.sql
#
# The dump must come from `pg_dump --data-only` of a database at the same migration version, without the tables the
# migrations fill themselves (schema_migrations, permissions).
#
# Everything happens in one transaction: if anything fails, nothing is loaded. While loading, the owner
# - switches off its own (user) triggers on every table: the rows already carry their final state (customer balances,
#   settled invoices), so the balance trigger must not count them again and the append-only guards must not block them;
# - drops the foreign keys and re-creates them from their exact definitions afterwards, because some reference each
#   other in a circle (appointments <-> invoices, customers -> customers) and no table order satisfies them row by row.
#   Re-creating a foreign key checks every row, so the data is fully verified before the commit.
# Refuses to load into a database that already has a salon in it.
set -euo pipefail

TARGET_URL="${1:?usage: load-data.sh <owner database URL> <data-only dump>}"
DUMP="${2:?usage: load-data.sh <owner database URL> <data-only dump>}"
[ -s "$DUMP" ] || { echo "Dump file $DUMP is missing or empty" >&2; exit 1; }

existing=$(psql "$TARGET_URL" -X -tA -v ON_ERROR_STOP=1 -c 'select count(*) from public.organizations')
if [ "$existing" != "0" ]; then
  echo "The target already has $existing organization(s); refusing to load demo data on top of real or earlier data." >&2
  exit 1
fi

tables=$(psql "$TARGET_URL" -X -tA -v ON_ERROR_STOP=1 -c \
  "select string_agg(format('%I.%I', schemaname, tablename), ' ' order by tablename) from pg_tables where schemaname = 'public'")

# With an empty search path, pg_get_constraintdef schema-qualifies the tables it references, so the statements also
# work after the dump has emptied the search path.
fk_sql="set search_path = '';
  select format('alter table %I.%I %s constraint %I%s;', n.nspname, t.relname, op, c.conname,
                case when op = 'add' then ' ' || pg_get_constraintdef(c.oid) else '' end)
    from pg_constraint c join pg_class t on t.oid = c.conrelid join pg_namespace n on n.oid = t.relnamespace
    cross join (values ('drop'), ('add')) as ops(op)
   where c.contype = 'f' and n.nspname = 'public' and ops.op = :'op'
   order by t.relname, c.conname"
drop_fks=$(psql "$TARGET_URL" -X -qtA -v ON_ERROR_STOP=1 -v op=drop <<<"$fk_sql")
add_fks=$(psql "$TARGET_URL" -X -qtA -v ON_ERROR_STOP=1 -v op=add <<<"$fk_sql")

{
  echo '\set ON_ERROR_STOP on'
  echo 'begin;'
  for t in $tables; do echo "alter table $t disable trigger user;"; done
  echo "$drop_fks"
  cat "$DUMP"
  echo "$add_fks"
  for t in $tables; do echo "alter table $t enable trigger user;"; done
  echo 'commit;'
} | psql "$TARGET_URL" -X -q -v ON_ERROR_STOP=1 > /dev/null

echo "Re-created and verified $(grep -c . <<<"$add_fks") foreign keys"

echo "Loaded $(grep -c '^COPY ' "$DUMP") tables from $DUMP"
