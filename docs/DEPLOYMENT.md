# Deployment

This guide takes a clean Linux server to a running, backed-up production system. It assumes the Docker-based stack in
`deploy/`; the same images run on any container platform. Read [SECURITY.md](SECURITY.md) §13 before going live.

## 1. What runs where

| Service | Image | Role | Scale |
| --- | --- | --- | --- |
| `web` | `deploy/Dockerfile.web` (nginx) | Serves the single-page app, proxies `/api` to the API, sets security headers | 1+ (stateless) |
| `api` | `deploy/Dockerfile.api` | REST API on port 4000 | 1+ (stateless) |
| `worker` | same image, `node dist/worker.js` | Sends notifications, runs scheduled jobs | 1 is enough; more are safe |
| `migrate` | same image | One-shot: creates roles/database on first run, applies SQL migrations | Runs on every `up` |
| `db` | `postgres:17-alpine` | PostgreSQL (replace with a managed service if you prefer) | 1 |

Minimum for one busy salon group: 2 vCPU, 4 GB RAM, 40 GB SSD. PostgreSQL is the only stateful component.

## 2. Configuration

All configuration is environment variables, validated at start-up; the process **refuses to start** with unsafe values in
production (example secrets, wildcard CORS, console notification mode, missing metrics token).

Copy `deploy/.env.example` to `deploy/.env` and fill in every value.

| Variable | Required | Meaning |
| --- | --- | --- |
| `PUBLIC_URL` | yes | The https address staff and customers use. Also the only allowed browser origin and the base of booking links |
| `POSTGRES_PASSWORD` | yes (bundled db) | Password of the database superuser (used only by the `migrate` job and backups) |
| `DB_OWNER_PASSWORD` | yes | Password of the migration role `salon_owner` (owns the tables) |
| `DB_APP_PASSWORD` | yes | Password of the runtime role `salon_app` (**not** the owner, so row-level security applies) |
| `JWT_ACCESS_SECRET` | yes | ≥ 32 random characters; signs access tokens |
| `PUBLIC_LINK_SECRET` | yes | ≥ 32 random characters |
| `DATA_ENCRYPTION_KEY` | yes | 32 random bytes, base64; encrypts integration secrets at rest |
| `METRICS_TOKEN` | yes | ≥ 16 characters; bearer token for `/metrics` |
| `TRUST_PROXY` | yes | Number of proxies in front of the API (web container + your TLS proxy = 2) |
| `NOTIFICATIONS_MODE` | no | `live` (default in the stack), `console` (never in production), `disabled` |
| `WHATSAPP_APP_SECRET`, `WHATSAPP_WEBHOOK_VERIFY_TOKEN` | if using WhatsApp | Verify delivery-receipt webhooks |
| `DB_HOST`, `DB_SSL`, `DB_POOL_MAX` | no | Use when the database is managed or remote |
| `LOG_LEVEL` | no | `info` (default) |

Generate secrets:

```bash
node -e "console.log(require('crypto').randomBytes(48).toString('base64url'))"   # JWT / link / db passwords
node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"      # DATA_ENCRYPTION_KEY
```

Per-salon settings (WhatsApp number, SMTP, SMS gateway, attendance devices, tax, reminders) are **not** environment
variables: owners enter them in *Settings → Connections*, where secrets are encrypted and write-only.

## 3. First deployment

```bash
git clone <repository> salonos && cd salonos
cp deploy/.env.example deploy/.env          # edit: PUBLIC_URL and every secret
chmod +x deploy/scripts/*.sh
docker compose -f deploy/docker-compose.yml --env-file deploy/.env up -d --build
docker compose -f deploy/docker-compose.yml --env-file deploy/.env ps      # api and web should become "healthy"
```

`up` runs the `migrate` job first (creates the `salon_owner`/`salon_app` roles and the database if they do not exist,
then applies migrations), and starts the API and worker only after it succeeds.

Create the first platform administrator, then sign in at `PUBLIC_URL` and onboard the first salon from *Platform*:

```bash
docker compose -f deploy/docker-compose.yml --env-file deploy/.env run --rm \
  -e PLATFORM_ADMIN_EMAIL=you@example.com -e PLATFORM_ADMIN_PASSWORD='a-long-password-1' -e PLATFORM_ADMIN_NAME='Your Name' \
  api node dist/seed/create-platform-admin.js
```

The new salon's owner receives a temporary password and must choose their own at first sign-in; the *Setup guide*
(`/settings/setup`) then walks them through services, team, hours and messaging.

**Two-step sign-in.** In production the platform administrator is required to use an authenticator app: the first
sign-in goes straight to *Account security* to set it up (keep the recovery codes somewhere safe, and create a second
platform administrator so one lost phone cannot lock you out). Each salon's owner chooses who else must use it under
*Settings → Privacy*; recommend at least owners. If a sole owner or administrator loses their phone *and* recovery
codes, switch it off from the server and let them enrol again:

```bash
docker compose -f deploy/docker-compose.yml --env-file deploy/.env run --rm \
  -e USER_EMAIL=owner@salon.example api node dist/seed/reset-two-factor.js
```

