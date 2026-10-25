-- 0006 A salon has one active connection per messaging channel per scope (one WhatsApp number, one SMTP account),
-- but may connect several attendance devices or vendors to the same branch.

drop index if exists org_integrations_active_channel;

create unique index org_integrations_active_channel
  on organization_integrations (organization_id, kind, coalesce(branch_id, '00000000-0000-0000-0000-000000000000'::uuid))
  where status <> 'inactive' and kind <> 'biometric';
