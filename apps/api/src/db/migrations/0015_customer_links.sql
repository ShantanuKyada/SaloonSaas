-- 0015 Private links for customers.
-- Each link opens one booking (see it, move it, cancel it) and, while the salon has customer self-service on, that
-- customer's visits: what is coming up, what they had before, and "Book again". A link goes out with every booking
-- confirmation (desk or online) when the salon has a message channel, and the front desk can copy one to send by hand.
-- Only a hash of the link is kept; a link stops working 180 days after it was made. Links made before this migration
-- (appointments.manage_token_hash) keep working.

create table customer_links (
  id              uuid primary key default gen_random_uuid(),
  organization_id uuid not null,
  customer_id     uuid not null,
  appointment_id  uuid not null,
  token_hash      text not null unique,
  expires_at      timestamptz not null default now() + interval '180 days',
  last_used_at    timestamptz,
  created_at      timestamptz not null default now(),
  foreign key (organization_id, customer_id) references customers (organization_id, id),
  foreign key (organization_id, appointment_id) references appointments (organization_id, id),
  unique (organization_id, id)
);
create index customer_links_appointment on customer_links (organization_id, appointment_id);
select app_enable_tenant_rls('customer_links');

-- Booking messages now carry the customer's link. Salons that never changed the default texts get it added; edited
-- texts are left alone (the link is offered as {{manageLink}} in the template editor).
update notification_templates
set body = body || E'\nSee, change or book again: {{manageLink}}', updated_at = now()
where event_type = 'appointment_confirmation'
  and body = E'Hi {{customerName}}, your appointment at {{salonName}} ({{branchName}}) is confirmed.\nService: {{services}}\nDate: {{date}}\nTime: {{time}}\nWith: {{staff}}\nBooking no: {{bookingNumber}}';

update notification_templates
set body = body || E'\nSee or change it: {{manageLink}}', updated_at = now()
where event_type = 'appointment_rescheduled'
  and body = 'Hi {{customerName}}, your appointment at {{salonName}} ({{branchName}}) has moved to {{date}} at {{time}} with {{staff}}. Booking no: {{bookingNumber}}';
