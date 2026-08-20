-- Tests for 0032_sharing_esign. Run as deployment role AFTER the full
-- chain. Proves: share and signing rows insert and read as the app role
-- and never delete (evidence posture); the signing machine is forward-only
-- with settled requests frozen and identity immutable; the signed state
-- demands its evidence fields; the widened actor and source vocabularies
-- accept the new values; the deletion-policy rows ship.

begin;

grant deedbox_app to current_user;

insert into deedbox.country_pack (code, name) values ('XES','E-Sign Test Pack');
insert into deedbox.firm (name, operating_currency, timezone, country_pack)
  select 'E-Sign Test Firm','AUD','Australia/Sydney', id from deedbox.country_pack where code='XES';
insert into deedbox.office (name, code) values ('ES Office','XES1');

do $$
declare
  off bigint; rl bigint; st bigint; pa bigint; p1 bigint; m bigint; num text;
  f1 bigint; f2 bigint; d1 bigint; d2 bigint; sh bigint; sr bigint;
begin
  select id into off from deedbox.office where code = 'XES1';
  select id into rl from deedbox.role where system_key = 'administrator';
  insert into deedbox.staff_member (person_name, login, role, office, email)
    values ('{"given":"Eve","family":"Sign"}','eve.xes', rl, off, 'eve.xes@example.test')
    returning id into st;
  insert into deedbox.practice_area (name) values ('ES General') returning id into pa;
  insert into deedbox.party (kind, display_name) values ('person','ES Client') returning id into p1;
  insert into deedbox.party_name (party, name_kind, full_name) values (p1,'current','ES Client');
  num := deedbox.allocate_number('matter', null, current_date);
  insert into deedbox.matter (matter_number, title, client_party, responsible_lawyer, office, practice_area)
    values (num, 'ES matter', p1, st, off, pa) returning id into m;

  set local role deedbox_app;
  perform set_config('deedbox.principal_kind','staff',true),
          set_config('deedbox.principal_id', st::text, true);

  set constraints deedbox.document_head_consistency immediate;
  insert into deedbox.document_file (matter, filename, size_bytes, storage_ref, source, uploaded_by)
    values (m, 'contract.pdf', 9, m || '/es-contract.pdf', 'staff_upload', st) returning id into f1;
  insert into deedbox.document (matter, title, current_file, current_version, created_by)
    values (m, 'Contract', f1, 1, st) returning id into d1;
  insert into deedbox.document_version (document, version_no, file, created_by)
    values (d1, 1, f1, st);
  select id into d2 from deedbox.document_version where document = d1 and version_no = 1;

  -- T1: a share row inserts, reads, and the app role cannot delete it
  insert into deedbox.document_share (document, version, token_hash, expires_at, created_by)
    values (d1, d2, 'es-share-hash-1', now() + interval '7 days', st) returning id into sh;
  update deedbox.document_share set view_count = view_count + 1 where id = sh;
  begin
    delete from deedbox.document_share where id = sh;
    raise exception 'T1 FAIL: share delete accepted';
  exception when insufficient_privilege then null;
  end;

  -- T2: the widened access vocabulary accepts the outside actors
  insert into deedbox.document_access (document, actor_kind, actor, action)
    values (d1, 'share_recipient', sh, 'viewed');
  begin
    insert into deedbox.document_access (document, actor_kind, actor, action)
      values (d1, 'somebody_else', sh, 'viewed');
    raise exception 'T2 FAIL: unknown actor kind accepted';
  exception when check_violation then null;
  end;

  -- T3: the signing machine — forward-only, settled frozen, identity immutable
  insert into deedbox.document_signing_request
      (document, version, signer_name, signer_email, token_hash, expires_at, created_by)
    values (d1, d2, 'ES Client', 'es.client@example.test', 'es-sign-hash-1', now() + interval '7 days', st)
    returning id into sr;
  -- signed without its evidence refuses (check constraint)
  begin
    update deedbox.document_signing_request set status = 'signed' where id = sr;
    raise exception 'T3 FAIL: signed without evidence accepted';
  exception when check_violation then null;
  end;
  -- the stamped copy document (source signing — the widened vocabulary)
  insert into deedbox.document_file (matter, filename, size_bytes, storage_ref, source, uploaded_by)
    values (m, 'SIGNED-contract.pdf', 12, m || '/es-signed.pdf', 'signing', st) returning id into f2;
  insert into deedbox.document (matter, title, current_file, current_version, created_by)
    values (m, 'SIGNED - Contract', f2, 1, st) returning id into d2;
  insert into deedbox.document_version (document, version_no, file, created_by)
    values (d2, 1, f2, st);
  update deedbox.document_signing_request
     set status = 'signed', signed_at = now(), signature_data = 'data:image/png;base64,x',
         signer_ip = '203.0.113.9', signer_user_agent = 'suite', signed_document = d2
   where id = sr;
  -- settled requests never change
  begin
    update deedbox.document_signing_request set signer_user_agent = 'rewritten' where id = sr;
    raise exception 'T3 FAIL: settled request edited';
  exception when others then
    if sqlerrm not like '%never changes%' then raise; end if;
  end;
  begin
    update deedbox.document_signing_request set status = 'revoked', revoked_at = now(), revoked_by = st where id = sr;
    raise exception 'T3 FAIL: signed request revoked';
  exception when others then
    if sqlerrm not like '%pending to signed or revoked%' then raise; end if;
  end;
  begin
    delete from deedbox.document_signing_request where id = sr;
    raise exception 'T3 FAIL: signing request delete accepted';
  exception when insufficient_privilege then null;
  end;

  -- T4: duplicate token fingerprints refuse
  begin
    insert into deedbox.document_share (document, version, token_hash, expires_at, created_by)
      values (d1, (select id from deedbox.document_version where document = d1 and version_no = 1),
              'es-share-hash-1', now() + interval '1 day', st);
    raise exception 'T4 FAIL: duplicate share token hash accepted';
  exception when unique_violation then null;
  end;

  -- T5: the deletion-policy rows ship
  if (select count(*) from deedbox.deletion_policy
       where entity_type in ('document_share','document_signing_request')
         and mode = 'never_deletable') <> 2 then
    raise exception 'T5 FAIL: deletion-policy rows missing';
  end if;

  reset role;
  raise notice '0032 suite: all assertions passed';
end $$;

rollback;
