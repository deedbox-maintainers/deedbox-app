-- Tests for 0005_visibility_predicate. Run as deployment role AFTER 0001–0005.

begin;

insert into deedbox.country_pack (code, name) values ('AU-NSW','Australia (NSW)');
insert into deedbox.pack_version (pack, version) select id, '0.0.1' from deedbox.country_pack;
update deedbox.country_pack cp set active_version = pv.id from deedbox.pack_version pv where pv.pack = cp.id;
insert into deedbox.firm (name, operating_currency, timezone, country_pack)
  select 'Test Firm','AUD','Australia/Sydney', id from deedbox.country_pack;
insert into deedbox.office (name, code) values ('Sydney','SYD');
insert into deedbox.office (name, code) values ('Newcastle','NEW');

do $$
declare o1 bigint; o2 bigint; r_admin bigint; r_lawyer bigint; r_support bigint;
        s_admin bigint; s_law bigint; s_sup bigint; p1 bigint; p2 bigint; pa bigint;
        m1 bigint; m2 bigint; n bigint; cap bigint;
begin
  select id into o1 from deedbox.office where code='SYD';
  select id into o2 from deedbox.office where code='NEW';
  select id into r_admin from deedbox.role where system_key='administrator';
  select id into r_lawyer from deedbox.role where system_key='lawyer';
  select id into r_support from deedbox.role where system_key='support_staff';
  insert into deedbox.staff_member (person_name, login, role, office, email)
    values ('{"display":"Ada"}','ada', r_admin, o1, 'ada@x.test') returning id into s_admin;
  insert into deedbox.staff_member (person_name, login, role, office, email)
    values ('{"display":"Lee"}','lee', r_lawyer, o1, 'lee@x.test') returning id into s_law;
  insert into deedbox.staff_member (person_name, login, role, office, email)
    values ('{"display":"Sam"}','sam', r_support, o2, 'sam@x.test') returning id into s_sup;
  insert into deedbox.party (kind, display_name) values ('person','Client One') returning id into p1;
  insert into deedbox.party (kind, display_name) values ('person','Client Two') returning id into p2;
  insert into deedbox.practice_area (name) values ('Litigation') returning id into pa;
  insert into deedbox.matter (matter_number, title, client_party, responsible_lawyer, office, practice_area)
    values ('M-1','Open matter', p1, s_law, o1, pa) returning id into m1;
  insert into deedbox.matter (matter_number, title, client_party, responsible_lawyer, office, practice_area)
    values ('M-2','Second matter', p2, s_law, o2, pa) returning id into m2;
  -- since 0006 the client matter-party row is auto-created with the matter;
  -- the portal flag is set on those rows, not inserted fresh.
  select ci.id into cap from deedbox.choice_item ci join deedbox.choice_list cl on cl.id=ci.list
   where cl.purpose_key='matter_party_capacities' and ci.shipped_key='client';
  update deedbox.matter_party set portal_access = true
   where matter = m1 and party = p1 and capacity = cap and deleted_at is null;

  -- 1. Default policy (all_staff): every active staff member sees unrestricted matters.
  if not deedbox.matter_visible('staff', s_sup, m1) then
    raise exception 'all_staff scope failed';
  end if;

  -- 2. A block defeats everything, on an UNRESTRICTED matter, including an administrator.
  insert into deedbox.matter_restriction_block (matter, staff) values (m1, s_admin);
  if deedbox.matter_visible('staff', s_admin, m1) then
    raise exception 'blocked administrator still sees the matter';
  end if;
  if not deedbox.matter_visible('staff', s_law, m1) then
    raise exception 'a block on one person changed another''s view';
  end if;
  delete from deedbox.matter_restriction_block where matter = m1;

  -- 3. Restriction: absent without a grant — administrator status does not help.
  insert into deedbox.matter_restriction_grant (matter, grantee_kind, grantee) values (m1,'staff',s_admin);
  if deedbox.matter_visible('staff', s_law, m1) then
    raise exception 'ungranted staff sees a restricted matter';
  end if;
  if not deedbox.matter_visible('staff', s_admin, m1) then
    raise exception 'the granted guardian cannot see the restricted matter';
  end if;

  -- 4. Role grants admit the role's members.
  insert into deedbox.matter_restriction_grant (matter, grantee_kind, grantee) values (m1,'role',r_lawyer);
  if not deedbox.matter_visible('staff', s_law, m1) then
    raise exception 'role grant did not admit the role member';
  end if;

  -- 5. Portal clients: own portal-access matters only, never restricted ones.
  if deedbox.matter_visible('portal_client', p1, m1) then
    raise exception 'portal client sees a restricted matter';
  end if;
  delete from deedbox.matter_restriction_grant where matter = m1;
  if not deedbox.matter_visible('portal_client', p1, m1) then
    raise exception 'portal client cannot see their own matter';
  end if;
  if deedbox.matter_visible('portal_client', p2, m2) then
    raise exception 'portal access flag ignored';
  end if;

  -- 6. Office scope narrows to the matter's office.
  insert into deedbox.firm_setting (definition, value, effective_from)
    select id, '"office"'::jsonb, now() - interval '2 hours' from deedbox.setting_definition where key='visibility.staff_scope';
  if deedbox.matter_visible('staff', s_sup, m1) then
    raise exception 'office scope leaked across offices';
  end if;
  if not deedbox.matter_visible('staff', s_sup, m2) then
    raise exception 'office scope blocked the same office';
  end if;

  -- 7. Assignment scope: responsible lawyer and current staffing only.
  insert into deedbox.firm_setting (definition, value, effective_from)
    select id, '"assignment"'::jsonb, now() - interval '1 hour'
      from deedbox.setting_definition where key='visibility.staff_scope';
  if deedbox.matter_visible('staff', s_sup, m2) then
    raise exception 'assignment scope admitted an unassigned staff member';
  end if;
  insert into deedbox.matter_staffing (matter, staff, role_on_matter) values (m2, s_sup, 'assisting');
  if not deedbox.matter_visible('staff', s_sup, m2) then
    raise exception 'assignment scope refused an assisting staff member';
  end if;

  -- 8. Examiners and integration keys read no matters; system jobs read all.
  if deedbox.matter_visible('examiner', 1, m1) then raise exception 'examiner saw a matter'; end if;
  if not deedbox.matter_visible('system_job', 1, m1) then raise exception 'system job blocked'; end if;

  -- 9. Missing context fails closed.
  if deedbox.matter_visible(null, null, m1) then raise exception 'null context leaked'; end if;

  raise notice 'ALL 0005 PREDICATE FUNCTION TESTS PASSED';
end $$;

-- Row-security mirror: exercised AS the app role, inside the same transaction.
grant deedbox_app to current_user;
do $$
declare n bigint;
begin
  set local role deedbox_app;
  -- no principal context set -> fail closed, zero rows.
  select count(*) into n from deedbox.matter;
  if n <> 0 then raise exception 'RLS leaked % rows with no context', n; end if;
  -- staff context: sees per predicate (assignment scope is in force; lee is
  -- responsible for both matters).
  perform set_config('deedbox.principal_kind','staff', true);
  perform set_config('deedbox.principal_id',
    (select id::text from deedbox.staff_member where login='lee'), true);
  select count(*) into n from deedbox.matter;
  if n <> 2 then raise exception 'expected 2 visible matters for the responsible lawyer, got %', n; end if;
  -- support staff under assignment scope: only the staffed matter.
  perform set_config('deedbox.principal_id',
    (select id::text from deedbox.staff_member where login='sam'), true);
  select count(*) into n from deedbox.matter;
  if n <> 1 then raise exception 'expected 1 visible matter for assisting staff, got %', n; end if;
  reset role;
  raise notice 'ALL 0005 ROW-SECURITY MIRROR TESTS PASSED';
end $$;

rollback;
