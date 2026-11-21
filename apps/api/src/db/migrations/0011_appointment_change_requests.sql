-- 0011 Team members ask to move one of their own appointments; the front desk approves (the booking moves and the
-- customer gets the usual "rescheduled" message) or declines. One waiting request per appointment.

create table appointment_change_requests (
  id                uuid primary key default gen_random_uuid(),
  organization_id   uuid not null,
  branch_id         uuid not null,
  appointment_id    uuid not null,
  -- The team member asking; their first service in the booking moves to the proposed time, the rest follow.
  staff_id          uuid not null,
  requested_by      uuid not null references users (id),
  -- When the booking started at the time of the request: if it has moved since, the request is out of date.
  current_start_at  timestamptz not null,
  proposed_start_at timestamptz not null,
  reason            text,
  status            text not null default 'pending' check (status in ('pending', 'approved', 'declined', 'cancelled')),
  decided_by        uuid references users (id),
  decided_at        timestamptz,
  decision_note     text,
  created_at        timestamptz not null default now(),
  foreign key (organization_id, appointment_id) references appointments (organization_id, id),
  foreign key (organization_id, staff_id) references staff (organization_id, id),
  foreign key (organization_id, branch_id) references branches (organization_id, id),
  check (proposed_start_at <> current_start_at),
  unique (organization_id, id)
);

create unique index appointment_change_requests_one_waiting on appointment_change_requests (appointment_id) where status = 'pending';
create index appointment_change_requests_branch on appointment_change_requests (organization_id, branch_id, status, created_at);
create index appointment_change_requests_staff on appointment_change_requests (organization_id, staff_id, created_at);

select app_enable_tenant_rls('appointment_change_requests');
