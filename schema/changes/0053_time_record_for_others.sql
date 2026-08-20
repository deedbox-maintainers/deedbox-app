-- 0053: recording time for another fee earner is a granted permission, not a
-- free act. The capture operation has always accepted a staff input (imports
-- and the screens use it); nothing gated it. The gate is now explicit — a
-- staff member records their own time freely, and records another's only
-- under time.record_for_others. Shipped to administrator and accounts, the
-- roles that entered others' time in practice; a firm may grant it to other
-- roles (e.g. support staff who enter the lawyers' time) through role
-- administration.

begin;

insert into deedbox.capability (key, description, grantable_to_firm_roles) values
  ('time.record_for_others',
   'Record time entries on behalf of another staff member.',
   true);

insert into deedbox.role_capability (role, capability)
  select id, 'time.record_for_others' from deedbox.role
   where system_key in ('administrator', 'accounts');

commit;
