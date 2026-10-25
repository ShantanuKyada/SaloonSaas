# Entity-relationship diagrams

Generated from the live schema by `npm run db:erd -w @salon/api` (62 tables, 8 migrations applied). Do not edit by hand:
re-run the script after adding a migration. Only key columns are shown; the SQL migrations in
`apps/api/src/db/migrations` are the full definition.

Conventions that hold for every table below:

* UUID primary keys; `timestamptz` for every instant; money in integer minor units (paise); statuses are text with CHECK constraints.
* Tenant-owned tables have `organization_id` and **row-level security** (59 tables). The runtime database role is not the table owner, so
  the policies always apply; migrations run as a separate owner role.
* Foreign keys to tenant-owned tables are composite `(organization_id, id)`, so a row can never point at another tenant's data.

## Tenancy, users and access control

Every tenant-owned table carries `organization_id`; branch-scoped data also carries `branch_id`. Users reach branches through `user_branches` and permissions through their role.

```mermaid
erDiagram
  branches ||--o{ branch_hours : "branch_id"
  branches ||--o{ holidays : "branch_id"
  branches ||--o{ organization_integrations : "branch_id"
  branches ||--o{ user_branches : "branch_id"
  organizations ||--o{ branches : "org"
  organizations ||--o{ holidays : "org"
  organizations ||--o{ organization_integrations : "org"
  organizations ||--o{ organization_settings : "org"
  organizations ||--o{ roles : "org"
  organizations ||--o{ users : "org"
  permissions ||--o{ role_permissions : "permission_key"
  roles ||--o{ role_permissions : "role_id"
  roles ||--o{ users : "role_id"
  users ||--o{ branches : "manager_user_id"
  users ||--o{ refresh_tokens : "user_id"
  users ||--o{ user_branches : "user_id"
  organizations {
    uuid id PK
    citext code
    text name
    citext email
    text status
  }
  organization_settings {
    uuid organization_id PK
  }
  organization_integrations {
    uuid id PK
    uuid branch_id FK
    text status
  }
  branches {
    uuid id PK
    citext code
    text name
    citext email
    uuid manager_user_id FK
    text status
  }
  branch_hours {
    uuid branch_id PK
    smallint weekday PK
  }
  holidays {
    uuid id PK
    uuid branch_id FK
    date date
    text name
  }
  users {
    uuid id PK
    uuid role_id FK
    citext email
    text full_name
    text status
  }
  user_branches {
    uuid user_id PK
    uuid branch_id PK
  }
  roles {
    uuid id PK
    text name
  }
  role_permissions {
    uuid role_id PK
    text permission_key PK
  }
  permissions {
    text key PK
  }
  refresh_tokens {
    uuid id PK
    uuid user_id FK
  }
```

## Services, packages and offers

The catalogue. Services belong to a category, require expertise and are priced per branch when needed. Packages bundle services; offers discount bills.

```mermaid
erDiagram
  expertise ||--o{ service_expertise : "expertise_id"
  offers ||--o{ offer_branches : "offer_id"
  offers ||--o{ offer_categories : "offer_id"
  offers ||--o{ offer_customers : "offer_id"
  offers ||--o{ offer_services : "offer_id"
  packages ||--o{ package_branches : "package_id"
  packages ||--o{ package_items : "package_id"
  service_categories ||--o{ offer_categories : "category_id"
  service_categories ||--o{ services : "category_id"
  services ||--o{ offer_services : "service_id"
  services ||--o{ package_items : "service_id"
  services ||--o{ service_branches : "service_id"
  services ||--o{ service_expertise : "service_id"
  service_categories {
    uuid id PK
    text name
    text status
  }
  services {
    uuid id PK
    uuid category_id FK
    citext code
    text name
    text status
    uuid created_by FK
  }
  service_branches {
    uuid service_id PK
    uuid branch_id PK
  }
  service_expertise {
    uuid service_id PK
    uuid expertise_id PK
  }
  expertise {
    uuid id PK
    text name
    text status
  }
  packages {
    uuid id PK
    citext code
    text name
    text status
    uuid created_by FK
  }
  package_items {
    uuid package_id PK
    uuid service_id PK
  }
  package_branches {
    uuid package_id PK
    uuid branch_id PK
  }
  offers {
    uuid id PK
    text name
    citext code
    text status
    uuid created_by FK
  }
  offer_services {
    uuid offer_id PK
    uuid service_id PK
  }
  offer_categories {
    uuid offer_id PK
    uuid category_id PK
  }
  offer_branches {
    uuid offer_id PK
    uuid branch_id PK
  }
  offer_customers {
    uuid offer_id PK
    uuid customer_id PK
  }
```

