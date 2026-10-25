# Backup and recovery

PostgreSQL is the only stateful part of the system: bills, ledger, customers, bookings, settings and the encrypted
integration secrets all live there. The API, worker and web containers can be rebuilt from the repository at any time.

## 1. Objectives

| | Target | How it is met |
| --- | --- | --- |
| **RPO** (data you can lose) | ≤ 24 h with nightly dumps; ≤ 5 min with WAL archiving (section 4) | `backup.sh` nightly; optional continuous archiving |
| **RTO** (time to be serving again) | ≤ 1 h | Containers rebuild in minutes; restore time is dominated by dump size (the demo database restores in seconds) |
| **Retention** | 14 daily dumps locally, 12 monthly off-site | `BACKUP_KEEP_DAYS`, off-site copy via `BACKUP_UPLOAD_COMMAND` |

## 2. Nightly logical backups

`deploy/scripts/backup.sh` writes a compressed custom-format `pg_dump`, refuses to keep a dump that `pg_restore --list`
cannot read, writes a `.sha256` next to it, optionally encrypts it with GPG, optionally uploads it, and prunes old files.

```bash
# direct (needs the PostgreSQL client tools)
DATABASE_MIGRATION_URL=postgres://salon_owner:…@db-host:5432/salon \
BACKUP_DIR=/var/backups/salonos BACKUP_GPG_RECIPIENT=backups@example.com \
BACKUP_UPLOAD_COMMAND="aws s3 cp --sse AES256" \
  deploy/scripts/backup.sh

# compose stack on this host
BACKUP_MODE=docker deploy/scripts/backup.sh
```

Schedule it (cron example, 02:15 every night; log to syslog):

```
15 2 * * *  cd /opt/salonos && BACKUP_MODE=docker BACKUP_DIR=/var/backups/salonos deploy/scripts/backup.sh 2>&1 | logger -t salonos-backup
```

Backups hold customer personal data and encrypted integration secrets. **Encrypt them and store the GPG private key and
`DATA_ENCRYPTION_KEY` separately from the backups.** Without `DATA_ENCRYPTION_KEY` a restored database loses its saved
WhatsApp/SMTP/SMS credentials (they would have to be re-entered).

## 3. Restoring

### Practice restore (do this every quarter)

Restores into a scratch database, verifies the checksum, prints counts, checks that every customer's balance equals the sum
of their ledger entries, and drops the scratch database. It never touches the live database.

```bash
PGADMIN_URL=postgres://postgres:…@db-host:5432/postgres deploy/scripts/restore.sh /var/backups/salonos/salon_20260101T021500Z.dump
# compose: BACKUP_MODE=docker deploy/scripts/restore.sh <dump>
```

Expected tail of the output:

```
  migrations applied : 8
  accounts whose balance differs from their ledger: 0
Practice restore succeeded and the scratch database was removed.
```

### Real recovery

1. Decide the recovery point and find the dump (decrypt with `gpg --decrypt file.dump.gpg > file.dump`).
2. Stop writers: `docker compose -f deploy/docker-compose.yml stop api worker web`.
3. Restore over the live database:
   `deploy/scripts/restore.sh <dump> --into salon --replace`
4. Start the stack: `docker compose -f deploy/docker-compose.yml --env-file deploy/.env up -d`. The `migrate` job applies any
   migration newer than the dump, then the API starts.
5. Verify: sign in, open *Pending payments* and a recent customer's *Ledger*, and check that today's bookings are present.
6. Tell users what time the data returns to. Anything entered after the recovery point must be re-entered; the audit log
   and notification history from before that point are preserved.
7. Write down what happened and why (see section 6).

### Restoring a single salon

Tenants share one database, so a single-salon restore is done by restoring the dump into a scratch database
(`restore.sh <dump>` with `--keep`), exporting that salon's rows (every tenant table has `organization_id`), and importing
them with the application's normal tools or SQL. Do this only with a database administrator; never overwrite the live database
for one tenant's mistake.

## 4. Point-in-time recovery (optional, for RPO of minutes)

Enable continuous WAL archiving on PostgreSQL (`archive_mode=on`, `archive_command` to object storage) and take a
physical base backup weekly (`pg_basebackup`). Managed PostgreSQL services provide this as a checkbox
("point-in-time recovery"); turn it on and keep at least 7 days. Logical dumps remain useful for single-table recovery
and for moving data between versions.

## 5. What is not backed up (and why that is fine)

* Container images and code: rebuilt from the repository and tagged releases.
* Application logs: ship them to your log service; they are not needed to restore data.
* The notification outbox is part of the database: pending messages resume after a restore. Messages sent after the
  recovery point are unknown to the restored database, so review the Delivery page and your provider's logs before assuming
  customers will not receive a duplicate reminder.

## 6. Disaster checklist

| Situation | Action |
| --- | --- |
| Database server lost | Provision PostgreSQL, run the `migrate` job (creates roles/extensions), restore the latest dump or PITR, start the stack |
| Bad deploy, schema change broke something | Redeploy the previous image tag; if data was altered, restore the pre-deploy backup |
| User deleted or changed data by mistake | Most changes are reversible in the app (cancel/restore appointment, void bill). Otherwise use the Activity log to see exactly what changed and correct it forward; avoid restoring everyone's data for one person's mistake |
| Suspected breach | Rotate `JWT_ACCESS_SECRET` (signs everyone out), reset passwords of affected users, rotate integration secrets, review the Activity log from the earliest suspicious time, restore from a backup taken before the breach if data integrity is in doubt |
| Lost `DATA_ENCRYPTION_KEY` | Integration credentials cannot be decrypted; reconnect WhatsApp/email/SMS/devices in *Settings → Connections*. Everything else is unaffected |

After any incident, record: timeline, root cause, data lost (if any), and the change that prevents a repeat.
