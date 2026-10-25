-- 0002 Service catalogue, expertise, staff, schedules, leave.

create table expertise (
  id              uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations (id),
  name            text not null check (length(btrim(name)) between 2 and 80),
  description     text,
  status          text not null default 'active' check (status in ('active', 'archived')),
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  unique (organization_id, id)
);
create unique index expertise_name_unique on expertise (organization_id, lower(name)) where status <> 'archived';

create table service_categories (
  id              uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations (id),
  name            text not null check (length(btrim(name)) between 2 and 80),
  description     text,
  color           text not null default '#8b5cf6' check (color ~ '^#[0-9a-fA-F]{6}$'),
  sort_order      int not null default 0,
  status          text not null default 'active' check (status in ('active', 'archived')),
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  unique (organization_id, id)
);
create unique index service_categories_name_unique on service_categories (organization_id, lower(name)) where status <> 'archived';

create table services (
  id               uuid primary key default gen_random_uuid(),
  organization_id  uuid not null references organizations (id),
  category_id      uuid not null,
  code             citext not null check (code ~ '^[A-Za-z0-9-]{2,20}$'),
  name             text not null check (length(btrim(name)) between 2 and 120),
  description      text,
  duration_minutes int not null check (duration_minutes between 5 and 720),
  buffer_minutes   int not null default 0 check (buffer_minutes between 0 and 120),
  price            bigint not null check (price >= 0),
  tax_rate_bp      int check (tax_rate_bp between 0 and 10000),
  gender           text not null default 'unisex' check (gender in ('unisex', 'female', 'male')),
  all_branches     boolean not null default true,
  online_bookable  boolean not null default true,
  sort_order       int not null default 0,
  status           text not null default 'active' check (status in ('active', 'inactive', 'archived')),
  created_by       uuid references users (id),
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  foreign key (organization_id, category_id) references service_categories (organization_id, id),
  unique (organization_id, code),
  unique (organization_id, id)
);
create index services_category on services (organization_id, category_id);
create index services_name_trgm on services using gin (name gin_trgm_ops);

create table service_branches (
  organization_id uuid not null,
  service_id      uuid not null,
  branch_id       uuid not null,
  price_override  bigint check (price_override >= 0),
  primary key (service_id, branch_id),
  foreign key (organization_id, service_id) references services (organization_id, id) on delete cascade,
  foreign key (organization_id, branch_id) references branches (organization_id, id) on delete cascade
);

create table service_expertise (
  organization_id uuid not null,
  service_id      uuid not null,
  expertise_id    uuid not null,
  primary key (service_id, expertise_id),
  foreign key (organization_id, service_id) references services (organization_id, id) on delete cascade,
  foreign key (organization_id, expertise_id) references expertise (organization_id, id) on delete cascade
);

-- ───────────────────────────── Staff ─────────────────────────────
create table staff (
  id                 uuid primary key default gen_random_uuid(),
  organization_id    uuid not null references organizations (id),
  branch_id          uuid not null,
  user_id            uuid unique,
  employee_code      citext not null check (employee_code ~ '^[A-Za-z0-9-]{2,20}$'),
  full_name          text not null check (length(btrim(full_name)) between 2 and 120),
  display_name       text not null check (length(btrim(display_name)) between 1 and 40),
  gender             text not null default 'unspecified' check (gender in ('female', 'male', 'other', 'unspecified')),
  date_of_birth      date,
  mobile             text check (mobile ~ '^\+[1-9][0-9]{6,14}$'),
  email              citext,
  address            text,
  joining_date       date,
  exit_date          date,
  designation        text,
  employment_type    text not null default 'full_time'
                     check (employment_type in ('full_time', 'part_time', 'contract', 'freelance')),
  employment_status  text not null default 'active'
                     check (employment_status in ('active', 'on_notice', 'inactive', 'terminated')),
  biometric_punch_id text,
  photo_url          text,
  calendar_color     text not null default '#6366f1' check (calendar_color ~ '^#[0-9a-fA-F]{6}$'),
  calendar_order     int not null default 0,
  is_bookable        boolean not null default true,
  online_bookable    boolean not null default true,
  commission_type    text not null default 'none' check (commission_type in ('none', 'percentage', 'flat')),
  commission_value   bigint not null default 0 check (commission_value >= 0),
  notes              text,
  created_by         uuid references users (id),
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),
  foreign key (organization_id, branch_id) references branches (organization_id, id),
  foreign key (organization_id, user_id) references users (organization_id, id),
  check (commission_type <> 'percentage' or commission_value <= 10000),
  check (exit_date is null or joining_date is null or exit_date >= joining_date),
  unique (organization_id, employee_code),
  unique (organization_id, id)
);
create unique index staff_punch_id_unique on staff (organization_id, biometric_punch_id) where biometric_punch_id is not null;
create index staff_branch on staff (organization_id, branch_id, employment_status);
create index staff_name_trgm on staff using gin (full_name gin_trgm_ops);

