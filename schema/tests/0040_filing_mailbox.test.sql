-- Tests for 0040_filing_mailbox. Run as deployment role AFTER the full
-- chain. Proves: the token's format and uniqueness discipline, the receipt
-- ledger's exactly-once shape, the two settings keys, and the policy row.

begin;

grant deedbox_app to current_user;

insert into deedbox.country_pack (code, name) values ('XFM','Filing Mailbox Test Pack');
insert into deedbox.firm (name, operating_currency, timezone, country_pack)
  select 'Filing Mailbox Test Firm','AUD','Australia/Sydney', id from deedbox.country_pack where code='XFM';
insert into deedbox.office (name, code) values ('FM Office','XFM1');

do $$
declare
  off bigint; rl bigint; st bigint; pa bigint; p1 bigint;
  m1 bigint; m2 bigint; num text;
begin
  select id into off from deedbox.office where code = 'XFM1';
  select id into rl from deedbox.role where system_key = 'administrator';
  insert into deedbox.staff_member (person_name, login, role, office, email)
    values ('{"given":"Fay","family":"Mailer"}','fay.xfm', rl, off, 'fay.xfm@example.test')
    returning id into st;
  insert into deedbox.practice_area (name) values ('FM General') returning id into pa;
  insert into deedbox.party (kind, display_name) values ('person','FM Client') returning id into p1;
  insert into deedbox.party_name (party, name_kind, full_name) values (p1,'current','FM Client');
  num := deedbox.allocate_number('matter', null, current_date);
  insert into deedbox.matter (matter_number, title, client_party, responsible_lawyer, office, practice_area)
    values (num, 'FM matter one', p1, st, off, pa) returning id into m1;
  num := deedbox.allocate_number('matter', null, current_date);
  insert into deedbox.matter (matter_number, title, client_party, responsible_lawyer, office, practice_area)
    values (num, 'FM matter two', p1, st, off, pa) returning id into m2;

  set local role deedbox_app;
  perform set_config('deedbox.principal_kind','staff',true),
          set_config('deedbox.principal_id', st::text, true);

  -- T1: token format discipline — lowercase alphanumeric only
  begin
    update deedbox.matter set filing_token = 'NOT-VALID!' where id = m1;
    raise exception 'T1 FAIL: malformed token accepted';
  exception when check_violation then null;
  end;
  update deedbox.matter set filing_token = 'abc123def456' where id = m1;

  -- T2: token unique across matters where set
  begin
    update deedbox.matter set filing_token = 'abc123def456' where id = m2;
    raise exception 'T2 FAIL: duplicate token accepted';
  exception when unique_violation then null;
  end;
  update deedbox.matter set filing_token = 'zzz999yyy888' where id = m2;

  -- T3: the receipt ledger files one message onto one matter exactly once
  insert into deedbox.m365_filing_receipt (matter, internet_message_id, subject, from_address, document_count)
    values (m1, 'msg-one@example.test', 'Re: the contract', 'client@example.test', 2);
  begin
    insert into deedbox.m365_filing_receipt (matter, internet_message_id)
      values (m1, 'msg-one@example.test');
    raise exception 'T3 FAIL: the same message filed twice on one matter';
  exception when unique_violation then null;
  end;
  -- the same message may lawfully file onto a DIFFERENT matter (a sender
  -- addressing two matters' tokens sends two copies; overlap dedup is
  -- per matter, the matter_email shape)
  insert into deedbox.m365_filing_receipt (matter, internet_message_id)
    values (m2, 'msg-one@example.test');

  -- T4: the two settings keys ship with blank neutral defaults
  if (deedbox.current_setting_value('m365.filing_mailbox_address') #>> '{}') <> '' then
    raise exception 'T4 FAIL: filing_mailbox_address neutral default not blank';
  end if;
  if (deedbox.current_setting_value('m365.filing_reader_email') #>> '{}') <> '' then
    raise exception 'T4 FAIL: filing_reader_email neutral default not blank';
  end if;

  -- T5: the policy rows ship
  if (select mode from deedbox.deletion_policy where entity_type = 'm365_filing_receipt') <> 'never_deletable' then
    raise exception 'T5 FAIL: receipt deletion policy row missing or wrong';
  end if;
  if (select mode from deedbox.deletion_policy where entity_type = 'm365_filing_cursor') <> 'hard_delete_allowed' then
    raise exception 'T5 FAIL: cursor deletion policy row missing or wrong';
  end if;

  -- T6: filed mail is a lawful arrival source; strangers still refused
  insert into deedbox.document_file (matter, filename, size_bytes, storage_ref, source)
    values (m1, 'email.html', 4, m1 || '/xfm-email.html', 'email_filing');
  begin
    insert into deedbox.document_file (matter, filename, size_bytes, storage_ref, source)
      values (m1, 'oddity.bin', 4, m1 || '/xfm-oddity.bin', 'carrier_pigeon');
    raise exception 'T6 FAIL: unknown arrival source accepted';
  exception when check_violation then null;
  end;

  -- T7: the watermark cursor holds exactly one row
  insert into deedbox.m365_filing_cursor (last_polled_at) values (now());
  begin
    insert into deedbox.m365_filing_cursor (only_row, last_polled_at) values (true, now());
    raise exception 'T7 FAIL: a second cursor row accepted';
  exception when unique_violation then null;
  end;
  begin
    insert into deedbox.m365_filing_cursor (only_row, last_polled_at) values (false, now());
    raise exception 'T7 FAIL: an only_row=false cursor row accepted';
  exception when check_violation then null;
  end;

  reset role;
  raise notice '0040 suite: all assertions passed';
end $$;

rollback;
