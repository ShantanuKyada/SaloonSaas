-- 0013 The receptionist role is the front desk: bookings, walk-ins, customers, bills, payments and dues.
-- The branch's business dashboard (revenue trends, team revenue, best customers) and attendance records move to the
-- branch manager, who already has both. Only receptionist roles still exactly as first set up are changed: a role the
-- owner has edited keeps what the owner chose.

with original (permission_key) as (
  values ('dashboard.branch'), ('appointments.view'), ('appointments.create'), ('appointments.update'), ('appointments.status'),
         ('appointments.cancel'), ('walkins.manage'), ('customers.view'), ('customers.view_contact'), ('customers.create'),
         ('customers.update'), ('services.view'), ('staff.view'), ('attendance.view'), ('billing.view'), ('billing.create'),
         ('payments.collect'), ('ledger.view'), ('notifications.view')
),
untouched as (
  select r.id
    from roles r
   where r.key = 'receptionist'
     and (select count(*) from role_permissions rp where rp.role_id = r.id) = (select count(*) from original)
     and not exists (select 1 from role_permissions rp where rp.role_id = r.id and rp.permission_key not in (select permission_key from original))
)
delete from role_permissions
 where role_id in (select id from untouched)
   and permission_key in ('dashboard.branch', 'attendance.view');
