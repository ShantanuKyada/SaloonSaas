-- 0003 Customers (CRM) and appointments (including walk-ins, see DECISIONS B2).

create table customers (
  id                   uuid primary key default gen_random_uuid(),
  organization_id      uuid not null references organizations (id),
  customer_code        citext not null,
  full_name            text not null check (length(btrim(full_name)) between 1 and 120),
  mobile               text check (mobile ~ '^\+[1-9][0-9]{6,14}$'),
  whatsapp_number      text check (whatsapp_number ~ '^\+[1-9][0-9]{6,14}$'),
  email                citext,
  gender               text not null default 'unspecified' check (gender in ('female', 'male', 'other', 'unspecified')),
  date_of_birth        date,
  anniversary_date     date,
  address              text,
  city                 text,
  preferred_branch_id  uuid,
  preferred_staff_id   uuid,
  registered_branch_id uuid,
  source               text not null default 'walk_in'
                       check (source in ('walk_in', 'phone', 'online', 'referral', 'social', 'import', 'other')),
  referred_by_id       uuid,
  notes                text,
  tags                 text[] not null default '{}',
  credit_limit         bigint check (credit_limit >= 0),
  marketing_consent    boolean not null default false,
  marketing_consent_at timestamptz,
  status               text not null default 'active' check (status in ('active', 'inactive', 'archived')),
  registered_at        timestamptz not null default now(),
  created_by           uuid references users (id),
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now(),
  foreign key (organization_id, preferred_branch_id) references branches (organization_id, id),
  foreign key (organization_id, registered_branch_id) references branches (organization_id, id),
  foreign key (organization_id, preferred_staff_id) references staff (organization_id, id),
  unique (organization_id, customer_code),
  unique (organization_id, id)
);
alter table customers
  add constraint customers_referred_by_fk foreign key (organization_id, referred_by_id) references customers (organization_id, id);
create unique index customers_mobile_unique on customers (organization_id, mobile)
  where mobile is not null and status <> 'archived';
create index customers_name_trgm on customers using gin (full_name gin_trgm_ops);
create index customers_mobile_trgm on customers using gin (mobile gin_trgm_ops);
create index customers_email on customers (organization_id, email) where email is not null;
create index customers_org_created on customers (organization_id, registered_at desc);
create index customers_dob_md on customers (organization_id, extract(month from date_of_birth), extract(day from date_of_birth))
  where date_of_birth is not null;

create table customer_notification_preferences (
  organization_id uuid not null,
  customer_id     uuid not null,
  channel         text not null check (channel in ('whatsapp', 'email', 'sms')),
  category        text not null check (category in ('appointment', 'reminder', 'offers', 'outstanding', 'receipt')),
  enabled         boolean not null,
  updated_at      timestamptz not null default now(),
  primary key (customer_id, channel, category),
  foreign key (organization_id, customer_id) references customers (organization_id, id) on delete cascade
);

create table consent_events (
  id              uuid primary key default gen_random_uuid(),
  organization_id uuid not null,
  customer_id     uuid not null,
  consent_type    text not null check (consent_type in ('marketing', 'whatsapp', 'email', 'sms', 'data_processing')),
  granted         boolean not null,
  source          text not null check (source in ('in_person', 'phone', 'online_form', 'import', 'customer_request', 'unsubscribe_link')),
  notes           text,
  recorded_by     uuid references users (id),
  recorded_at     timestamptz not null default now(),
  foreign key (organization_id, customer_id) references customers (organization_id, id)
);
create index consent_events_customer on consent_events (organization_id, customer_id, recorded_at desc);

-- Balance cache maintained by trigger on ledger_entries (never written by application code).
create table customer_accounts (
  customer_id     uuid primary key,
  organization_id uuid not null,
  balance         bigint not null default 0,
  total_debits    bigint not null default 0,
  total_credits   bigint not null default 0,
  last_entry_at   timestamptz,
  foreign key (organization_id, customer_id) references customers (organization_id, id)
);
create index customer_accounts_balance on customer_accounts (organization_id, balance desc) where balance <> 0;

-- CRM statistics, recomputed per customer inside the transaction that changes them, and nightly.
create table customer_stats (
  customer_id         uuid primary key,
  organization_id     uuid not null,
  visit_count         int not null default 0,
  lifetime_spend      bigint not null default 0,
  first_visit_at      timestamptz,
  last_visit_at       timestamptz,
  last_branch_id      uuid,
  favorite_service_id uuid,
  favorite_staff_id   uuid,
  cancelled_count     int not null default 0,
  no_show_count       int not null default 0,
  updated_at          timestamptz not null default now(),
  foreign key (organization_id, customer_id) references customers (organization_id, id)
);
create index customer_stats_last_visit on customer_stats (organization_id, last_visit_at);
create index customer_stats_spend on customer_stats (organization_id, lifetime_spend desc);

