-- Tests for 0061_despatched_document_source. Run as deployment role AFTER
-- the full chain. The landing record accepts the despatch provenance and
-- still refuses a label outside the vocabulary. Where the product files a
-- despatched copy is pinned in the application suite (despatch filing).

begin;

insert into deedbox.country_pack (code, name) values ('T61','Sixty-one');
insert into deedbox.firm (name, operating_currency, timezone, country_pack)
  select 'T61 Firm','AUD','Australia/Sydney', id from deedbox.country_pack where code = 'T61';
insert into deedbox.office (name, code) values ('T61','T61');

do $$
declare
  o bigint; r_lawyer bigint; s_law bigint;
  p1 bigint; pa bigint; m1 bigint;
  f1 bigint; refused boolean := false;
begin
  select id into o from deedbox.office where code = 'T61';
  select id into r_lawyer from deedbox.role where system_key = 'lawyer';
  insert into deedbox.staff_member (person_name, login, role, office, email)
    values ('{"display":"Lee Sixty-one"}','lee61', r_lawyer, o, 'lee61@x.test') returning id into s_law;
  insert into deedbox.party (kind, display_name) values ('person','Cli Sixty-one') returning id into p1;
  insert into deedbox.party_name (party, name_kind, full_name) values (p1,'current','Cli Sixty-one');
  insert into deedbox.practice_area (name) values ('T61 Litigation') returning id into pa;
  insert into deedbox.matter (matter_number, title, client_party, responsible_lawyer, office, practice_area)
    values (deedbox.allocate_number('matter', null, current_date), 'T61 host', p1, s_law, o, pa) returning id into m1;

  -- T1: the despatch provenance is a lawful source for a landing record
  insert into deedbox.document_file
      (matter, filename, content_type, size_bytes, storage_ref, source, uploaded_by, external_ref)
    values (m1, 'Invoice T61-001.pdf', 'application/pdf', 1234, 't61-despatch-1',
            'outbound_despatch', s_law, 'outbound_despatch:9990001')
    returning id into f1;
  if f1 is null then
    raise exception 'T1 FAILED: the despatch source was not accepted';
  end if;

  -- T2: a label outside the vocabulary still refuses
  begin
    insert into deedbox.document_file
        (matter, filename, content_type, size_bytes, storage_ref, source)
      values (m1, 'stray.pdf', 'application/pdf', 10, 't61-despatch-2', 'carrier_pigeon');
  exception when check_violation then
    refused := true;
  end;
  if not refused then
    raise exception 'T2 FAILED: an unknown source label was accepted';
  end if;
end $$;

rollback;
