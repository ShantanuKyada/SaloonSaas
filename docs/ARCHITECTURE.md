# Architecture

SalonOS is a multi-tenant SaaS platform for running salon businesses: scheduling, walk-ins, CRM, billing with a
credit cycle, collections, offers/packages, notifications, attendance and analytics. This document describes how the
system is put together and why. Assumptions and trade-offs that are not obvious from the code are recorded in
[DECISIONS.md](DECISIONS.md); the data model is in [ERD.md](ERD.md).

## 1. System overview

```
              Browser (React SPA)            Customer booking page (/book/:org)
                       │                                  │
                       ▼                                  ▼
             CDN / reverse proxy (TLS, static assets, gzip/brotli, HSTS)
                       │
                       ▼
        ┌──────────────────────────────┐        ┌───────────────────────────────┐
        │  API server (Node, Express)  │        │  Worker (same codebase)        │
        │  /api/v1/*  stateless        │        │  - notification dispatcher     │
        │  JWT access + refresh cookie │        │  - reminder & outstanding jobs │
        │  RBAC + tenant context       │        │  - attendance sync             │
        └──────────────┬───────────────┘        │  - package expiry, stats       │
                       │                        └───────────────┬───────────────┘
                       ▼                                        │
               PostgreSQL 16+  ◄───────────────────────────────┘
               (RLS, exclusion constraints, immutable ledger,
                outbox table used as a durable job queue)
                       │
     Providers ◄───────┘  WhatsApp Cloud API · SMTP email · HTTP SMS · biometric vendors
```

* **API** and **worker** are separate processes built from the same code. Both are stateless and can be scaled
  horizontally. The API never calls a third-party provider inside a request; it writes to the `notifications`
  outbox table in the same transaction as the business change, and the worker delivers.
* **PostgreSQL is the single source of truth** and also the job queue (`SELECT … FOR UPDATE SKIP LOCKED`). No Redis
  is required to run the product; it can be added later for caching without changing module boundaries.

## 2. Repository layout

```
apps/api        Express API + worker + migrations + seed (TypeScript, ESM)
apps/web        React 19 + Vite SPA (TanStack Query, React Router, RHF + Zod, Tailwind, Radix)
packages/shared Zod request schemas, enums, permission catalogue, status machine, money helpers, DTO types
e2e             Playwright end-to-end tests
deploy          Dockerfiles, docker-compose, nginx config, backup/restore scripts
docs            Architecture, ERD, decisions, security, deployment, backup & recovery, readiness review
```

`packages/shared` is consumed as TypeScript source during development (custom export condition
`@salon/source`) and as compiled JavaScript in production, so the browser and the API validate requests with
exactly the same schemas.

## 3. Backend module structure

```
apps/api/src
  config/        environment parsing (Zod-validated, fails fast)
  db/            pool, Kysely instance, migration runner, SQL migrations, generated table types
  core/          errors, request context, auth middleware, RBAC guards, validation, pagination,
                 audit writer, document sequences, idempotency, logger, metrics
  modules/
    auth (sign-in, sessions, two-step sign-in)  organizations  branches  users  roles  staff  expertise  services  customers
    scheduling (availability engine)  appointments  walkins  billing  payments  ledger
    collections  outstanding  offers  packages  notifications  attendance  dashboards
    reports  analytics  search  audit  settings  onboarding  public-booking
  integrations/
    notifications/  provider interface + console, WhatsApp Cloud, SMTP, HTTP SMS
    biometric/      provider interface + generic HTTP pull, push webhook, simulator (dev only)
  jobs/          worker loop and scheduled jobs (advisory-lock leader election)
  openapi/       route registry → OpenAPI 3.1 document (served at /api/docs)
```

Each module has `routes.ts` (HTTP: parsing, permission guard, response shape), `service.ts` (business rules,
transactions, audit, events) and, where queries are non-trivial, `repository.ts`. Routes never contain business
logic; services never touch `req`/`res`.

## 4. Multi-tenancy

* **Model:** shared database, shared schema. Every tenant-owned row carries `organization_id`; branch-scoped rows also
  carry `branch_id`.
* **Layer 1 — service level:** every query runs through a request-scoped transaction created by
  `withTenant(ctx)`. Services filter by organization and by the caller's accessible branches (`ctx.branchIds`).
  Branch access is checked explicitly (`assertBranchAccess`) on every read/write of a branch-scoped entity.
* **Layer 2 — database level (Row-Level Security):** the API connects as `salon_app`, a non-owner role subject to RLS.
  At the start of each request transaction it sets `app.org_id`. Every tenant table has a policy
  `organization_id = (select app_org_id())`, so a forgotten `WHERE` clause cannot leak another tenant's rows.
  Platform/system work (super-admin screens, the worker, login lookup) explicitly opts in with `app.platform = on`.