> Never run `db:seed` in production: it creates demo users with a known password and refuses to run when
> `NODE_ENV=production`.

## 4. TLS and the public edge

The `web` container speaks plain HTTP on port 8080 and expects TLS to be terminated in front of it. Pick one:

**A. Cloud load balancer** (recommended): terminate TLS there, forward to port 8080, add `X-Forwarded-Proto`.

**B. Caddy on the host** (automatic certificates):

```
salon.example.com {
  encode zstd gzip
  reverse_proxy 127.0.0.1:8080
}
```

**C. Host nginx + certbot:** a standard `proxy_pass http://127.0.0.1:8080;` server block with
`proxy_set_header X-Forwarded-Proto $scheme;` and certbot-managed certificates.

After enabling TLS verify: cookies are `Secure`, `Strict-Transport-Security` is present, and `https://…/api/docs` loads.
Keep `TRUST_PROXY` equal to the number of hops (web container + this edge = 2), otherwise rate limiting sees the proxy's address.

## 5. Managed PostgreSQL (optional)

Remove the `db` service, set `DB_HOST`/`DB_SSL=true`, and either keep the `migrate` job (give it a superuser URL via
`DATABASE_SUPERUSER_URL`) or provision the roles yourself:

```sql
create role salon_owner login password '…' nosuperuser nocreatedb nocreaterole;
create role salon_app   login password '…' nosuperuser nocreatedb nocreaterole;
create database salon owner salon_owner encoding 'UTF8' template template0;
grant connect on database salon to salon_app;
\c salon
create extension if not exists citext;       -- needs a privileged role on most managed services
create extension if not exists btree_gist;
create extension if not exists pg_trgm;
```

The migration runner then grants `salon_app` exactly the privileges it needs and revokes update/delete on the ledger and
audit tables. **Do not run the API as `salon_owner`**: the owner bypasses row-level security.

## 6. Upgrades and migrations

```bash
git pull
docker compose -f deploy/docker-compose.yml --env-file deploy/.env up -d --build
```

Migrations are plain SQL files, applied once, in order, each in a transaction, guarded by an advisory lock so two
instances starting together cannot collide. Applied files are checksummed: **never edit an applied migration**; add a new one.

Rules for zero-downtime releases:

1. Take a backup first (`deploy/scripts/backup.sh`); it is the rollback plan for a bad migration.
2. Migrations must be backwards compatible with the previous release (add columns/tables first; remove them in a later
   release once nothing reads them), because old API containers keep running until the new ones are healthy.
3. Roll back application code by redeploying the previous image tag; roll back data only by restoring a backup, so prefer
   fixing forward with a new migration.

## 7. Operations

* **Health:** `GET /health` (process is up), `GET /ready` (database reachable). Docker health checks use these.
* **Metrics:** `GET /metrics` with `Authorization: Bearer $METRICS_TOKEN` (Prometheus text format):
  `http_requests_total`, `http_request_duration_seconds`, `http_errors_total`, `http_slow_requests_total`,
  `auth_failures_total`, `appointment_conflicts_total`, `db_errors_total`, `notifications_sent_total`,
  `notifications_failed_total`, `jobs_runs_total` and `integration_failures_total`.

  ```yaml
  scrape_configs:
    - job_name: salonos
      metrics_path: /metrics
      authorization: { credentials: <METRICS_TOKEN> }
      static_configs: [{ targets: ['api.internal:4000'] }]
  ```
* **Alerts worth having:** 5xx rate > 1 % for 5 min; p95 latency > 1.5 s; `/ready` failing; the *Failed* count on the
  Delivery page rising; no worker heartbeat (`select max(last_finished_at) from job_state` older than 15 minutes); database disk > 80 %.
* **Logs:** JSON on stdout (rotated by the compose logging options). Every line has a request id that is also returned to
  the user in error responses, so a screenshot of an error is enough to find the log.
* **Scaling:** add API replicas behind the load balancer; add workers freely (`FOR UPDATE SKIP LOCKED`, per-job
  advisory locks). Size `DB_POOL_MAX` × replicas below PostgreSQL's `max_connections`. In-memory rate limiting is per
  replica (see SECURITY.md §14).
* **Time zones:** timestamps are stored as UTC instants; each branch has an IANA time zone used for opening hours,
  reminders and reports.

## 8. Go-live checklist

- [ ] `docker compose … ps` shows `api`, `web` healthy and `migrate` exited 0.
- [ ] `PUBLIC_URL` loads over https; sign-in works; the refresh cookie is `Secure`.
- [ ] A test message sent from *Settings → Connections* arrives (WhatsApp/email/SMS).
- [ ] An online booking made at `PUBLIC_URL/book/<salon-code>` appears on the calendar and the confirmation is delivered.
- [ ] `deploy/scripts/backup.sh` ran, and `deploy/scripts/restore.sh <dump>` (practice restore) printed "succeeded".
- [ ] `/metrics` is scraped and an alert has been tested.
- [ ] The platform admin and every owner use unique strong passwords; demo data is absent.