create table segments (
  id              uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations (id),
  name            text not null,
  description     text,
  filter          jsonb not null,
  created_by      uuid references users (id),
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  unique (organization_id, id)
);

-- ───────────────────────────── Appointments ─────────────────────────────
create table appointments (
  id                     uuid primary key default gen_random_uuid(),
  organization_id        uuid not null,
  branch_id              uuid not null,
  booking_number         text not null,
  customer_id            uuid not null,
  source                 text not null
                         check (source in ('phone', 'walk_in', 'in_person', 'online', 'whatsapp', 'social', 'other')),
  status                 text not null
                         check (status in ('waiting', 'scheduled', 'confirmed', 'checked_in', 'in_service',
                                           'completed', 'cancelled', 'no_show')),
  local_date             date not null,
  start_at               timestamptz,
  end_at                 timestamptz,
  queue_number           int,
  total_duration_minutes int not null default 0,
  estimated_amount       bigint not null default 0 check (estimated_amount >= 0),
  notes                  text,
  internal_notes         text,
  arrived_at             timestamptz,
  checked_in_at          timestamptz,
  service_started_at     timestamptz,
  completed_at           timestamptz,
  cancelled_at           timestamptz,
  cancelled_by           uuid references users (id),
  cancellation_reason    text,
  no_show_at             timestamptz,
  reschedule_count       int not null default 0,
  last_rescheduled_at    timestamptz,
  invoice_id             uuid,
  manage_token_hash      text,
  version                int not null default 1,
  created_by             uuid references users (id),
  updated_by             uuid references users (id),
  created_at             timestamptz not null default now(),
  updated_at             timestamptz not null default now(),
  foreign key (organization_id, branch_id) references branches (organization_id, id),
  foreign key (organization_id, customer_id) references customers (organization_id, id),
  check (status = 'waiting' or (start_at is not null and end_at is not null and end_at > start_at)),
  unique (organization_id, booking_number),
  unique (organization_id, id)
);
create index appointments_branch_time on appointments (organization_id, branch_id, start_at);
create index appointments_branch_day on appointments (organization_id, branch_id, local_date, status);
create index appointments_customer on appointments (organization_id, customer_id, start_at desc);
create unique index appointments_queue_number on appointments (branch_id, local_date, queue_number) where queue_number is not null;

create table appointment_items (
  id                       uuid primary key default gen_random_uuid(),
  organization_id          uuid not null,
  branch_id                uuid not null,
  appointment_id           uuid not null,
  service_id               uuid not null,
  staff_id                 uuid,
  sort_order               int not null default 0,
  start_at                 timestamptz,
  end_at                   timestamptz,
  blocked_until            timestamptz,
  duration_minutes         int not null check (duration_minutes between 5 and 720),
  buffer_minutes           int not null default 0 check (buffer_minutes between 0 and 120),
  price                    bigint not null check (price >= 0),
  customer_package_item_id uuid,
  status                   text not null default 'pending'
                           check (status in ('pending', 'in_service', 'completed', 'cancelled')),
  blocks_schedule          boolean not null default false,
  created_at               timestamptz not null default now(),
  updated_at               timestamptz not null default now(),
  foreign key (organization_id, appointment_id) references appointments (organization_id, id),
  foreign key (organization_id, service_id) references services (organization_id, id),
  foreign key (organization_id, staff_id) references staff (organization_id, id),
  foreign key (organization_id, branch_id) references branches (organization_id, id),
  check (end_at is null or start_at is null or end_at > start_at),
  check (blocked_until is null or end_at is null or blocked_until >= end_at),
  check (not blocks_schedule or (staff_id is not null and start_at is not null and end_at is not null and blocked_until is not null)),
  -- The database-level guarantee against double booking (see ARCHITECTURE §6).
  constraint appointment_items_no_staff_overlap exclude using gist (
    staff_id with =, tstzrange(start_at, blocked_until, '[)') with &&
  ) where (blocks_schedule),
  unique (organization_id, id)
);
create index appointment_items_appointment on appointment_items (appointment_id, sort_order);
create index appointment_items_staff_time on appointment_items (organization_id, staff_id, start_at) where blocks_schedule;
create index appointment_items_branch_time on appointment_items (organization_id, branch_id, start_at);

create table appointment_events (
  id              bigint generated always as identity primary key,
  organization_id uuid not null,
  appointment_id  uuid not null,
  event_type      text not null check (event_type in ('created', 'status_changed', 'rescheduled', 'staff_changed',
                                                      'services_changed', 'restored', 'billed', 'note')),
  from_status     text,
  to_status       text,
  data            jsonb,
  actor_user_id   uuid references users (id),
  created_at      timestamptz not null default now(),
  foreign key (organization_id, appointment_id) references appointments (organization_id, id)
);
create index appointment_events_appointment on appointment_events (appointment_id, id);
create index appointment_events_org_type on appointment_events (organization_id, event_type, created_at);
create trigger appointment_events_append_only before update or delete on appointment_events
  for each row execute function prevent_modification();
