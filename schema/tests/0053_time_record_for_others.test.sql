-- Tests for 0053_time_record_for_others. Run as deployment role AFTER the
-- full chain. The capability exists with the right flags and the shipped
-- grants are exactly administrator + accounts. The operation-level refusal
-- and the record-for path are pinned in the application suite
-- (billing-capture.test).

begin;

do $$
declare
  n int;
begin
  -- T1 the capability exists, grantable to firm roles, not money-authorising
  select count(*) into n from deedbox.capability
   where key = 'time.record_for_others' and grantable_to_firm_roles
     and not money_authorisation and not admin_floor and not external_role_permitted;
  if n <> 1 then
    raise exception 'T1 FAILED: time.record_for_others missing or mis-flagged (%)', n;
  end if;

  -- T2 shipped grants: administrator and accounts hold it
  select count(*) into n from deedbox.role_capability rc
    join deedbox.role r on r.id = rc.role
   where rc.capability = 'time.record_for_others'
     and r.system_key in ('administrator', 'accounts');
  if n <> 2 then
    raise exception 'T2 FAILED: expected administrator + accounts grants, found %', n;
  end if;

  -- T3 no other shipped role holds it
  select count(*) into n from deedbox.role_capability rc
    join deedbox.role r on r.id = rc.role
   where rc.capability = 'time.record_for_others'
     and r.system_key in ('lawyer', 'support_staff', 'portal_client');
  if n <> 0 then
    raise exception 'T3 FAILED: % unexpected shipped grant(s) to a non-privileged role', n;
  end if;
end $$;

rollback;
