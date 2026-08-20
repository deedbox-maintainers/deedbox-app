-- Tests for 0031_document_templates. Run as deployment role AFTER the full
-- chain. Proves: the app role inserts, reads and updates template rows but
-- cannot remove them (soft delete only, through grants); shape checks
-- (empty name, zero bytes, duplicate storage_ref) refuse; a deleted
-- template cannot remain (or become) active; the deletion-policy row ships.

begin;

grant deedbox_app to current_user;

insert into deedbox.country_pack (code, name) values ('XDT','Document Template Test Pack');
insert into deedbox.firm (name, operating_currency, timezone, country_pack)
  select 'Document Template Test Firm','AUD','Australia/Sydney', id from deedbox.country_pack where code='XDT';
insert into deedbox.office (name, code) values ('DT Office','XDT1');

do $$
declare
  off bigint; rl bigint; st bigint; t1 bigint;
begin
  select id into off from deedbox.office where code = 'XDT1';
  select id into rl from deedbox.role where system_key = 'administrator';
  insert into deedbox.staff_member (person_name, login, role, office, email)
    values ('{"given":"Tess","family":"Templates"}','tess.xdt', rl, off, 'tess.xdt@example.test')
    returning id into st;

  set local role deedbox_app;
  perform set_config('deedbox.principal_kind','staff',true),
          set_config('deedbox.principal_id', st::text, true);

  -- T1: insert, read, activate
  insert into deedbox.document_template (name, filename, storage_ref, size_bytes, created_by)
    values ('Engagement letter', 'engagement.docx', 'templates/xdt-engagement.docx', 10, st)
    returning id into t1;
  update deedbox.document_template set active = true, updated_by = st where id = t1;
  if not (select active from deedbox.document_template where id = t1) then
    raise exception 'T1 FAIL: activation not readable';
  end if;

  -- T2: shape refusals
  begin
    insert into deedbox.document_template (name, filename, storage_ref, size_bytes, created_by)
      values ('', 'x.docx', 'templates/xdt-a.docx', 10, st);
    raise exception 'T2 FAIL: empty name accepted';
  exception when check_violation then null;
  end;
  begin
    insert into deedbox.document_template (name, filename, storage_ref, size_bytes, created_by)
      values ('Zero bytes', 'x.docx', 'templates/xdt-b.docx', 0, st);
    raise exception 'T2 FAIL: zero-byte template accepted';
  exception when check_violation then null;
  end;
  begin
    insert into deedbox.document_template (name, filename, storage_ref, size_bytes, created_by)
      values ('Duplicate ref', 'x.docx', 'templates/xdt-engagement.docx', 10, st);
    raise exception 'T2 FAIL: duplicate storage reference accepted';
  exception when unique_violation then null;
  end;

  -- T3: a deleted template cannot remain active
  begin
    update deedbox.document_template
       set soft_deleted_at = now(), soft_deleted_by = st where id = t1;
    raise exception 'T3 FAIL: deletion accepted while active';
  exception when others then
    if sqlerrm not like '%cannot remain active%' then raise; end if;
  end;
  update deedbox.document_template
     set active = false, soft_deleted_at = now(), soft_deleted_by = st where id = t1;
  begin
    update deedbox.document_template set active = true where id = t1;
    raise exception 'T3 FAIL: deleted template re-activated';
  exception when others then
    if sqlerrm not like '%cannot remain active%' then raise; end if;
  end;

  -- T4: the app role cannot remove a template row (soft delete only)
  begin
    delete from deedbox.document_template where id = t1;
    raise exception 'T4 FAIL: delete was accepted';
  exception when insufficient_privilege then null;
  end;

  -- T5: the deletion-policy row ships
  if (select mode from deedbox.deletion_policy where entity_type = 'document_template') <> 'soft_delete' then
    raise exception 'T5 FAIL: deletion policy row missing or wrong';
  end if;

  reset role;
  raise notice '0031 suite: all assertions passed';
end $$;

rollback;