## Staff, schedules and attendance

Availability (shifts, breaks, leave, blocked time) is separate from attendance (what actually happened, from punches).

```mermaid
erDiagram
  staff ||--o{ attendance_days : "staff_id"
  staff ||--o{ attendance_punches : "staff_id"
  staff ||--o{ staff_breaks : "staff_id"
  staff ||--o{ staff_expertise : "staff_id"
  staff ||--o{ staff_leaves : "staff_id"
  staff ||--o{ staff_schedule_overrides : "staff_id"
  staff ||--o{ staff_services : "staff_id"
  staff ||--o{ staff_shifts : "staff_id"
  staff ||--o{ staff_time_blocks : "staff_id"
  staff {
    uuid id PK
    uuid branch_id FK
    uuid user_id FK
    text full_name
    citext email
    uuid created_by FK
  }
  staff_expertise {
    uuid staff_id PK
    uuid expertise_id PK
  }
  staff_services {
    uuid staff_id PK
    uuid service_id PK
  }
  staff_shifts {
    uuid id PK
    uuid staff_id FK
  }
  staff_breaks {
    uuid id PK
    uuid staff_id FK
  }
  staff_schedule_overrides {
    uuid id PK
    uuid staff_id FK
    date date
    uuid created_by FK
  }
  staff_leaves {
    uuid id PK
    uuid staff_id FK
    text status
    uuid decided_by FK
    uuid created_by FK
  }
  staff_time_blocks {
    uuid id PK
    uuid branch_id FK
    uuid staff_id FK
    timestamptz start_at
    timestamptz end_at
    uuid created_by FK
  }
  attendance_punches {
    uuid id PK
    uuid branch_id FK
    uuid integration_id FK
    uuid staff_id FK
    uuid created_by FK
  }
  attendance_days {
    uuid id PK
    uuid branch_id FK
    uuid staff_id FK
    date date
    text status
    uuid overridden_by FK
  }
```

## Customers and appointments

`appointment_items` holds one row per service; an exclusion constraint on (staff, time range) makes double-booking impossible at the database level.

```mermaid
erDiagram
  appointments ||--o{ appointment_events : "appointment_id"
  appointments ||--o{ appointment_items : "appointment_id"
  customer_package_items ||--o{ appointment_items : "customer_package_item_id"
  customer_packages ||--o{ customer_package_items : "customer_package_id"
  customers ||--o{ appointments : "customer_id"
  customers ||--o{ customer_packages : "customer_id"
  customers ||--o{ customer_stats : "customer_id"
  customers {
    uuid id PK
    text full_name
    citext email
    uuid preferred_branch_id FK
    uuid preferred_staff_id FK
    uuid registered_branch_id FK
    uuid referred_by_id FK
    text status
    uuid created_by FK
  }
  customer_stats {
    uuid customer_id PK
  }
  customer_packages {
    uuid id PK
    uuid customer_id FK
    uuid package_id FK
    uuid branch_id FK
    uuid invoice_id FK
    uuid invoice_item_id FK
    text status
  }
  customer_package_items {
    uuid id PK
    uuid customer_package_id FK
    uuid service_id FK
  }
  segments {
    uuid id PK
    text name
    uuid created_by FK
  }
  appointments {
    uuid id PK
    uuid branch_id FK
    text booking_number
    uuid customer_id FK
    text status
    timestamptz start_at
    timestamptz end_at
    uuid cancelled_by FK
    uuid invoice_id FK
    uuid created_by FK
    uuid updated_by FK
  }
  appointment_items {
    uuid id PK
    uuid branch_id FK
    uuid appointment_id FK
    uuid service_id FK
    uuid staff_id FK
    timestamptz start_at
    timestamptz end_at
    timestamptz blocked_until
    uuid customer_package_item_id FK
    text status
  }
  appointment_events {
    bigint id PK
    uuid appointment_id FK
    uuid actor_user_id FK
  }
```

## Billing, payments and the ledger

Invoices and payments are immutable once issued. `ledger_entries` is append-only and `customer_accounts` is maintained by a trigger, so balances are always derivable from the ledger.