* **Layer 3 — referential integrity:** cross-entity foreign keys are composite (`organization_id`, `id`), so an
  appointment in tenant A physically cannot reference a customer, staff member or service of tenant B.

## 5. Authentication & authorization

* Email/mobile + password. Passwords hashed with Argon2id. Account lockout after repeated failures, IP rate limiting
  on auth endpoints.
* Short-lived JWT access token (15 min, held in memory by the SPA) + rotating opaque refresh token (HttpOnly,
  `SameSite=Strict`, path-scoped cookie, stored hashed). Refresh-token reuse revokes the whole token family.
* **Two-step sign-in (TOTP).** A correct password for an account that has it on returns a 5-minute challenge token
  (`typ: mfa+jwt`) instead of a session; `POST /auth/login/mfa` exchanges it plus a 6-digit code (or a recovery code) for
  the usual access token and refresh cookie. The salon policy (`organization_settings.two_factor_requirement`: off,
  owners, owners and managers) is evaluated when the principal is loaded (`core/auth-context.ts`): a required user
  without it set up has `mfaSetupRequired`, and the router (`core/router.ts`) answers `403 MFA_SETUP_REQUIRED` for every
  route that is not flagged `allowUnenrolled` (the account and security routes). One check in one place, so a new route
  cannot forget it. Secrets are AES-GCM encrypted; recovery codes are Argon2id hashes in `user_recovery_codes`
  (migration 0009). See SECURITY.md §2.
* **RBAC:** permissions are fine-grained keys (`appointments.create`, `billing.void`, …). Each organization gets its
  own editable copies of the system roles (Owner, Branch Manager, Receptionist, Staff) and can add custom roles.
  The Owner role is locked to all permissions. Platform Super Admin is a separate, organization-less user type.
* **Data scope:** users either have `all_branches` or an explicit branch list. Staff users additionally get
  "own records only" scopes (`appointments.view_own`) and masked customer contact details unless the owner enables
  them.
* Authorization is enforced in the API (`requirePermission` + service-level scope checks). The UI hides what the user
  cannot do, but that is only for usability.

## 6. Scheduling engine

* Availability is computed by a pure, unit-tested function (`modules/scheduling/engine.ts`) from: branch hours,
  holidays, staff shifts and date overrides, breaks, approved leave, manual blocks, existing bookings (including
  service buffer time), service duration, slot interval, minimum notice and "now".
* It returns per-staff status (`available`, `busy until 11:30`, `on leave`, `not working`, `not qualified`) and the
  bookable slots, which is what the booking UI displays.
* **Double-booking protection** is layered:
  1. the booking transaction takes a per-staff advisory lock (`pg_advisory_xact_lock`) and re-validates every rule;
  2. a PostgreSQL **exclusion constraint** on `appointment_items (staff_id, tstzrange(start_at, blocked_until))` for
     schedule-blocking rows makes overlapping bookings impossible even if application code is wrong;
  3. appointments carry a `version` column for optimistic concurrency on edits (drag & drop from two screens).
* A service that is **completed early gives its unused time back**: the item's end and block are cut to the completion
  minute (clean-up time still follows), later services of the same visit that never started are released, and undoing
  "completed" takes the time back only if nobody else was booked into it meanwhile. The live status shows a team member
  who just finished as busy until their clean-up ends, and shows nobody as free while the salon itself is closed.
* All instants are stored as `timestamptz`; working hours are stored as local wall-clock times and interpreted in the
  branch's IANA timezone (DST-safe via Luxon). The UI renders schedule times in the branch timezone, not the browser's.

## 7. Financial integrity

* Money is stored as integer minor units (`bigint`, e.g. paise) — no floating point anywhere in the money path.
* Creating an invoice, receiving a payment, allocating, refunding, adjusting and writing off each run in a single
  database transaction that writes the document, its lines, allocations and **ledger entries** together.
* `ledger_entries` is append-only: `UPDATE`/`DELETE` are revoked from the application role and blocked by trigger.
  Corrections are new reversing entries (void, credit adjustment, write-off).
* `customer_accounts.balance` is maintained by a trigger on ledger insert (same transaction), so it can never drift
  from the ledger. A reconciliation check (`/api/v1/ledger/reconcile`, also an integration test) verifies
  ledger ↔ invoices ↔ payments.
* Issued invoices are immutable apart from settlement fields; voiding creates reversing entries and is
  permission-gated and audited.
* Gapless, concurrency-safe document numbers come from `document_sequences` (`UPDATE … RETURNING` under row lock).
* Mutating money endpoints accept an `Idempotency-Key` header so a double-clicked "Collect payment" is recorded once.

