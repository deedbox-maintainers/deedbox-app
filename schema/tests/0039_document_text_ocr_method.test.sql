-- Tests for 0039_document_text_ocr_method. Run as deployment role AFTER
-- the full chain. Proves: 'ocr' is now a lawful extraction method, the old
-- vocabulary still stands, and strangers are still refused.

begin;

grant deedbox_app to current_user;

insert into deedbox.country_pack (code, name) values ('XOR','OCR Method Test Pack');
insert into deedbox.firm (name, operating_currency, timezone, country_pack)
  select 'OCR Method Test Firm','AUD','Australia/Sydney', id from deedbox.country_pack where code='XOR';
insert into deedbox.office (name, code) values ('OR Office','XOR1');

do $$
declare
  off bigint; rl bigint; st bigint; pa bigint; p1 bigint; m bigint; num text;
  f1 bigint; f2 bigint; d1 bigint; d2 bigint; v1 bigint; v2 bigint;
begin
  select id into off from deedbox.office where code = 'XOR1';
  select id into rl from deedbox.role where system_key = 'administrator';
  insert into deedbox.staff_member (person_name, login, role, office, email)
    values ('{"given":"Oscar","family":"Reader"}','oscar.xor', rl, off, 'oscar.xor@example.test')
    returning id into st;
  insert into deedbox.practice_area (name) values ('OR General') returning id into pa;
  insert into deedbox.party (kind, display_name) values ('person','OR Client') returning id into p1;
  insert into deedbox.party_name (party, name_kind, full_name) values (p1,'current','OR Client');
  num := deedbox.allocate_number('matter', null, current_date);
  insert into deedbox.matter (matter_number, title, client_party, responsible_lawyer, office, practice_area)
    values (num, 'OR matter', p1, st, off, pa) returning id into m;

  set local role deedbox_app;
  perform set_config('deedbox.principal_kind','staff',true),
          set_config('deedbox.principal_id', st::text, true);

  set constraints deedbox.document_head_consistency immediate;
  insert into deedbox.document_file (matter, filename, size_bytes, storage_ref, source, uploaded_by)
    values (m, 'scan.pdf', 8, m || '/xor-scan.pdf', 'staff_upload', st) returning id into f1;
  insert into deedbox.document (matter, title, current_file, current_version, created_by)
    values (m, 'Scan', f1, 1, st) returning id into d1;
  insert into deedbox.document_version (document, version_no, file, created_by)
    values (d1, 1, f1, st);
  select id into v1 from deedbox.document_version where document = d1;

  insert into deedbox.document_file (matter, filename, size_bytes, storage_ref, source, uploaded_by)
    values (m, 'typed.pdf', 8, m || '/xor-typed.pdf', 'staff_upload', st) returning id into f2;
  insert into deedbox.document (matter, title, current_file, current_version, created_by)
    values (m, 'Typed', f2, 1, st) returning id into d2;
  insert into deedbox.document_version (document, version_no, file, created_by)
    values (d2, 1, f2, st);
  select id into v2 from deedbox.document_version where document = d2;

  -- T1: 'ocr' is a lawful method
  insert into deedbox.document_version_text (version, content, method, char_count)
    values (v1, 'recognised from the scan', 'ocr', 24);

  -- T2: the old vocabulary still stands ('embedded' insert, then the
  -- honest re-extraction path may flip a method between lawful values)
  insert into deedbox.document_version_text (version, content, method, char_count)
    values (v2, 'typed text', 'embedded', 10);
  update deedbox.document_version_text set method = 'none', content = '', char_count = 0 where version = v2;
  update deedbox.document_version_text set method = 'ocr', content = 'now recognised', char_count = 14 where version = v2;

  -- T3: strangers are still refused
  begin
    update deedbox.document_version_text set method = 'scribble' where version = v2;
    raise exception 'T3 FAIL: unknown extraction method accepted';
  exception when check_violation then null;
  end;

  reset role;
  raise notice '0039 suite: all assertions passed';
end $$;

rollback;
