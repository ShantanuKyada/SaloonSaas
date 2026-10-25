#!/usr/bin/env bash
# Restores a backup made by backup.sh into a database and runs sanity checks.
#
#   Practice restore (safe, the default): into a scratch database that is dropped afterwards
#     deploy/scripts/restore.sh backups/salon_20260101T020000Z.dump
#
#   Real recovery: replace the live database (stop the API and worker first!)
#     deploy/scripts/restore.sh backups/salon_….dump --into salon --replace
#
# Environment (direct mode):  PGADMIN_URL = a superuser (or database-owner) URL for the *server*, e.g.
#                             postgres://postgres:…@host:5432/postgres
# Docker mode:                BACKUP_MODE=docker uses `docker compose exec db` as the postgres superuser.
set -euo pipefail

DUMP="${1:-}"
[ -n "${DUMP}" ] && [ -f "${DUMP}" ] || { echo "Usage: $0 <dump-file> [--into <database>] [--replace]" >&2; exit 2; }
shift || true

TARGET="salon_restore_check_$(date -u +%H%M%S)"
REPLACE=0
KEEP=0
while [ $# -gt 0 ]; do
  case "$1" in
    --into) TARGET="$2"; KEEP=1; shift 2 ;;
    --replace) REPLACE=1; shift ;;
    --keep) KEEP=1; shift ;;
    *) echo "Unknown option $1" >&2; exit 2 ;;
  esac
done

MODE="${BACKUP_MODE:-direct}"
COMPOSE_FILE="${COMPOSE_FILE:-deploy/docker-compose.yml}"
OWNER_ROLE="${DB_OWNER_USER:-salon_owner}"

psql_admin() {
  local db="${ADMIN_DB:-postgres}"
  if [ "${MODE}" = "docker" ]; then docker compose -f "${COMPOSE_FILE}" exec -T db psql -U postgres -d "${db}" -v ON_ERROR_STOP=1 "$@"
  else : "${PGADMIN_URL:?Set PGADMIN_URL (superuser URL of the server) or use BACKUP_MODE=docker}"; psql "${PGADMIN_URL%/*}/${db}" -v ON_ERROR_STOP=1 "$@"; fi
}
restore_into() {
  if [ "${MODE}" = "docker" ]; then docker compose -f "${COMPOSE_FILE}" exec -T db pg_restore -U postgres --dbname="$1" --exit-on-error < "${DUMP}"
  else pg_restore --dbname="${PGADMIN_URL%/*}/$1" --exit-on-error "${DUMP}"; fi
}

case "${DUMP}" in *.gpg) echo "Decrypt first: gpg --decrypt ${DUMP} > ${DUMP%.gpg}" >&2; exit 2 ;; esac
if [ -f "${DUMP}.sha256" ]; then ( cd "$(dirname "${DUMP}")" && sha256sum --check "$(basename "${DUMP}").sha256" ); fi

if psql_admin -tAc "select 1 from pg_database where datname = '${TARGET}'" | grep -q 1; then
  if [ "${REPLACE}" -ne 1 ]; then echo "Database ${TARGET} exists. Pass --replace to overwrite it." >&2; exit 3; fi
  echo "Replacing database ${TARGET}"
  psql_admin -c "select pg_terminate_backend(pid) from pg_stat_activity where datname = '${TARGET}' and pid <> pg_backend_pid()" > /dev/null
  psql_admin -c "drop database \"${TARGET}\""
fi
psql_admin -c "create database \"${TARGET}\" owner \"${OWNER_ROLE}\" encoding 'UTF8' template template0"

echo "Restoring ${DUMP} into ${TARGET} …"
restore_into "${TARGET}"

echo "Sanity checks:"
check() { ADMIN_DB="${TARGET}" psql_admin -tAc "$1"; }
echo "  migrations applied : $(check 'select count(*) from schema_migrations')"
echo "  organizations      : $(check 'select count(*) from organizations')"
echo "  customers          : $(check 'select count(*) from customers')"
echo "  invoices           : $(check 'select count(*) from invoices')"
echo "  ledger entries     : $(check 'select count(*) from ledger_entries')"
OUT_OF_BALANCE="$(check "select count(*) from customer_accounts ca where ca.balance <> coalesce((select sum(debit - credit) from ledger_entries le where le.customer_id = ca.customer_id and le.organization_id = ca.organization_id), 0)")"
echo "  accounts whose balance differs from their ledger: ${OUT_OF_BALANCE}"
[ "${OUT_OF_BALANCE}" = "0" ] || { echo "WARNING: ledger and balances disagree. Investigate before using this restore." >&2; exit 4; }

if [ "${KEEP}" -ne 1 ]; then
  psql_admin -c "drop database \"${TARGET}\"" > /dev/null
  echo "Practice restore succeeded and the scratch database was removed."
else
  echo "Restore finished into ${TARGET}."
fi