```mermaid
erDiagram
  invoice_items ||--o{ package_redemptions : "invoice_item_id"
  invoices ||--o{ invoice_items : "invoice_id"
  invoices ||--o{ ledger_adjustments : "invoice_id"
  invoices ||--o{ offer_redemptions : "invoice_id"
  invoices ||--o{ package_redemptions : "invoice_id"
  invoices ||--o{ payment_allocations : "invoice_id"
  payments ||--o{ payment_allocations : "payment_id"
  payments ||--o{ refunds : "payment_id"
  invoices {
    uuid id PK
    uuid branch_id FK
    uuid customer_id FK
    text invoice_number
    uuid appointment_id FK
    text status
    bigint grand_total
    uuid offer_id FK
    uuid created_by FK
    uuid voided_by FK
  }
  invoice_items {
    uuid id PK
    uuid invoice_id FK
    uuid service_id FK
    uuid package_id FK
    uuid customer_package_item_id FK
    uuid appointment_item_id FK
    uuid staff_id FK
  }
  payments {
    uuid id PK
    uuid branch_id FK
    uuid customer_id FK
    bigint amount
    uuid received_by FK
    text status
    uuid voided_by FK
  }
  payment_allocations {
    uuid id PK
    uuid payment_id FK
    uuid invoice_id FK
    bigint amount
    uuid created_by FK
    uuid reversed_by FK
  }
  refunds {
    uuid id PK
    uuid branch_id FK
    uuid customer_id FK
    uuid payment_id FK
    bigint amount
    uuid created_by FK
  }
  ledger_entries {
    bigint id PK
    uuid branch_id FK
    uuid customer_id FK
    uuid created_by FK
  }
  ledger_adjustments {
    uuid id PK
    uuid branch_id FK
    uuid customer_id FK
    uuid invoice_id FK
    bigint amount
    uuid created_by FK
  }
  customer_accounts {
    uuid customer_id PK
  }
  offer_redemptions {
    uuid id PK
    uuid offer_id FK
    uuid invoice_id FK
    uuid customer_id FK
  }
  package_redemptions {
    uuid id PK
    uuid customer_package_item_id FK
    uuid invoice_id FK
    uuid invoice_item_id FK
    uuid branch_id FK
    uuid redeemed_by FK
    uuid reversed_by FK
  }
  document_sequences {
    uuid organization_id PK
    text scope_key PK
    text doc_type PK
    text period_key PK
  }
```

## Notifications, consent and platform tables

`notifications` is a transactional outbox: rows are written in the same transaction as the business change and delivered by the worker.

```mermaid
erDiagram
  campaigns ||--o{ notifications : "campaign_id"
  notification_templates {
    uuid id PK
    text name
  }
  notifications {
    uuid id PK
    uuid branch_id FK
    uuid customer_id FK
    uuid campaign_id FK
    text status
    uuid created_by FK
  }
  campaigns {
    uuid id PK
    text name
    text status
    uuid created_by FK
  }
  customer_notification_preferences {
    uuid customer_id PK
    text channel PK
    text category PK
  }
  consent_events {
    uuid id PK
    uuid customer_id FK
    uuid recorded_by FK
  }
  audit_logs {
    bigint id PK
  }
  idempotency_keys {
    uuid organization_id PK
    text key PK
  }
  job_state {
    text name PK
  }
```

## Where each rule is enforced

| Rule | Enforced by |
| --- | --- |
| No double-booking of a team member | exclusion constraint `appointment_items_no_staff_overlap` (gist on staff + time range) plus a per-staff advisory lock in the service layer |
| Tenant isolation | row-level security policies on `app.org_id`; composite foreign keys `(organization_id, id)` |
| Ledger and audit trail can never be edited or deleted | the runtime role has no UPDATE or DELETE on `ledger_entries`, `audit_logs`, `appointment_events`, `invoice_items`, `refunds`, `ledger_adjustments`, and no DELETE on `invoices`, `payments`, `payment_allocations` |
| Customer balance equals the sum of their ledger | `customer_accounts` is written only by a security-definer trigger on `ledger_entries`; `GET /ledger/reconcile` and the restore script verify it |
| Invoice and payment totals add up | deferred constraint triggers verify settlement at commit |
| Gapless invoice / receipt / booking numbers | `document_sequences` row locked inside the issuing transaction |
| A request is never processed twice | `idempotency_keys` unique per organization and key |
