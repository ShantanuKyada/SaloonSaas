-- 0005 Notification templates/outbox, campaigns, attendance, then RLS + updated_at triggers for every tenant table.

create table notification_templates (
  id                     uuid primary key default gen_random_uuid(),
  organization_id        uuid not null references organizations (id),
  event_type             text not null check (event_type in (
                           'appointment_confirmation', 'appointment_reminder', 'appointment_cancellation',
                           'appointment_rescheduled', 'payment_receipt', 'outstanding_reminder', 'offer',
                           'birthday', 're_engagement')),
  channel                text not null check (channel in ('whatsapp', 'email', 'sms')),
  name                   text not null,
  subject                text,
  body                   text not null check (length(body) between 1 and 4000),
  provider_template_name text,
  is_active              boolean not null default true,
  created_at             timestamptz not null default now(),
  updated_at             timestamptz not null default now(),
  unique (organization_id, event_type, channel),
  unique (organization_id, id)
);

create table campaigns (
  id               uuid primary key default gen_random_uuid(),
  organization_id  uuid not null references organizations (id),
  name             text not null,
  event_type       text not null default 'offer' check (event_type in ('offer', 're_engagement', 'birthday')),
  channel          text not null check (channel in ('whatsapp', 'email', 'sms')),
  segment_filter   jsonb not null,
  subject          text,
  body             text not null check (length(body) between 1 and 4000),
  status           text not null default 'draft' check (status in ('draft', 'scheduled', 'sending', 'completed', 'cancelled')),
  scheduled_at     timestamptz,
  recipients_count int not null default 0,
  created_by       uuid references users (id),
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  unique (organization_id, id)
);

-- Outbox + delivery log. The worker claims rows with FOR UPDATE SKIP LOCKED.
create table notifications (
  id                  uuid primary key default gen_random_uuid(),
  organization_id     uuid not null,
  branch_id           uuid,
  customer_id         uuid,
  campaign_id         uuid,
  event_type          text not null,
  category            text not null check (category in ('appointment', 'reminder', 'offers', 'outstanding', 'receipt')),
  channel             text not null check (channel in ('whatsapp', 'email', 'sms')),
  recipient           text not null,
  subject             text,
  body                text not null,
  template_id         uuid,
  template_variables  jsonb not null default '{}'::jsonb,
  source_type         text,
  source_id           uuid,
  dedupe_key          text not null,
  status              text not null default 'queued'
                      check (status in ('queued', 'processing', 'sent', 'delivered', 'read', 'failed', 'cancelled', 'skipped')),
  status_reason       text,
  scheduled_for       timestamptz not null default now(),
  attempts            int not null default 0,
  max_attempts        int not null default 5,
  next_attempt_at     timestamptz not null default now(),
  locked_until        timestamptz,
  last_error          text,
  provider            text,
  provider_message_id text,
  sent_at             timestamptz,
  delivered_at        timestamptz,
  read_at             timestamptz,
  failed_at           timestamptz,
  created_by          uuid references users (id),
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),
  foreign key (organization_id, branch_id) references branches (organization_id, id),
  foreign key (organization_id, customer_id) references customers (organization_id, id),
  foreign key (organization_id, campaign_id) references campaigns (organization_id, id),
  unique (organization_id, dedupe_key)
);
create index notifications_due on notifications (next_attempt_at) where status = 'queued';
create index notifications_stuck on notifications (locked_until) where status = 'processing';
create index notifications_org_time on notifications (organization_id, created_at desc);
create index notifications_customer on notifications (organization_id, customer_id, created_at desc);
create index notifications_source on notifications (organization_id, source_type, source_id);
create index notifications_provider_msg on notifications (provider, provider_message_id) where provider_message_id is not null;

-- ───────────────────────────── Attendance ─────────────────────────────
create table attendance_punches (
  id              uuid primary key default gen_random_uuid(),
  organization_id uuid not null,
  branch_id       uuid,
  integration_id  uuid,
  staff_id        uuid,
  punch_id        text not null,
  punched_at      timestamptz not null,
  direction       text not null default 'unknown' check (direction in ('in', 'out', 'unknown')),
  source          text not null check (source in ('biometric_pull', 'biometric_push', 'manual', 'import')),
  external_id     text not null,
  raw             jsonb,
  created_by      uuid references users (id),
  created_at      timestamptz not null default now(),
  foreign key (organization_id, branch_id) references branches (organization_id, id),
  foreign key (organization_id, staff_id) references staff (organization_id, id),
  foreign key (organization_id, integration_id) references organization_integrations (organization_id, id),
  unique (organization_id, source, external_id)
);
create index attendance_punches_staff_time on attendance_punches (organization_id, staff_id, punched_at);
create index attendance_punches_unmapped on attendance_punches (organization_id, punch_id) where staff_id is null;

create table attendance_days (
  id                 uuid primary key default gen_random_uuid(),
  organization_id    uuid not null,
  branch_id          uuid not null,
  staff_id           uuid not null,
  date               date not null,
  status             text not null check (status in ('present', 'late', 'absent', 'half_day', 'on_leave',
                                                     'weekly_off', 'holiday', 'missing_punch', 'not_started')),
  scheduled_start    timestamptz,
  scheduled_end      timestamptz,
  first_in           timestamptz,
  last_out           timestamptz,
  worked_minutes     int not null default 0,
  late_minutes       int not null default 0,
  is_manual_override boolean not null default false,
  override_reason    text,
  overridden_by      uuid references users (id),
  computed_at        timestamptz not null default now(),
  foreign key (organization_id, branch_id) references branches (organization_id, id),
  foreign key (organization_id, staff_id) references staff (organization_id, id),
  unique (staff_id, date)
);
create index attendance_days_branch_date on attendance_days (organization_id, branch_id, date);

-- ───────────────────────────── Row-level security ─────────────────────────────
alter table organizations enable row level security;
create policy tenant_isolation on organizations
  using ((select app_is_platform()) or id = (select app_org_id()))
  with check ((select app_is_platform()) or id = (select app_org_id()));

do $$
declare r record;
begin
  for r in
    select c.table_name
      from information_schema.columns c
      join information_schema.tables t on t.table_name = c.table_name and t.table_schema = c.table_schema
     where c.table_schema = 'public' and c.column_name = 'organization_id' and t.table_type = 'BASE TABLE'
  loop
    perform app_enable_tenant_rls(r.table_name::regclass);
  end loop;

  for r in
    select c.table_name
      from information_schema.columns c
      join information_schema.tables t on t.table_name = c.table_name and t.table_schema = c.table_schema
     where c.table_schema = 'public' and c.column_name = 'updated_at' and t.table_type = 'BASE TABLE'
  loop
    execute format('create trigger %I before update on %I for each row execute function set_updated_at()',
                   r.table_name || '_set_updated_at', r.table_name);
  end loop;
end $$;
