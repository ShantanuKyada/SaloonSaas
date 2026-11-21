-- 0012 Team members hear about their own bookings.
-- * staff_notifications: the in-app feed behind the bell (new booking, moved, cancelled, answers to their requests).
-- * A WhatsApp / SMS / email message to the team member for each new booking, through the usual outbox, using the new
--   "staff_new_booking" template. notifications.staff_id marks such messages; the salon can switch them off.

create table staff_notifications (
  id              uuid primary key default gen_random_uuid(),
  organization_id uuid not null,
  branch_id       uuid not null,
  staff_id        uuid not null,
  kind            text not null check (kind in ('booking_new', 'booking_moved', 'booking_removed', 'booking_cancelled', 'request_answered', 'leave_answered')),
  title           text not null check (length(title) between 1 and 200),
  body            text,
  link            text,
  appointment_id  uuid,
  read_at         timestamptz,
  created_at      timestamptz not null default now(),
  foreign key (organization_id, staff_id) references staff (organization_id, id),
  foreign key (organization_id, branch_id) references branches (organization_id, id),
  foreign key (organization_id, appointment_id) references appointments (organization_id, id),
  unique (organization_id, id)
);
create index staff_notifications_feed on staff_notifications (organization_id, staff_id, created_at desc);
create index staff_notifications_unread on staff_notifications (staff_id) where read_at is null;
select app_enable_tenant_rls('staff_notifications');

-- Messages to a team member (instead of a customer).
alter table notifications add column staff_id uuid;
alter table notifications add constraint notifications_staff_fk foreign key (organization_id, staff_id) references staff (organization_id, id);

alter table notification_templates drop constraint notification_templates_event_type_check;
alter table notification_templates add constraint notification_templates_event_type_check check (event_type in (
  'appointment_confirmation', 'appointment_reminder', 'appointment_cancellation', 'appointment_rescheduled',
  'payment_receipt', 'outstanding_reminder', 'offer', 'birthday', 're_engagement', 'staff_new_booking'));

alter table organization_settings add column notify_staff_of_bookings boolean not null default true;

-- Default texts for salons that already exist (new salons get them when they are created).
insert into notification_templates (organization_id, event_type, channel, name, subject, body)
select o.id, 'staff_new_booking', c.channel, 'New booking (team)', c.subject,
       'Hi {{staffName}}, new booking: {{customerName}} for {{services}} on {{date}} at {{time}} ({{branchName}}). Booking no: {{bookingNumber}}'
from organizations o
cross join (values ('whatsapp', null::text), ('sms', null::text), ('email', 'New booking — {{salonName}}')) as c (channel, subject)
on conflict (organization_id, event_type, channel) do nothing;
