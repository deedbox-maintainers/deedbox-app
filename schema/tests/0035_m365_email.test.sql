-- Tests for 0035_m365_email. Run as deployment role AFTER the full chain.
-- Proves: one connection per staff member; filed emails are append-only
-- through grants and dedupe on (matter, internet message id); calendar
-- events dedupe on the Microsoft event id; direction is a closed
-- vocabulary; the policy rows ship.

begin;

grant deedbox_app to current_user;

insert into deedbox.country_pack (code, name) values ('XME','M365 Email Test Pack');
insert into deedbox.firm (name, operating_currency, timezone, country_pack)
  select 'M365 Email Test Firm','AUD','Australia/Sydney', id from deedbox.country_pack where code='XME';
insert into deedbox.office (name, code) values ('ME Office','XME1');

do $$
declare
  off bigint; rl bigint; st bigint; pa bigint; p1 bigint; m bigint; num text; em bigint;
begin
  select id into off from deedbox.office where code = 'XME1';
  select id into rl from deedbox.role where system_key = 'administrator';
  insert into deedbox.staff_member (person_name, login, role, office, email)
    values ('{"given":"Mel","family":"Mail"}','mel.xme', rl, off, 'mel.xme@example.test')
    returning id into st;
  insert into deedbox.practice_area (name) values ('ME General') returning id into pa;
  insert into deedbox.party (kind, display_name) values ('person','ME Client') returning id into p1;
  insert into deedbox.party_name (party, name_kind, full_name) values (p1,'current','ME Client');
  num := deedbox.allocate_number('matter', null, current_date);
  insert into deedbox.matter (matter_number, title, client_party, responsible_lawyer, office, practice_area)
    values (num, 'ME matter', p1, st, off, pa) returning id into m;

  set local role deedbox_app;
  perform set_config('deedbox.principal_kind','staff',true),
          set_config('deedbox.principal_id', st::text, true);

  -- T1: one connection per staff member
  insert into deedbox.m365_connection (staff, ms_user_id, email, access_token, refresh_token, token_expires_at)
    values (st, 'ms-user-1', 'mel@hosted.test', 'at', 'rt', now() + interval '1 hour');
  begin
    insert into deedbox.m365_connection (staff, ms_user_id, email, access_token, refresh_token, token_expires_at)
      values (st, 'ms-user-2', 'mel2@hosted.test', 'at', 'rt', now() + interval '1 hour');
    raise exception 'T1 FAIL: second connection for one staff member accepted';
  exception when unique_violation then null;
  end;

  -- T2: filed mail dedupes on (matter, internet message id) and never edits
  insert into deedbox.matter_email (matter, staff, direction, from_address, subject, ms_internet_message_id, occurred_at)
    values (m, st, 'received', 'client@example.test', '[ME] hello', '<msg-1@example>', now())
    returning id into em;
  begin
    insert into deedbox.matter_email (matter, staff, direction, from_address, subject, ms_internet_message_id, occurred_at)
      values (m, st, 'received', 'client@example.test', '[ME] hello again', '<msg-1@example>', now());
    raise exception 'T2 FAIL: duplicate internet message id accepted';
  exception when unique_violation then null;
  end;
  begin
    update deedbox.matter_email set subject = 'rewritten' where id = em;
    raise exception 'T2 FAIL: filed mail update accepted';
  exception when insufficient_privilege then null;
  end;
  begin
    delete from deedbox.matter_email where id = em;
    raise exception 'T2 FAIL: filed mail delete accepted';
  exception when insufficient_privilege then null;
  end;

  -- T3: direction is a closed vocabulary
  begin
    insert into deedbox.matter_email (matter, direction, occurred_at)
      values (m, 'forwarded', now());
    raise exception 'T3 FAIL: unknown direction accepted';
  exception when check_violation then null;
  end;

  -- T4: calendar events dedupe on the Microsoft event id
  insert into deedbox.matter_calendar_event (matter, staff, ms_event_id, subject, starts_at)
    values (m, st, 'ev-1', 'Conference', now() + interval '1 day');
  begin
    insert into deedbox.matter_calendar_event (matter, staff, ms_event_id, subject, starts_at)
      values (m, st, 'ev-1', 'Conference again', now() + interval '2 days');
    raise exception 'T4 FAIL: duplicate event id accepted';
  exception when unique_violation then null;
  end;

  -- T5: the policy rows ship
  if (select count(*) from deedbox.deletion_policy
       where entity_type in ('m365_connection','matter_email','matter_calendar_event')) <> 3 then
    raise exception 'T5 FAIL: deletion-policy rows missing';
  end if;

  reset role;
  raise notice '0035 suite: all assertions passed';
end $$;

rollback;
