-- 0001 Foundation: extensions, helper functions, platform tables, RBAC, audit.
-- Conventions: uuid PKs, timestamptz everywhere, money = bigint minor units, statuses = text + CHECK,
-- every tenant row has organization_id and exposes UNIQUE (organization_id, id) for composite FKs.

create extension if not exists citext;
create extension if not exists btree_gist;
create extension if not exists pg_trgm;

-- Tenant context (set per request transaction with set_config(..., true)).
create or replace function app_org_id() returns uuid
language sql stable as $$ select nullif(current_setting('app.org_id', true), '')::uuid $$;

create or replace function app_is_platform() returns boolean
language sql stable as $$ select coalesce(current_setting('app.platform', true), '') = 'on' $$;

create or replace function set_updated_at() returns trigger
language plpgsql as $$
begin
  new.updated_at := now();
  return new;
end $$;

create or replace function prevent_modification() returns trigger
language plpgsql as $$
begin
  raise exception 'Rows in % are append-only and cannot be %', tg_table_name, lower(tg_op)
    using errcode = 'P0001';
end $$;

-- Applies the standard tenant-isolation RLS policy to a table that has an organization_id column.
create or replace function app_enable_tenant_rls(tbl regclass) returns void
language plpgsql as $$
begin
  execute format('alter table %s enable row level security', tbl);
  execute format('drop policy if exists tenant_isolation on %s', tbl);
  execute format(
    'create policy tenant_isolation on %s using ((select app_is_platform()) or organization_id = (select app_org_id())) '
    'with check ((select app_is_platform()) or organization_id = (select app_org_id()))', tbl);
end $$;

create type timerange as range (subtype = time);

-- ───────────────────────────── Organizations ─────────────────────────────
create table organizations (
  id                      uuid primary key default gen_random_uuid(),
  code                    citext not null unique check (code ~ '^[a-z0-9][a-z0-9-]{1,39}$'),
  name                    text not null check (length(btrim(name)) between 2 and 120),
  legal_name              text,
  contact_person          text,
  email                   citext,
  phone                   text,
  address_line1           text,
  address_line2           text,
  city                    text,
  state                   text,
  postal_code             text,
  country                 char(2) not null default 'IN',
  tax_id                  text,
  tax_label               text not null default 'GST',
  currency                char(3) not null default 'INR',
  timezone                text not null default 'Asia/Kolkata',
  logo_url                text,
  status                  text not null default 'active' check (status in ('active', 'suspended', 'archived')),
  subscription_plan       text not null default 'trial' check (subscription_plan in ('trial', 'starter', 'growth', 'enterprise')),
  subscription_status     text not null default 'trialing' check (subscription_status in ('trialing', 'active', 'past_due', 'cancelled')),
  trial_ends_at           timestamptz,
  current_period_ends_at  timestamptz,
  max_branches            int check (max_branches > 0),
  onboarding_completed_at timestamptz,
  onboarding_state        jsonb not null default '{}'::jsonb,
  created_at              timestamptz not null default now(),
  updated_at              timestamptz not null default now()
);

