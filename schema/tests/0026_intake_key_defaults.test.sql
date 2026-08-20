-- Tests for 0026_intake_key_defaults. Run as deployment role AFTER
-- 0001–0026. Proves: the app role can create, update and delete a key's
-- defaults row; referential integrity refuses a default naming a missing
-- row; the key column is immutable under update.

begin;

grant deedbox_app to current_user;

insert into deedbox.country_pack (code, name) values ('XKD','Key Defaults Test Pack');
insert into deedbox.firm (name, operating_currency, timezone, country_pack)
  select 'Key Defaults Test Firm','AUD','Australia/Sydney', id from deedbox.country_pack where code='XKD';

do $$
declare
  off bigint; off2 bigint; rl bigint; st bigint; pa bigint; ik bigint; ik2 bigint;
begin
  insert into deedbox.office (name, code) values ('KD Office','XKD1') returning id into off;
  insert into deedbox.office (name, code) values ('KD Office Two','XKD2') returning id into off2;
  select id into rl from deedbox.role where system_key = 'administrator';
  insert into deedbox.staff_member (person_name, login, role, office, email)
    values ('{"given":"Kay","family":"Defaults"}','kay.xkd', rl, off, 'kay.xkd@example.test')
    returning id into st;
  insert into deedbox.practice_area (name) values ('KD General') returning id into pa;
  insert into deedbox.integration_key (label, secret_hash, issued_by, key_display)
    values ('KD key','deadbeef', st, 'dbk_xkd_one') returning id into ik;
  insert into deedbox.integration_key (label, secret_hash, issued_by, key_display)
    values ('KD key two','deadbeef2', st, 'dbk_xkd_two') returning id into ik2;

  set local role deedbox_app;
  perform set_config('deedbox.principal_kind','staff',true),
          set_config('deedbox.principal_id', st::text, true);

  -- T1: create, update, delete as the app role
  insert into deedbox.integration_key_defaults (key, office, responsible_lawyer, practice_area)
    values (ik, off, st, pa);
  update deedbox.integration_key_defaults set office = off2 where key = ik;
  if (select office from deedbox.integration_key_defaults where key = ik) <> off2 then
    raise exception 'T1 FAIL: update did not take effect';
  end if;
  delete from deedbox.integration_key_defaults where key = ik;
  if exists (select 1 from deedbox.integration_key_defaults where key = ik) then
    raise exception 'T1 FAIL: delete did not take effect';
  end if;
  insert into deedbox.integration_key_defaults (key, office, responsible_lawyer, practice_area)
    values (ik, off, st, pa);

  -- T2: a default naming a missing office refuses (FK)
  begin
    insert into deedbox.integration_key_defaults (key, office, responsible_lawyer, practice_area)
      values (ik2, 999999901, st, pa);
    raise exception 'T2 FAIL: missing office accepted';
  exception when foreign_key_violation then
    null;
  end;

  -- T3: the key column is immutable under update
  begin
    update deedbox.integration_key_defaults set key = ik2 where key = ik;
    raise exception 'T3 FAIL: the defaults row moved to another key';
  exception when others then
    if sqlerrm like '%T3 FAIL%' then raise; end if;
  end;

  reset role;
  raise notice '0026 suite: all assertions passed';
end $$;

rollback;
