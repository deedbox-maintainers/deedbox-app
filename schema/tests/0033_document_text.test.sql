-- Tests for 0033_document_text. Run as deployment role AFTER the full
-- chain. Proves: one text row per version (unique), the version pointer is
-- immutable while content may be re-extracted, the widened search
-- vocabulary accepts 'document' and still refuses strangers, and the
-- deletion-policy row ships.

begin;

grant deedbox_app to current_user;

insert into deedbox.country_pack (code, name) values ('XDX','Document Text Test Pack');
insert into deedbox.firm (name, operating_currency, timezone, country_pack)
  select 'Document Text Test Firm','AUD','Australia/Sydney', id from deedbox.country_pack where code='XDX';
insert into deedbox.office (name, code) values ('DX Office','XDX1');

do $$
declare
  off bigint; rl bigint; st bigint; pa bigint; p1 bigint; m bigint; num text;
  f1 bigint; d1 bigint; v1 bigint;
begin
  select id into off from deedbox.office where code = 'XDX1';
  select id into rl from deedbox.role where system_key = 'administrator';
  insert into deedbox.staff_member (person_name, login, role, office, email)
    values ('{"given":"Tex","family":"Tract"}','tex.xdx', rl, off, 'tex.xdx@example.test')
    returning id into st;
  insert into deedbox.practice_area (name) values ('DX General') returning id into pa;
  insert into deedbox.party (kind, display_name) values ('person','DX Client') returning id into p1;
  insert into deedbox.party_name (party, name_kind, full_name) values (p1,'current','DX Client');
  num := deedbox.allocate_number('matter', null, current_date);
  insert into deedbox.matter (matter_number, title, client_party, responsible_lawyer, office, practice_area)
    values (num, 'DX matter', p1, st, off, pa) returning id into m;

  set local role deedbox_app;
  perform set_config('deedbox.principal_kind','staff',true),
          set_config('deedbox.principal_id', st::text, true);

  set constraints deedbox.document_head_consistency immediate;
  insert into deedbox.document_file (matter, filename, size_bytes, storage_ref, source, uploaded_by)
    values (m, 'letter.pdf', 8, m || '/dx-letter.pdf', 'staff_upload', st) returning id into f1;
  insert into deedbox.document (matter, title, current_file, current_version, created_by)
    values (m, 'Letter', f1, 1, st) returning id into d1;
  insert into deedbox.document_version (document, version_no, file, created_by)
    values (d1, 1, f1, st);
  select id into v1 from deedbox.document_version where document = d1;

  -- One text row per version; re-extraction updates content, never the version
  insert into deedbox.document_version_text (version, content, method, char_count)
    values (v1, 'dear sir', 'embedded', 8);
  begin
    insert into deedbox.document_version_text (version, content, method)
      values (v1, 'duplicate', 'embedded');
    raise exception 'T1 FAIL: second text row for one version accepted';
  exception when unique_violation then null;
  end;
  update deedbox.document_version_text set content = 'dear sir or madam', char_count = 17 where version = v1;
  begin
    update deedbox.document_version_text set version = v1 + 1 where version = v1;
    raise exception 'T1 FAIL: version pointer rewritten';
  exception when others then
    if sqlerrm not like '%never changes version%' then raise; end if;
  end;

  -- The widened search vocabulary
  insert into deedbox.search_index (entry_type, source, matter, display_title, body)
    values ('document', d1, m, 'Letter', 'dear sir or madam');
  begin
    insert into deedbox.search_index (entry_type, source, matter, display_title, body)
      values ('spreadsheet', d1, m, 'nope', '');
    raise exception 'T2 FAIL: unknown entry type accepted';
  exception when check_violation then null;
  end;

  -- The deletion-policy row ships
  if (select mode from deedbox.deletion_policy where entity_type = 'document_version_text') <> 'hard_delete_allowed' then
    raise exception 'T3 FAIL: deletion policy row missing or wrong';
  end if;

  reset role;
  raise notice '0033 suite: all assertions passed';
end $$;

rollback;
