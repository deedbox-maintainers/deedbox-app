-- Tests for 0029_private_layer_completion. Run as deployment role AFTER
-- 0001–0029. Proves: the namespace's final shape (pl_ prefix, lifecycle
-- states, terminal retired, identity immutable); the seven-point extension
-- catalogue with the renamed report.menu_entry; the provisioning functions
-- create a real login role holding EXACTLY the issued views plus its OWN
-- isolated schema (zero base-table access) and refuse to
-- touch any role outside the reserved pl_ prefix; revoke/regrant flip the
-- grants; the issued views obey the visibility predicate of the stamped
-- session context and fail closed to zero rows without one.
--
-- Role discipline: OPERATIONS run as deedbox_app (the runtime posture);
-- privilege INSPECTIONS run as the deployment role — the app role holds no
-- usage on pl_views, so name-resolving privilege checks are fixture work.

begin;

grant deedbox_app to current_user;

insert into deedbox.country_pack (code, name) values ('XPL','Private Layer Test Pack');
insert into deedbox.firm (name, operating_currency, timezone, country_pack)
  select 'Private Layer Test Firm','AUD','Australia/Sydney', id from deedbox.country_pack where code='XPL';
insert into deedbox.office (name, code) values ('PL Office','XPL1');

do $$
declare
  off bigint; rl bigint; st bigint; st2 bigint; pa bigint; p1 bigint;
  m_open bigint; m_restricted bigint; num text; n int;