create table staff_expertise (
  organization_id uuid not null,
  staff_id        uuid not null,
  expertise_id    uuid not null,
  primary key (staff_id, expertise_id),
  foreign key (organization_id, staff_id) references staff (organization_id, id) on delete cascade,
  foreign key (organization_id, expertise_id) references expertise (organization_id, id) on delete cascade
);

create table staff_services (
  organization_id  uuid not null,
  staff_id         uuid not null,
  service_id       uuid not null,
  duration_minutes int check (duration_minutes between 5 and 720),
  price_override   bigint check (price_override >= 0),
  commission_type  text check (commission_type in ('none', 'percentage', 'flat')),
  commission_value bigint check (commission_value >= 0),
  is_active        boolean not null default true,
  created_at       timestamptz not null default now(),
  primary key (staff_id, service_id),
  foreign key (organization_id, staff_id) references staff (organization_id, id) on delete cascade,
  foreign key (organization_id, service_id) references services (organization_id, id) on delete cascade
);
create index staff_services_service on staff_services (organization_id, service_id) where is_active;

create table staff_shifts (
  id              uuid primary key default gen_random_uuid(),
  organization_id uuid not null,
  staff_id        uuid not null,
  weekday         smallint not null check (weekday between 1 and 7),
  start_time      time not null,
  end_time        time not null,
  check (start_time < end_time),
  foreign key (organization_id, staff_id) references staff (organization_id, id) on delete cascade,
  constraint staff_shifts_no_overlap exclude using gist (
    staff_id with =, weekday with =, timerange(start_time, end_time, '[)') with &&
  )
);

create table staff_breaks (
  id              uuid primary key default gen_random_uuid(),
  organization_id uuid not null,
  staff_id        uuid not null,
  weekday         smallint not null check (weekday between 1 and 7),
  start_time      time not null,
  end_time        time not null,
  label           text not null default 'Break',
  check (start_time < end_time),
  foreign key (organization_id, staff_id) references staff (organization_id, id) on delete cascade,
  constraint staff_breaks_no_overlap exclude using gist (
    staff_id with =, weekday with =, timerange(start_time, end_time, '[)') with &&
  )
);

create table staff_schedule_overrides (
  id              uuid primary key default gen_random_uuid(),
  organization_id uuid not null,
  staff_id        uuid not null,
  date            date not null,
  is_working      boolean not null,
  start_time      time,
  end_time        time,
  reason          text,
  created_by      uuid references users (id),
  created_at      timestamptz not null default now(),
  foreign key (organization_id, staff_id) references staff (organization_id, id) on delete cascade,
  check (not is_working or (start_time is not null and end_time is not null and start_time < end_time)),
  unique (staff_id, date)
);

create table staff_leaves (
  id              uuid primary key default gen_random_uuid(),
  organization_id uuid not null,
  staff_id        uuid not null,
  leave_type      text not null default 'casual' check (leave_type in ('casual', 'sick', 'earned', 'unpaid', 'other')),
  start_date      date not null,
  end_date        date not null,
  half_day        text not null default 'none' check (half_day in ('none', 'first_half', 'second_half')),
  status          text not null default 'approved' check (status in ('pending', 'approved', 'rejected', 'cancelled')),
  reason          text,
  decided_by      uuid references users (id),
  decided_at      timestamptz,
  created_by      uuid references users (id),
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  foreign key (organization_id, staff_id) references staff (organization_id, id),
  check (end_date >= start_date),
  check (half_day = 'none' or start_date = end_date),
  unique (organization_id, id)
);
create index staff_leaves_range on staff_leaves (organization_id, staff_id, start_date, end_date) where status = 'approved';

create table staff_time_blocks (
  id              uuid primary key default gen_random_uuid(),
  organization_id uuid not null,
  branch_id       uuid not null,
  staff_id        uuid not null,
  start_at        timestamptz not null,
  end_at          timestamptz not null,
  reason          text not null,
  created_by      uuid references users (id),
  created_at      timestamptz not null default now(),
  foreign key (organization_id, staff_id) references staff (organization_id, id),
  foreign key (organization_id, branch_id) references branches (organization_id, id),
  check (end_at > start_at),
  constraint staff_time_blocks_no_overlap exclude using gist (
    staff_id with =, tstzrange(start_at, end_at, '[)') with &&
  )
);
create index staff_time_blocks_time on staff_time_blocks (organization_id, branch_id, start_at);
