-- Tests for 0044_document_note_import. Run as deployment role AFTER the full
-- chain. Proves the import source label is admitted (and junk still refused),
-- and that a note's author stores, back-fills once, and never moves again.

begin;

grant deedbox_app to current_user;

insert into deedbox.country_pack (code, name) values ('XDN','Doc Note Import Test Pack');
insert into deedbox.firm (name, operating_currency, timezone, country_pack)
  select 'Doc Note Import Test Firm','AUD','Australia/Sydney', id
    from deedbox.country_pack where code='XDN';
insert into deedbox.office (name, code) values ('DN Office','XDN1');

do $$
declare
  off bigint; rl bigint; st bigint; st2 bigint; pa bigint; p1 bigint; m bigint;
  num text; nid bigint;
begin
  select id into off from deedbox.office where code = 'XDN1';
  select id into rl from deedbox.role where system_key = 'administrator';
  insert into deedbox.staff_member (person_name, login, role, office, email)
    values ('{"given":"Dora","family":"Note"}','dora.xdn', rl, off, 'dora.xdn@example.test')
    returning id into st;
  insert into deedbox.staff_member (person_name, login, role, office, email)
    values ('{"given":"Ned","family":"Author"}','ned.xdn', rl, off, 'ned.xdn@example.test')
    returning id into st2;
  insert into deedbox.practice_area (name) values ('DN General') returning id into pa;
  insert into deedbox.party (kind, display_name) values ('person','DN Client') returning id into p1;
  insert into deedbox.party_name (party, name_kind, full_name) values (p1,'current','DN Client');
  num := deedbox.allocate_number('matter', null, current_date);
  insert into deedbox.matter (matter_number, title, client_party, responsible_lawyer, office, practice_area)
    values (num, 'DN matter', p1, st, off, pa) returning id into m;

  -- T1 an imported file is admitted under its own source label
  insert into deedbox.document_file
    (matter, filename, content_type, size_bytes, storage_ref, source, uploaded_by)
  values (m, 'imported-brief.pdf', 'application/pdf', 12345, 'xdn/imported-brief.pdf',
          'import', st);
  perform 1 from deedbox.document_file
   where storage_ref = 'xdn/imported-brief.pdf' and source = 'import';
  if not found then
    raise exception 'T1 FAILED: the import source label was not stored';
  end if;

  -- T2 a made-up source label still refuses
  begin
    insert into deedbox.document_file
      (matter, filename, content_type, size_bytes, storage_ref, source, uploaded_by)
    values (m, 'junk.pdf', 'application/pdf', 1, 'xdn/junk.pdf', 'sideload', st);
    raise exception 'T2 FAILED: an unknown source label was accepted';
  exception when others then
    if sqlerrm not like '%violates check constraint%' then raise; end if;
  end;

  -- T2a a genuinely empty file is admitted (the archive holds 25 of them);
  -- a negative size never is
  insert into deedbox.document_file
    (matter, filename, content_type, size_bytes, storage_ref, source, uploaded_by)
  values (m, 'empty.docx', 'application/octet-stream', 0, 'xdn/empty.docx', 'import', st);
  perform 1 from deedbox.document_file where storage_ref = 'xdn/empty.docx' and size_bytes = 0;
  if not found then
    raise exception 'T2a FAILED: an empty file was not admitted';
  end if;
  begin
    insert into deedbox.document_file
      (matter, filename, content_type, size_bytes, storage_ref, source, uploaded_by)
    values (m, 'neg.docx', 'application/octet-stream', -1, 'xdn/neg.docx', 'import', st);
    raise exception 'T2a FAILED: a negative size was accepted';
  exception when others then
    if sqlerrm not like '%violates check constraint%' then raise; end if;
  end;

  -- T3 a note born with its author stores it
  insert into deedbox.note (owner_type, owner, body, author)
    values ('matter', m, 'DN note with author', st2) returning id into nid;
  perform 1 from deedbox.note where id = nid and author = st2;
  if not found then
    raise exception 'T3 FAILED: the author was not stored at insert';
  end if;

  -- T4 a note born without one accepts a single back-fill
  insert into deedbox.note (owner_type, owner, body)
    values ('matter', m, 'DN note without author') returning id into nid;
  update deedbox.note set author = st where id = nid;
  perform 1 from deedbox.note where id = nid and author = st;
  if not found then
    raise exception 'T4 FAILED: a null author did not accept its one write';
  end if;

  -- T5 a set author never changes
  begin
    update deedbox.note set author = st2 where id = nid;
    raise exception 'T5 FAILED: a set author accepted a change';
  exception when others then
    if sqlerrm not like '%author is immutable once set%' then raise; end if;
  end;

  -- T6 immutability includes erasure
  begin
    update deedbox.note set author = null where id = nid;
    raise exception 'T6 FAILED: a set author accepted erasure';
  exception when others then
    if sqlerrm not like '%author is immutable once set%' then raise; end if;
  end;

  -- T7 unrelated edits leave the author standing
  update deedbox.note set body = 'DN note without author, edited' where id = nid;
  perform 1 from deedbox.note where id = nid and author = st;
  if not found then
    raise exception 'T7 FAILED: an unrelated edit disturbed the author';
  end if;

  -- T8 the batch engine's vocabulary admits the two new domains; junk never
  insert into deedbox.import_batch (record_domain, mode, source_system, state, report_artefact)
    values ('documents', 'validate_only', 'xdn-test', 'completed', 'xdn-artefact');
  insert into deedbox.import_batch (record_domain, mode, source_system, state, report_artefact)
    values ('notes', 'validate_only', 'xdn-test', 'completed', 'xdn-artefact');
  begin
    insert into deedbox.import_batch (record_domain, mode, source_system, state, report_artefact)
      values ('sideload', 'validate_only', 'xdn-test', 'completed', 'xdn-artefact');
    raise exception 'T8 FAILED: an unknown record domain was accepted';
  exception when others then
    if sqlerrm not like '%violates check constraint%' then raise; end if;
  end;
end $$;

rollback;