begin
  select id into off from deedbox.office where code = 'XPL1';
  select id into rl from deedbox.role where system_key = 'administrator';
  insert into deedbox.staff_member (person_name, login, role, office, email)
    values ('{"given":"Pia","family":"Layer"}','pia.xpl', rl, off, 'pia.xpl@example.test')
    returning id into st;
  insert into deedbox.staff_member (person_name, login, role, office, email)
    values ('{"given":"Out","family":"Sider"}','out.xpl', rl, off, 'out.xpl@example.test')
    returning id into st2;
  insert into deedbox.practice_area (name) values ('PL General') returning id into pa;
  insert into deedbox.party (kind, display_name) values ('person','PL Client') returning id into p1;
  insert into deedbox.party_name (party, name_kind, full_name) values (p1,'current','PL Client');

  num := deedbox.allocate_number('matter', null, current_date);
  insert into deedbox.matter (matter_number, title, client_party, responsible_lawyer, office, practice_area)
    values (num, 'PL open matter', p1, st, off, pa) returning id into m_open;
  num := deedbox.allocate_number('matter', null, current_date);
  insert into deedbox.matter (matter_number, title, client_party, responsible_lawyer, office, practice_area)
    values (num, 'PL restricted matter', p1, st, off, pa) returning id into m_restricted;
  -- restrict the second matter to pia alone; out.xpl must never see it
  insert into deedbox.matter_restriction_grant (matter, grantee_kind, grantee)
    values (m_restricted, 'staff', st);

  -- T1: the seven shipped extension points, under their shipped keys
  select count(*) into n from deedbox.ui_extension_point;
  if n <> 7 then raise exception 'T1 FAIL: expected 7 extension points, got %', n; end if;
  if not exists (select 1 from deedbox.ui_extension_point where point_key = 'report.menu_entry') then
    raise exception 'T1 FAIL: report.menu_entry missing (rename did not land)';
  end if;
  if exists (select 1 from deedbox.ui_extension_point where point_key = 'report.menu') then
    raise exception 'T1 FAIL: the old report.menu key survived';
  end if;

  ------------------------------------------------------------------
  -- Operations as the app role.
  ------------------------------------------------------------------
  set local role deedbox_app;
  perform set_config('deedbox.principal_kind','staff',true),
          set_config('deedbox.principal_id', st::text, true);

  -- T2: register a namespace row under the final shape; firm_ prefix refuses
  insert into deedbox.private_namespace (namespace, description, db_principal)
    values ('pl_suite_pkg', 'suite package', 'pl_suite_pkg');
  begin
    insert into deedbox.private_namespace (namespace, description, db_principal)
      values ('firm_oldstyle', 'stale prefix', 'pl_x');
    raise exception 'T2 FAIL: the stale firm_ prefix was accepted';
  exception when check_violation then null;
  end;

  -- T3: provision the principal (as the app role — the runtime path)
  perform deedbox.private_layer_provision('pl_suite_pkg', 'suite-secret-0123456789abcdef');

  -- T5: the guard — provisioning functions refuse non-pl_ roles and reuse
  begin
    perform deedbox.private_layer_rotate('postgres', 'x-not-a-real-secret-24chars');
    raise exception 'T5 FAIL: rotate accepted a role outside pl_';
  exception when others then
    if sqlerrm not like '%reserved pl_ prefix%' then raise; end if;
  end;
  begin
    perform deedbox.private_layer_provision('pl_suite_pkg', 'another-secret-0123456789ab');
    raise exception 'T5 FAIL: double provision accepted';
  exception when others then
    if sqlerrm not like '%already exists%' then raise; end if;
  end;
  begin
    perform deedbox.private_layer_provision('pl_short', 'short');
    raise exception 'T5 FAIL: a weak secret was accepted';
  exception when others then
    if sqlerrm not like '%24 characters%' then raise; end if;
  end;

  ------------------------------------------------------------------
  -- Inspections as the deployment role (the app role cannot resolve
  -- pl_views names — deliberately).
  ------------------------------------------------------------------
  reset role;

  -- T3 (verified): role exists with login, view grants, and its OWN schema
  if not exists (select 1 from pg_catalog.pg_roles where rolname = 'pl_suite_pkg' and rolcanlogin) then
    raise exception 'T3 FAIL: principal role missing or cannot log in';
  end if;
  if not has_table_privilege('pl_suite_pkg', 'pl_views.visible_matters', 'select') then
    raise exception 'T3 FAIL: issued view not granted';
  end if;
  if not exists (select 1 from information_schema.schemata
                  where schema_name = 'pl_suite_pkg' and schema_owner = 'pl_suite_pkg') then
    raise exception 'T3 FAIL: the layer''s own schema is missing or wrongly owned';
  end if;

  -- T4: zero base-table access
  if has_table_privilege('pl_suite_pkg', 'deedbox.matter', 'select') then
    raise exception 'T4 FAIL: principal can read a base table';
  end if;
  if has_schema_privilege('pl_suite_pkg', 'deedbox', 'usage') then
    raise exception 'T4 FAIL: principal holds usage on the core schema';
  end if;

  -- T6: revoke strips the grants (suspension); regrant restores; the
  -- retire-style revoke also freezes login. Ops as app role, checks here.
  set local role deedbox_app;
  perform deedbox.private_layer_revoke('pl_suite_pkg', false);
  reset role;
  if has_table_privilege('pl_suite_pkg', 'pl_views.visible_matters', 'select') then
    raise exception 'T6 FAIL: revoke left the view grant';
  end if;
  set local role deedbox_app;
  perform deedbox.private_layer_regrant('pl_suite_pkg');
  reset role;
  if not has_table_privilege('pl_suite_pkg', 'pl_views.visible_matters', 'select') then
    raise exception 'T6 FAIL: regrant did not restore the view grant';
  end if;
  set local role deedbox_app;
  perform deedbox.private_layer_revoke('pl_suite_pkg', true);
  reset role;
  if exists (select 1 from pg_catalog.pg_roles where rolname = 'pl_suite_pkg' and rolcanlogin) then
    raise exception 'T6 FAIL: retire-style revoke left login enabled';
  end if;
  set local role deedbox_app;
  perform deedbox.private_layer_regrant('pl_suite_pkg');

  -- T7: lifecycle — retired is terminal; identity immutable (app role)
  update deedbox.private_namespace set state = 'suspended' where namespace = 'pl_suite_pkg';
  update deedbox.private_namespace set state = 'registered' where namespace = 'pl_suite_pkg';
  begin
    update deedbox.private_namespace set db_principal = 'pl_other' where namespace = 'pl_suite_pkg';
    raise exception 'T7 FAIL: principal identity was mutable';
  exception when others then
    if sqlerrm not like '%identity%' then raise; end if;
  end;
  update deedbox.private_namespace set state = 'retired' where namespace = 'pl_suite_pkg';
  begin
    update deedbox.private_namespace set state = 'registered' where namespace = 'pl_suite_pkg';
    raise exception 'T7 FAIL: a retired namespace moved';
  exception when others then
    if sqlerrm not like '%terminal%' then raise; end if;
  end;

  reset role;

  -- T7b: deletion is refused by the GUARD even for deployment-level
  -- privileges (the app role cannot even attempt it — it holds no delete
  -- grant, which the permission layer refuses first)
  begin
    delete from deedbox.private_namespace where namespace = 'pl_suite_pkg';
    raise exception 'T7 FAIL: a namespace row was deleted';
  exception when others then
    if sqlerrm not like '%never deleted%' then raise; end if;
  end;

  -- T8: the issued views obey the stamped context and fail
  -- closed without one; the layer writes ONLY its own schema. As the role.
  execute format('grant %I to current_user', 'pl_suite_pkg');
  set local role pl_suite_pkg;
  perform set_config('deedbox.principal_kind','staff',true),
          set_config('deedbox.principal_id', st::text, true);
  select count(*) into n from pl_views.visible_matters where title like 'PL %';
  if n <> 2 then raise exception 'T8 FAIL: the entitled holder expected 2 matters, got %', n; end if;
  perform set_config('deedbox.principal_id', st2::text, true);
  select count(*) into n from pl_views.visible_matters where title = 'PL restricted matter';
  if n <> 0 then raise exception 'T8 FAIL: a restricted matter leaked to a non-holder'; end if;
  perform set_config('deedbox.principal_kind','',true), set_config('deedbox.principal_id','',true);
  select count(*) into n from pl_views.visible_matters;
  if n <> 0 then raise exception 'T8 FAIL: absent context did not fail closed (got % rows)', n; end if;
  begin
    select count(*) into n from deedbox.matter;
    raise exception 'T8 FAIL: the principal read a base table directly';
  exception when insufficient_privilege then null;
  end;

  -- T9: the layer's own home — the principal creates, writes and reads its
  -- own tables in its own schema, and nowhere else
  create table pl_suite_pkg.own_notes (id int primary key, note text not null);
  insert into pl_suite_pkg.own_notes values (1, 'the layer''s own row');
  select count(*) into n from pl_suite_pkg.own_notes;
  if n <> 1 then raise exception 'T9 FAIL: own-schema write did not land'; end if;
  begin
    create table pl_views.smuggled (id int);
    raise exception 'T9 FAIL: the principal created a table in pl_views';
  exception when insufficient_privilege then null;
  end;
  begin
    create table deedbox.smuggled (id int);
    raise exception 'T9 FAIL: the principal created a table in the core schema';
  exception when insufficient_privilege then null;
  end;

  reset role;
  raise notice '0029 suite: all assertions passed';
end $$;

rollback;

-- roles are cluster-global but transactional: a rolled-back provision leaves
-- nothing behind. Belt-and-braces for a partially-failed manual run:
drop role if exists pl_suite_pkg;
