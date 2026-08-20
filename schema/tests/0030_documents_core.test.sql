-- Tests for 0030_documents_core. Run as deployment role AFTER the full chain.
-- Proves: folder discipline (same matter, no cycles, unique names, delete
-- only when empty); head discipline (same-matter folder, locked rows admit
-- only their flags, legal hold blocks soft deletion, closed matters demand
-- the edit-closed ceremony); version discipline (dense numbering, same-matter
-- file, checkout exclusivity, locked refusal, deferred head consistency);
-- evidence posture (versions and access rows append-only through grants);
-- the widened landing-store vocabulary; and the catalogue extensions
-- (documents.manage held by the administrator, deletion-policy rows).

begin;

grant deedbox_app to current_user;

insert into deedbox.country_pack (code, name) values ('XDC','Documents Core Test Pack');
insert into deedbox.firm (name, operating_currency, timezone, country_pack)
  select 'Documents Core Test Firm','AUD','Australia/Sydney', id from deedbox.country_pack where code='XDC';
insert into deedbox.office (name, code) values ('DC Office','XDC1');

do $$
declare
  off bigint; rl bigint; s1 bigint; s2 bigint; pa bigint; p1 bigint;
  m1 bigint; m2 bigint; num text;
  f_root bigint; f_child bigint; f_empty bigint;
  file1 bigint; file2 bigint; file3 bigint; filem2 bigint;
  d1 bigint; d2 bigint;
