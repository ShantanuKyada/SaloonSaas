-- 0016 Repeating appointments.
-- A series is a booking repeated every few weeks: the same services at the same time of day, with the same person when
-- they are free (otherwise someone else qualified who is free then; times nobody can do are skipped and reported).
-- Made at the front desk or by the customer from their private link. Each visit stays an ordinary appointment that can
-- be moved or cancelled on its own; series_id ties them together for "this and the later ones".

create table appointment_series (
  id              uuid primary key default gen_random_uuid(),
  organization_id uuid not null,
  branch_id       uuid not null,
  customer_id     uuid not null,
  every_weeks     int not null check (every_weeks between 1 and 12),
  occurrences     int not null check (occurrences between 2 and 26),
  created_via     text not null check (created_via in ('desk', 'customer')),
  created_by      uuid references users (id),
  created_at      timestamptz not null default now(),
  foreign key (organization_id, branch_id) references branches (organization_id, id),
  foreign key (organization_id, customer_id) references customers (organization_id, id),
  unique (organization_id, id)
);
select app_enable_tenant_rls('appointment_series');

alter table appointments add column series_id uuid;
alter table appointments add constraint appointments_series_fk foreign key (organization_id, series_id) references appointment_series (organization_id, id);
create index appointments_series on appointments (organization_id, series_id) where series_id is not null;