create table organization_settings (
  organization_id                     uuid primary key references organizations (id) on delete cascade,
  slot_interval_minutes               int not null default 15 check (slot_interval_minutes in (5, 10, 15, 20, 30, 60)),
  default_buffer_minutes              int not null default 0 check (default_buffer_minutes between 0 and 120),
  allow_outside_hours                 boolean not null default false,
  min_booking_notice_minutes          int not null default 0 check (min_booking_notice_minutes between 0 and 10080),
  max_advance_booking_days            int not null default 90 check (max_advance_booking_days between 1 and 730),
  reminder_offsets_minutes            int[] not null default '{1440,120}',
  quiet_hours_start                   time not null default '21:00',
  quiet_hours_end                     time not null default '09:00',
  prices_include_tax                  boolean not null default false,
  default_tax_rate_bp                 int not null default 1800 check (default_tax_rate_bp between 0 and 10000),
  round_off_to_minor                  int not null default 100 check (round_off_to_minor in (1, 5, 10, 50, 100)),
  credit_due_days                     int not null default 30 check (credit_due_days between 0 and 365),
  outstanding_reminder_enabled        boolean not null default true,
  outstanding_reminder_min_amount     bigint not null default 50000 check (outstanding_reminder_min_amount >= 0),
  outstanding_reminder_interval_days  int not null default 7 check (outstanding_reminder_interval_days between 1 and 90),
  outstanding_reminder_max_per_month  int not null default 4 check (outstanding_reminder_max_per_month between 1 and 31),
  staff_can_view_customer_phone       boolean not null default false,
  staff_can_view_own_performance      boolean not null default false,
  online_booking_enabled              boolean not null default false,
  invoice_prefix                      text not null default 'INV' check (invoice_prefix ~ '^[A-Z0-9]{1,6}$'),
  receipt_prefix                      text not null default 'RCT' check (receipt_prefix ~ '^[A-Z0-9]{1,6}$'),
  booking_prefix                      text not null default 'BK' check (booking_prefix ~ '^[A-Z0-9]{1,6}$'),
  receipt_footer                      text,
  updated_at                          timestamptz not null default now()
);

-- ───────────────────────────── Branches ─────────────────────────────
create table branches (
  id               uuid primary key default gen_random_uuid(),
  organization_id  uuid not null references organizations (id),
  code             citext not null check (code ~ '^[A-Za-z0-9]{2,10}$'),
  name             text not null check (length(btrim(name)) between 2 and 120),
  address_line1    text,
  address_line2    text,
  city             text,
  state            text,
  postal_code      text,
  phone            text,
  email            citext,
  manager_user_id  uuid,
  timezone         text not null,
  status           text not null default 'active' check (status in ('active', 'inactive', 'archived')),
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  unique (organization_id, code),
  unique (organization_id, id)
);

create table branch_hours (
  organization_id uuid not null,
  branch_id       uuid not null,
  weekday         smallint not null check (weekday between 1 and 7),
  is_closed       boolean not null default false,
  open_time       time,
  close_time      time,
  primary key (branch_id, weekday),
  foreign key (organization_id, branch_id) references branches (organization_id, id) on delete cascade,
  check (is_closed or (open_time is not null and close_time is not null and open_time < close_time))
);

create table holidays (
  id              uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations (id),
  branch_id       uuid,
  date            date not null,
  name            text not null,
  created_at      timestamptz not null default now(),
  foreign key (organization_id, branch_id) references branches (organization_id, id) on delete cascade
);
create unique index holidays_unique_day
  on holidays (organization_id, coalesce(branch_id, '00000000-0000-0000-0000-000000000000'::uuid), date);

-- ───────────────────────────── RBAC ─────────────────────────────
create table permissions (
  key         text primary key,
  module      text not null,
  label       text not null,
  description text
);

create table roles (
  id              uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations (id),
  key             citext not null check (key ~ '^[a-z][a-z0-9_]{1,40}$'),
  name            text not null,
  description     text,
  is_system       boolean not null default false,
  is_locked       boolean not null default false,
  home_screen     text not null default 'front_desk'
                  check (home_screen in ('owner_dashboard', 'branch_dashboard', 'front_desk', 'my_day')),
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  unique (organization_id, key),
  unique (organization_id, id)
);

create table role_permissions (
  organization_id uuid not null,
  role_id         uuid not null,
  permission_key  text not null references permissions (key) on delete cascade,
  primary key (role_id, permission_key),
  foreign key (organization_id, role_id) references roles (organization_id, id) on delete cascade
);

create table users (
  id                   uuid primary key default gen_random_uuid(),
  organization_id      uuid references organizations (id),
  role_id              uuid,
  email                citext,
  phone                text check (phone ~ '^\+[1-9][0-9]{6,14}$'),
  full_name            text not null check (length(btrim(full_name)) between 1 and 120),
  password_hash        text not null,
  is_platform_admin    boolean not null default false,
  all_branches         boolean not null default false,
  status               text not null default 'active' check (status in ('active', 'disabled')),
  must_change_password boolean not null default false,
  failed_login_count   int not null default 0,
  locked_until         timestamptz,
  last_login_at        timestamptz,
  password_changed_at  timestamptz,
  created_by           uuid,
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now(),
  check (is_platform_admin = (organization_id is null)),
  check (is_platform_admin or role_id is not null),
  check (email is not null or phone is not null),
  foreign key (organization_id, role_id) references roles (organization_id, id),
  unique (organization_id, id)
);
create unique index users_email_unique on users (email) where email is not null;
create unique index users_phone_unique on users (phone) where phone is not null;

