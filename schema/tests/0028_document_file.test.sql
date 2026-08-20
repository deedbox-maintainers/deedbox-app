-- Tests for 0028_document_file. Run as deployment role AFTER 0001–0028.
-- Proves: the app role can insert and read a landing record; the app role
-- can neither change nor remove one (append-only through grants); an empty
-- file, an over-long filename, an unknown source and a duplicate storage
-- reference all refuse; the matter link is enforced.

begin;

grant deedbox_app to current_user;

insert into deedbox.country_pack (code, name) values ('XDF','Document File Test Pack');
insert into deedbox.firm (name, operating_currency, timezone, country_pack)
  select 'Document File Test Firm','AUD','Australia/Sydney', id from deedbox.country_pack where code='XDF';
insert into deedbox.office (name, code) values ('DF Office','XDF1');

do $$
declare
  off bigint; rl bigint; st bigint; pa bigint; p1 bigint; m bigint;
  ik bigint; d1 bigint; num text;
begin
  select id into off from deedbox.office where code = 'XDF1';
  select id into rl from deedbox.role where system_key = 'administrator';
  insert into deedbox.staff_member (person_name, login, role, office, email)
    values ('{"given":"Dana","family":"Files"}','dana.xdf', rl, off, 'dana.xdf@example.test')
    returning id into st;
  insert into deedbox.practice_area (name) values ('DF General') returning id into pa;
  insert into deedbox.party (kind, display_name) values ('person','DF Client') returning id into p1;
  insert into deedbox.party_name (party, name_kind, full_name) values (p1,'current','DF Client');
  num := deedbox.allocate_number('matter', null, current_date);
  insert into deedbox.matter (matter_number, title, client_party, responsible_lawyer, office, practice_area)
    values (num, 'DF landing matter', p1, st, off, pa) returning id into m;
  insert into deedbox.integration_key (label, secret_hash, issued_by, key_display)
    values ('DF key','df_hash', st, 'dbk_xdf_one') returning id into ik;

  set local role deedbox_app;
  perform set_config('deedbox.principal_kind','system_job',true),
          set_config('deedbox.principal_id','21',true);

  -- T1: the app role inserts and reads a landing record
  insert into deedbox.document_file
      (matter, filename, content_type, size_bytes, storage_ref, source, integration_key, external_ref)
    values (m, 'letter of advice.pdf', 'application/pdf', 5, m || '/aaaa-letter.pdf', 'intake_api', ik, 'xdf-ref-1')
    returning id into d1;
  if (select filename from deedbox.document_file where id = d1) <> 'letter of advice.pdf' then
    raise exception 'T1 FAIL: inserted row not readable by the app role';
  end if;

  -- T2: the app role cannot change a landing record (no update grant)
  begin
    update deedbox.document_file set filename = 'renamed.pdf' where id = d1;
    raise exception 'T2 FAIL: update was accepted';
  exception when insufficient_privilege then null;
  end;

  -- T3: the app role cannot remove a landing record (no delete grant)
  begin
    delete from deedbox.document_file where id = d1;
    raise exception 'T3 FAIL: delete was accepted';
  exception when insufficient_privilege then null;
  end;

  -- T4: a genuinely empty file is admitted (0044 — real archives hold them);
  -- a negative size still refuses. Amended when 0044 relaxed the bound.
  insert into deedbox.document_file (matter, filename, size_bytes, storage_ref, source)
    values (m, 'empty.pdf', 0, m || '/bbbb-empty.pdf', 'intake_api');
  begin
    insert into deedbox.document_file (matter, filename, size_bytes, storage_ref, source)
      values (m, 'negative.pdf', -1, m || '/bbbb-negative.pdf', 'intake_api');
    raise exception 'T4 FAIL: negative-size record was accepted';
  exception when check_violation then null;
  end;

  -- T5: a duplicate storage reference refuses (one record per stored object)
  begin
    insert into deedbox.document_file (matter, filename, size_bytes, storage_ref, source)
      values (m, 'copy.pdf', 5, m || '/aaaa-letter.pdf', 'intake_api');
    raise exception 'T5 FAIL: duplicate storage reference was accepted';
  exception when unique_violation then null;
  end;

  -- T6: an unknown source refuses (closed vocabulary, extended by numbered change)
  begin
    insert into deedbox.document_file (matter, filename, size_bytes, storage_ref, source)
      values (m, 'odd.pdf', 5, m || '/cccc-odd.pdf', 'somewhere_else');
    raise exception 'T6 FAIL: unknown source was accepted';
  exception when check_violation then null;
  end;

  -- T7: a landing record must name a real matter
  begin
    insert into deedbox.document_file (matter, filename, size_bytes, storage_ref, source)
      values (999999999, 'orphan.pdf', 5, 'x/dddd-orphan.pdf', 'intake_api');
    raise exception 'T7 FAIL: record without a real matter was accepted';
  exception when foreign_key_violation then null;
  end;

  -- T8: an over-long filename refuses
  begin
    insert into deedbox.document_file (matter, filename, size_bytes, storage_ref, source)
      values (m, repeat('n', 301), 5, m || '/eeee-long.pdf', 'intake_api');
    raise exception 'T8 FAIL: over-long filename was accepted';
  exception when check_violation then null;
  end;

  reset role;
  raise notice '0028 suite: all assertions passed';
end $$;

rollback;
