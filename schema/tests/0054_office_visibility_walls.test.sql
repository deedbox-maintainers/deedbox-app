-- Tests for 0054_office_visibility_walls. Run as deployment role AFTER the
-- full chain. The capability ships to administrator + accounts; under the
-- 'office' scope a non-holder is walled to their office, a holder sees
-- firm-wide, a block defeats the capability, and a restricted matter still
-- demands its grant. App-layer coverage rides matters.test.

begin;

do $$
declare
  n int;
  v_pack bigint; v_firm bigint; v_off_a bigint; v_off_b bigint;
  v_role_admin bigint; v_role_lawyer bigint;
  v_admin bigint; v_lawyer bigint;
  v_client bigint; v_area bigint; v_m_a bigint; v_m_b bigint;
begin
  -- T1 capability exists with the right flags
  select count(*) into n from deedbox.capability
   where key = 'matter.see_all_offices' and grantable_to_firm_roles
     and not money_authorisation and not admin_floor and not external_role_permitted;
  if n <> 1 then raise exception 'T1 FAILED: capability missing or mis-flagged (%)', n; end if;

  -- T2 shipped grants: administrator + accounts and nobody else
  select count(*) into n from deedbox.role_capability rc
    join deedbox.role r on r.id = rc.role
   where rc.capability = 'matter.see_all_offices'
     and r.system_key in ('administrator','accounts');
  if n <> 2 then raise exception 'T2 FAILED: expected administrator + accounts, found %', n; end if;
  select count(*) into n from deedbox.role_capability rc
    join deedbox.role r on r.id = rc.role
   where rc.capability = 'matter.see_all_offices'
     and r.system_key in ('lawyer','support_staff','portal_client');
  if n <> 0 then raise exception 'T3 FAILED: % unexpected shipped grants', n; end if;

  -- world: one firm, two offices, an administrator in A, a lawyer in B,
  -- one unrestricted matter in each office
  insert into deedbox.country_pack (code, name) values ('x54', 'Wall Test Pack') returning id into v_pack;
  insert into deedbox.firm (name, operating_currency, timezone, country_pack)
    values ('Wall Test Firm', 'AUD', 'Australia/Sydney', v_pack) returning id into v_firm;
  insert into deedbox.office (name, code) values ('Wall Office A', 'W54A') returning id into v_off_a;
  insert into deedbox.office (name, code) values ('Wall Office B', 'W54B') returning id into v_off_b;
  select id into v_role_admin from deedbox.role where system_key = 'administrator';
  select id into v_role_lawyer from deedbox.role where system_key = 'lawyer';
  insert into deedbox.staff_member (person_name, login, role, office, email)
    values ('{"given":"Ada","family":"Admin"}', 'ada.w54', v_role_admin, v_off_a, 'ada.w54@example.test')
    returning id into v_admin;
  insert into deedbox.staff_member (person_name, login, role, office, email)
    values ('{"given":"Lee","family":"Lawyer"}', 'lee.w54', v_role_lawyer, v_off_b, 'lee.w54@example.test')
    returning id into v_lawyer;
  insert into deedbox.party (kind, display_name) values ('person', 'Wall Client 54') returning id into v_client;
  insert into deedbox.party_name (party, name_kind, full_name) values (v_client, 'current', 'Wall Client 54');
  -- practice areas are firm data — a fresh chain ships none, so the world
  -- builds its own (a borrowed row here once nulled the matters silently)
  insert into deedbox.practice_area (name) values ('Wall Area 54') returning id into v_area;
  insert into deedbox.matter (matter_number, title, status, office, practice_area, responsible_lawyer, client_party, opened_date)
    values ('W54-A', 'Wall matter A', 'open', v_off_a, v_area, v_admin, v_client, current_date)
    returning id into v_m_a;
  insert into deedbox.matter (matter_number, title, status, office, practice_area, responsible_lawyer, client_party, opened_date)
    values ('W54-B', 'Wall matter B', 'open', v_off_b, v_area, v_lawyer, v_client, current_date)
    returning id into v_m_b;

  -- office scope in force (a setting row effective in the past)
  insert into deedbox.firm_setting (definition, value, effective_from)
    select sd.id, '"office"'::jsonb, now() - interval '1 hour'
      from deedbox.setting_definition sd where sd.key = 'visibility.staff_scope';

  -- T4 the lawyer sees their own office's matter and NOT the other office's
  if not deedbox.matter_visible('staff', v_lawyer, v_m_b) then
    raise exception 'T4 FAILED: lawyer walled off their own office matter';
  end if;
  if deedbox.matter_visible('staff', v_lawyer, v_m_a) then
    raise exception 'T4 FAILED: lawyer sees another office''s matter under office scope';
  end if;

  -- T5 the administrator (capability holder) sees both offices
  if not (deedbox.matter_visible('staff', v_admin, v_m_a)
      and deedbox.matter_visible('staff', v_admin, v_m_b)) then
    raise exception 'T5 FAILED: see_all_offices holder walled under office scope';
  end if;

  -- T6 a block defeats the capability
  insert into deedbox.matter_restriction_block (matter, staff)
    values (v_m_b, v_admin);
  if deedbox.matter_visible('staff', v_admin, v_m_b) then
    raise exception 'T6 FAILED: a block did not defeat see_all_offices';
  end if;

  -- T7 a restricted matter still demands its grant, capability or not:
  -- restrict matter A to a second administrator (a valid guardian), leaving
  -- our first administrator ungranted — the capability must not reach past
  declare
    v_guardian bigint;
  begin
    insert into deedbox.staff_member (person_name, login, role, office, email)
      values ('{"given":"Gia","family":"Guardian"}', 'gia.w54', v_role_admin, v_off_b, 'gia.w54@example.test')
      returning id into v_guardian;
    insert into deedbox.matter_restriction_grant (matter, grantee_kind, grantee)
      values (v_m_a, 'staff', v_guardian);
    if deedbox.matter_visible('staff', v_admin, v_m_a) then
      raise exception 'T7 FAILED: see_all_offices reached past a restriction';
    end if;
    if not deedbox.matter_visible('staff', v_guardian, v_m_a) then
      raise exception 'T7 FAILED: the named guardian cannot see the restricted matter';
    end if;
  end;
end $$;

rollback;