alter table branches
  add constraint branches_manager_fk foreign key (organization_id, manager_user_id) references users (organization_id, id);

create table user_branches (
  organization_id uuid not null,
  user_id         uuid not null,
  branch_id       uuid not null,
  primary key (user_id, branch_id),
  foreign key (organization_id, user_id) references users (organization_id, id) on delete cascade,
  foreign key (organization_id, branch_id) references branches (organization_id, id) on delete cascade
);

create table refresh_tokens (
  id             uuid primary key default gen_random_uuid(),
  user_id        uuid not null references users (id) on delete cascade,
  family_id      uuid not null,
  token_hash     text not null unique,
  expires_at     timestamptz not null,
  revoked_at     timestamptz,
  revoked_reason text,
  replaced_by_id uuid,
  ip             inet,
  user_agent     text,
  created_at     timestamptz not null default now()
);
create index refresh_tokens_family on refresh_tokens (family_id);
create index refresh_tokens_user on refresh_tokens (user_id) where revoked_at is null;

-- ───────────────────────────── Shared infrastructure ─────────────────────────────
create table document_sequences (
  organization_id uuid not null references organizations (id),
  scope_key       text not null,
  doc_type        text not null,
  period_key      text not null,
  next_value      bigint not null default 1 check (next_value > 0),
  primary key (organization_id, scope_key, doc_type, period_key)
);

create table idempotency_keys (
  organization_id uuid not null references organizations (id),
  key             text not null check (length(key) between 8 and 100),
  user_id         uuid not null,
  method          text not null,
  path            text not null,
  request_hash    text not null,
  status_code     int,
  response_body   jsonb,
  created_at      timestamptz not null default now(),
  primary key (organization_id, key)
);
create index idempotency_keys_created on idempotency_keys (created_at);

create table audit_logs (
  id              bigint generated always as identity primary key,
  organization_id uuid references organizations (id),
  branch_id       uuid,
  user_id         uuid,
  action          text not null,
  entity_type     text not null,
  entity_id       text,
  summary         text,
  old_values      jsonb,
  new_values      jsonb,
  ip              inet,
  user_agent      text,
  request_id      text,
  created_at      timestamptz not null default now()
);
create index audit_logs_org_time on audit_logs (organization_id, created_at desc);
create index audit_logs_entity on audit_logs (organization_id, entity_type, entity_id);
create trigger audit_logs_append_only before update or delete on audit_logs
  for each row execute function prevent_modification();

create table organization_integrations (
  id                uuid primary key default gen_random_uuid(),
  organization_id   uuid not null references organizations (id),
  branch_id         uuid,
  kind              text not null check (kind in ('whatsapp', 'email', 'sms', 'biometric', 'payment_gateway')),
  provider          text not null,
  display_name      text not null,
  config            jsonb not null default '{}'::jsonb,
  secrets_encrypted text,
  webhook_secret    text,
  status            text not null default 'active' check (status in ('active', 'inactive', 'error')),
  last_sync_at      timestamptz,
  last_success_at   timestamptz,
  last_error        text,
  last_error_at     timestamptz,
  created_by        uuid,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  foreign key (organization_id, branch_id) references branches (organization_id, id),
  unique (organization_id, id)
);
create unique index org_integrations_active_channel
  on organization_integrations (organization_id, kind, coalesce(branch_id, '00000000-0000-0000-0000-000000000000'::uuid))
  where status <> 'inactive';

create table job_state (
  name             text primary key,
  last_started_at  timestamptz,
  last_finished_at timestamptz,
  last_status      text,
  last_error       text,
  run_count        bigint not null default 0
);