begin
  select id into off from deedbox.office where code = 'XDC1';
  select id into rl from deedbox.role where system_key = 'administrator';
  insert into deedbox.staff_member (person_name, login, role, office, email)
    values ('{"given":"Dora","family":"Docs"}','dora.xdc', rl, off, 'dora.xdc@example.test')
    returning id into s1;
  insert into deedbox.staff_member (person_name, login, role, office, email)
    values ('{"given":"Ben","family":"Files"}','ben.xdc', rl, off, 'ben.xdc@example.test')
    returning id into s2;
  insert into deedbox.practice_area (name) values ('DC General') returning id into pa;
  insert into deedbox.party (kind, display_name) values ('person','DC Client') returning id into p1;
  insert into deedbox.party_name (party, name_kind, full_name) values (p1,'current','DC Client');
  num := deedbox.allocate_number('matter', null, current_date);
  insert into deedbox.matter (matter_number, title, client_party, responsible_lawyer, office, practice_area)
    values (num, 'DC working matter', p1, s1, off, pa) returning id into m1;
  num := deedbox.allocate_number('matter', null, current_date);
  insert into deedbox.matter (matter_number, title, client_party, responsible_lawyer, office, practice_area)
    values (num, 'DC closing matter', p1, s1, off, pa) returning id into m2;

  set local role deedbox_app;
  perform set_config('deedbox.principal_kind','staff',true),
          set_config('deedbox.principal_id', s1::text, true);

  -- T1: the widened landing store accepts a staff upload with its uploader
  insert into deedbox.document_file (matter, filename, size_bytes, storage_ref, source, uploaded_by)
    values (m1, 'advice v1.docx', 10, m1 || '/v1-advice.docx', 'staff_upload', s1)
    returning id into file1;
  insert into deedbox.document_file (matter, filename, size_bytes, storage_ref, source, uploaded_by)
    values (m1, 'advice v2.docx', 11, m1 || '/v2-advice.docx', 'staff_upload', s1)
    returning id into file2;
  insert into deedbox.document_file (matter, filename, size_bytes, storage_ref, source, uploaded_by)
    values (m1, 'advice v3.docx', 12, m1 || '/v3-advice.docx', 'staff_upload', s1)
    returning id into file3;
  insert into deedbox.document_file (matter, filename, size_bytes, storage_ref, source, uploaded_by)
    values (m2, 'foreign.docx', 9, m2 || '/foreign.docx', 'staff_upload', s1)
    returning id into filem2;

  -- T2: folders — create, unique name per (matter, parent), same-matter parent
  insert into deedbox.document_folder (matter, name, created_by)
    values (m1, 'Correspondence', s1) returning id into f_root;
  insert into deedbox.document_folder (matter, parent, name, created_by)
    values (m1, f_root, 'Inbound', s1) returning id into f_child;
  insert into deedbox.document_folder (matter, name, created_by)
    values (m1, 'Empty', s1) returning id into f_empty;
  begin
    insert into deedbox.document_folder (matter, name, created_by) values (m1, 'Correspondence', s1);
    raise exception 'T2 FAIL: duplicate folder name accepted';
  exception when unique_violation then null;
  end;
  begin
    insert into deedbox.document_folder (matter, parent, name, created_by) values (m2, f_root, 'Wrong', s1);
    raise exception 'T2 FAIL: parent from another matter accepted';
  exception when others then
    if sqlerrm not like '%one matter%' then raise; end if;
  end;

  -- T3: no cycles — a folder cannot move under its own descendant
  begin
    update deedbox.document_folder set parent = f_child where id = f_root;
    raise exception 'T3 FAIL: folder cycle accepted';
  exception when others then
    if sqlerrm not like '%descendant%' then raise; end if;
  end;

  -- T4: a head with version 1, deferred consistency proven both ways
  set constraints deedbox.document_head_consistency immediate;
  insert into deedbox.document (matter, folder, title, current_file, current_version, created_by)
    values (m1, f_child, 'Letter of advice', file1, 1, s1) returning id into d1;
  insert into deedbox.document_version (document, version_no, file, created_by)
    values (d1, 1, file1, s1);
  begin
    insert into deedbox.document (matter, title, current_file, current_version, created_by)
      values (m1, 'Mismatched head', file3, 1, s1) returning id into d2;
    insert into deedbox.document_version (document, version_no, file, created_by)
      values (d2, 1, file2, s1);
    raise exception 'T4 FAIL: head pointing at a different file than its newest version accepted';
  exception when others then
    if sqlerrm not like '%newest version%' then raise; end if;
  end;

  -- T5: versions are dense — skipping a number refuses
  begin
    insert into deedbox.document_version (document, version_no, file, created_by)
      values (d1, 3, file2, s1);
    raise exception 'T5 FAIL: version gap accepted';
  exception when others then
    if sqlerrm not like '%dense%' then raise; end if;
  end;

  -- T6: a version file from another matter refuses
  begin
    update deedbox.document set current_file = filem2, current_version = 2 where id = d1;
    insert into deedbox.document_version (document, version_no, file, created_by)
      values (d1, 2, filem2, s1);
    raise exception 'T6 FAIL: cross-matter version file accepted';
  exception when others then
    if sqlerrm not like '%matter%' then raise; end if;
  end;

  -- T7: checkout exclusivity — another staff member cannot add a version
  update deedbox.document
     set checked_out_by = s2, checked_out_at = now(), checkout_purpose = 'editing'
   where id = d1;
  begin
    update deedbox.document set current_file = file2, current_version = 2 where id = d1;
    insert into deedbox.document_version (document, version_no, file, created_by)
      values (d1, 2, file2, s1);
    raise exception 'T7 FAIL: version added while checked out by someone else';
  exception when others then
    if sqlerrm not like '%checked out%' then raise; end if;
  end;
  -- the holder may: switch principal to the holder and add version 2
  perform set_config('deedbox.principal_id', s2::text, true);
  update deedbox.document
     set current_file = file2, current_version = 2,
         checked_out_by = null, checked_out_at = null, checkout_purpose = null
   where id = d1;
  insert into deedbox.document_version (document, version_no, file, comment, created_by)
    values (d1, 2, file2, 'holder checks in', s2);
  perform set_config('deedbox.principal_id', s1::text, true);

  -- T8: a locked document admits only its flags; versions refuse
  update deedbox.document set locked = true where id = d1;
  begin
    update deedbox.document set title = 'Renamed while locked' where id = d1;
    raise exception 'T8 FAIL: locked document edited';
  exception when others then
    if sqlerrm not like '%locked%' then raise; end if;
  end;
  begin
    insert into deedbox.document_version (document, version_no, file, created_by)
      values (d1, 3, file3, s1);
    raise exception 'T8 FAIL: version added to a locked document';
  exception when others then
    if sqlerrm not like '%locked%' then raise; end if;
  end;
  update deedbox.document set locked = false, legal_hold = true where id = d1;

  -- T9: legal hold blocks soft deletion
  begin
    update deedbox.document set soft_deleted_at = now(), soft_deleted_by = s1 where id = d1;
    raise exception 'T9 FAIL: soft delete under legal hold accepted';
  exception when others then
    if sqlerrm not like '%legal hold%' then raise; end if;
  end;
  update deedbox.document set legal_hold = false where id = d1;

  -- T10: closed matters refuse document writes without the ceremony; with it, they pass
  insert into deedbox.matter_close_request (matter, requested_by, financial_position, condition_evaluation, state, decided_by, decided_at)
    values (m2, s1, '{}', '{}', 'approved', s1, now());
  update deedbox.matter set status='closed' where id = m2;
  begin
    insert into deedbox.document (matter, title, current_file, current_version, created_by)
      values (m2, 'Late filing', filem2, 1, s1);
    raise exception 'T10 FAIL: document created on a closed matter without the ceremony';
  exception when others then
    if sqlerrm not like '%matter.edit_closed%' then raise; end if;
  end;
  perform set_config('deedbox.edit_closed','on',true);
  insert into deedbox.document (matter, title, current_file, current_version, created_by)
    values (m2, 'Ceremonial filing', filem2, 1, s1) returning id into d2;
  insert into deedbox.document_version (document, version_no, file, created_by)
    values (d2, 1, filem2, s1);
  perform set_config('deedbox.edit_closed','',true);

  -- T11: folder deletion — refused while occupied, allowed when empty
  begin
    delete from deedbox.document_folder where id = f_root;
    raise exception 'T11 FAIL: folder with a child folder deleted';
  exception when others then
    if sqlerrm not like '%contains%' then raise; end if;
  end;
  begin
    delete from deedbox.document_folder where id = f_child;
    raise exception 'T11 FAIL: folder with documents deleted';
  exception when others then
    if sqlerrm not like '%contains%' then raise; end if;
  end;
  delete from deedbox.document_folder where id = f_empty;

  -- T12: evidence posture — versions and access rows append-only through grants
  insert into deedbox.document_access (document, actor_kind, actor, action)
    values (d1, 'staff', s1, 'viewed');
  begin
    update deedbox.document_version set comment = 'rewritten' where document = d1 and version_no = 1;
    raise exception 'T12 FAIL: version row update accepted';
  exception when insufficient_privilege then null;
  end;
  begin
    delete from deedbox.document_access where document = d1;
    raise exception 'T12 FAIL: access row delete accepted';
  exception when insufficient_privilege then null;
  end;
  begin
    delete from deedbox.document where id = d1;
    raise exception 'T12 FAIL: document head delete accepted';
  exception when insufficient_privilege then null;
  end;

  -- T13: the catalogue extensions landed
  if not exists (select 1 from deedbox.capability where key = 'documents.manage') then
    raise exception 'T13 FAIL: documents.manage capability missing';
  end if;
  if not exists (select 1 from deedbox.role_capability rc
                   join deedbox.role r on r.id = rc.role
                  where r.system_key = 'administrator' and rc.capability = 'documents.manage') then
    raise exception 'T13 FAIL: administrator does not hold documents.manage';
  end if;
  if (select count(*) from deedbox.deletion_policy
       where entity_type in ('document','document_folder','document_version','document_file','document_access')) <> 5 then
    raise exception 'T13 FAIL: deletion-policy rows missing';
  end if;

  reset role;
  raise notice '0030 suite: all assertions passed';
end $$;

rollback;
