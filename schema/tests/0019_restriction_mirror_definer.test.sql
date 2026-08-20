-- Tests for 0019_restriction_mirror_definer. Run as deployment role AFTER
-- 0001–0019. Reproduces the found defect exactly: the holder of the last
-- grant removes it AS THE APP ROLE, losing sight mid-command — the mirror
-- must still bring the flag down.

begin;

insert into deedbox.country_pack (code, name) values ('x19','Mirror Test Pack');
insert into deedbox.firm (name, operating_currency, timezone, country_pack)
  select 'Mirror Test Firm 19','AUD','Australia/Sydney', id
    from deedbox.country_pack where code = 'x19';
insert into deedbox.office (name, code) values ('Mirror Office 19','M19');

grant deedbox_app to current_user;

do $$
declare o bigint; r_admin bigint; s_a bigint; s_b bigint; p1 bigint; pa bigint; m1 bigint;
        flag boolean;
begin
  select id into o from deedbox.office where code = 'M19';
  select id into r_admin from deedbox.role where system_key = 'administrator';
  insert into deedbox.staff_member (person_name, login, role, office, email)
    values ('{"display":"Mia"}','mia19', r_admin, o, 'mia19@x.test') returning id into s_a;
  insert into deedbox.staff_member (person_name, login, role, office, email)
    values ('{"display":"Ned"}','ned19', r_admin, o, 'ned19@x.test') returning id into s_b;
  insert into deedbox.party (kind, display_name) values ('person','Mirror Client 19')
    returning id into p1;
  insert into deedbox.practice_area (name) values ('Mirror Area 19') returning id into pa;
  insert into deedbox.matter (matter_number, title, client_party, responsible_lawyer, office, practice_area)
    values ('M19-000001','Mirror matter', p1, s_a, o, pa) returning id into m1;

  set local role deedbox_app;

  -- Mia (predicate-passing) restricts the matter to Ned alone.
  perform set_config('deedbox.principal_kind','staff', true);
  perform set_config('deedbox.principal_id', s_a::text, true);
  insert into deedbox.matter_restriction_grant (matter, grantee_kind, grantee)
    values (m1, 'staff', s_b);

  -- Ned — the last guardian — lifts the restriction on himself.
  perform set_config('deedbox.principal_id', s_b::text, true);
  delete from deedbox.matter_restriction_grant where matter = m1;

  reset role;

  -- The flag must be DOWN even though the remover lost sight mid-command.
  select restricted into flag from deedbox.matter where id = m1;
  if flag then
    raise exception 'T1: restricted flag stayed up after the last grant was removed by its holder';
  end if;
end $$;

rollback;