## 8. Notifications

```
business transaction ──► INSERT notifications (status=queued, dedupe_key)   [same DB transaction]
worker ──► claim batch (FOR UPDATE SKIP LOCKED) ──► render template ──► provider.send()
       ──► sent / failed → retry with exponential backoff (max attempts) → delivery webhooks update status
```

* Providers implement one interface per channel (WhatsApp, email, SMS) and are chosen from configuration, so a
  vendor can be swapped without touching appointment or billing code.
* Consent and per-channel/per-category preferences are checked when the notification is queued and again when it
  is sent. Reminder offsets (e.g. 24 h, 2 h) are organization settings. Outstanding reminders are frequency-capped.
* Provider failure never rolls back the business transaction — it only changes the notification's status.

## 9. Attendance integration

* `BiometricProvider` interface with implementations for a configurable HTTP pull API, a signed push webhook and a
  development simulator. Raw punches are stored idempotently; `biometric_punch_id → staff` mapping resolves them.
* Daily attendance (`present`, `late`, `absent`, `on_leave`, `missing_punch`, …) is computed separately from
  schedule availability. "Punched in" never by itself means "available": availability still comes from schedule,
  leave and bookings. A provider outage is recorded on the integration and surfaced as an alert; nothing else fails.

## 10. Analytics & reporting

* Dashboards and reports are SQL aggregations over indexed transactional tables, always filtered by organization,
  accessible branches and date range (computed in the branch timezone).
* `customer_stats` (visits, lifetime spend, last visit, favourites) is maintained transactionally on invoice
  issue/void and recomputed nightly, so CRM segmentation stays fast at 100k+ customers.
* Every report supports server-side pagination and CSV export; Excel opens the CSV directly, and printable views
  provide PDF via the browser.

## 11. Observability & operations

* Structured JSON logs (pino) with request IDs, user/org IDs and latency; secrets and personal data are redacted.
* `/health` (liveness) and `/ready` (DB connectivity) endpoints; Prometheus metrics at `/metrics` (HTTP latency,
  error counts, appointment conflicts, notification failures, job failures, auth failures).
* Backups, point-in-time recovery and restore drills are described in [BACKUP_RECOVERY.md](BACKUP_RECOVERY.md);
  deployment in [DEPLOYMENT.md](DEPLOYMENT.md).

## 12. Web application

* **React 19 + Vite + TypeScript (strict)**, one chunk per screen via React Router's `lazy` routes; vendor code is split
  into long-cached chunks (React, Radix, forms, charts, dates).
* **Server state** lives in TanStack Query (cache keys per resource, invalidated by the mutations that change them);
  there is no global client store. URLs carry filters and the open record (`?range=week`, `/appointments/:id`), so every
  screen is linkable and the back button works.
* **Forms** use React Hook Form with the *same Zod schemas as the API* (`packages/shared`); server field errors are mapped
  back onto the fields and every error is translated into plain language with a next step (`lib/errors.ts`).
* **Auth in the browser:** the access token is kept in memory; the refresh cookie is HttpOnly. The API client refreshes once on a
  401, de-duplicates concurrent refreshes, and signs the user out cleanly if that fails.
* **Branch context:** the branch selector sets the scope for list screens; times are always formatted in the branch's time
  zone, not the browser's.
* **Role-based screens:** the owner sees business dashboards, managers the live "today" view, receptionists the front desk,
  and stylists a phone-first "My day". Navigation and route guards use the same permission keys the API enforces.
* **Design system:** Tailwind v4 tokens with light and dark themes, Radix primitives for focus management, and a small set
  of shared components (`components/ui`). Contrast, labels and keyboard operation are verified by automated axe checks in the
  end-to-end suite (17 screens × 2 themes plus the main dialogs).

## 13. Scalability notes

| Load | Approach |
| --- | --- |
| 100s of tenants / branches | Shared schema with `organization_id`-leading composite indexes; RLS policies use InitPlan-cached settings. |
| 100k customers per tenant | Trigram + btree indexes for search; cached `customer_stats`; server-side pagination everywhere. |
| Millions of appointments | Indexes on `(organization_id, branch_id, start_at)`; calendar queries are always date-bounded; partitioning `appointments`, `ledger_entries`, `audit_logs`, `notifications` by month is a documented next step. |
| API throughput | Stateless API behind a load balancer; connection pool per instance; PgBouncer in transaction mode is compatible because tenant settings are transaction-local (`set_config(…, true)`). |
| Background work | `SKIP LOCKED` queue lets any number of workers process notifications concurrently; scheduled jobs use advisory locks so only one instance runs each job. |
