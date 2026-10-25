#!/usr/bin/env bash
# Logical backup of the salon database (custom-format dump, verified, checksummed, optionally encrypted, pruned).
#
#   DATABASE_MIGRATION_URL=postgres://salon_owner:…@host:5432/salon deploy/scripts/backup.sh
#   BACKUP_MODE=docker deploy/scripts/backup.sh          # dump from the compose `db` container instead
#
# Environment:
#   BACKUP_DIR             where dumps go (default ./backups)
#   BACKUP_KEEP_DAYS       delete dumps older than this many days (default 14)
#   BACKUP_GPG_RECIPIENT   if set, the dump is encrypted for this GPG key and the plain file is removed
#   BACKUP_UPLOAD_COMMAND  optional command run with the final file path as $1 (e.g. "aws s3 cp - s3://bucket/")
#
# Run it from cron or a systemd timer at least daily (see docs/BACKUP_RECOVERY.md for RPO/RTO guidance).
set -euo pipefail

BACKUP_DIR="${BACKUP_DIR:-./backups}"
KEEP_DAYS="${BACKUP_KEEP_DAYS:-14}"
MODE="${BACKUP_MODE:-direct}"
COMPOSE_FILE="${COMPOSE_FILE:-deploy/docker-compose.yml}"
DB_NAME="${DB_NAME:-salon}"
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
FILE="${BACKUP_DIR}/salon_${STAMP}.dump"

mkdir -p "${BACKUP_DIR}"
umask 077

echo "[$(date -u +%FT%TZ)] backup started → ${FILE}"
if [ "${MODE}" = "docker" ]; then
  docker compose -f "${COMPOSE_FILE}" exec -T db pg_dump -U postgres -d "${DB_NAME}" --format=custom --compress=6 > "${FILE}.partial"
else
  : "${DATABASE_MIGRATION_URL:?Set DATABASE_MIGRATION_URL (the owner role) or use BACKUP_MODE=docker}"
  pg_dump --dbname="${DATABASE_MIGRATION_URL}" --format=custom --compress=6 --file="${FILE}.partial"
fi

# A dump that cannot be listed is not a backup.
if [ "${MODE}" = "docker" ]; then
  docker compose -f "${COMPOSE_FILE}" exec -T db pg_restore --list < "${FILE}.partial" > /dev/null
else
  pg_restore --list "${FILE}.partial" > /dev/null
fi
mv "${FILE}.partial" "${FILE}"
( cd "${BACKUP_DIR}" && sha256sum "$(basename "${FILE}")" > "$(basename "${FILE}").sha256" )
SIZE="$(du -h "${FILE}" | cut -f1)"

FINAL="${FILE}"
if [ -n "${BACKUP_GPG_RECIPIENT:-}" ]; then
  gpg --batch --yes --trust-model always --encrypt --recipient "${BACKUP_GPG_RECIPIENT}" --output "${FILE}.gpg" "${FILE}"
  rm -f "${FILE}" "${FILE}.sha256"
  FINAL="${FILE}.gpg"
  ( cd "${BACKUP_DIR}" && sha256sum "$(basename "${FINAL}")" > "$(basename "${FINAL}").sha256" )
fi

if [ -n "${BACKUP_UPLOAD_COMMAND:-}" ]; then
  ${BACKUP_UPLOAD_COMMAND} "${FINAL}"
fi

find "${BACKUP_DIR}" -maxdepth 1 -name 'salon_*.dump*' -mtime +"${KEEP_DAYS}" -delete

echo "[$(date -u +%FT%TZ)] backup finished: ${FINAL} (${SIZE})"
