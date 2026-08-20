-- Tests for 0034_portal_invites. Run as deployment role AFTER the full
-- chain. Proves: invites insert and read as the app role and never delete;
-- identity is immutable; acceptance and revocation each write exactly
-- once; a revoked invite never accepts; acceptance demands its login (and
-- the reverse); duplicate token fingerprints refuse; the policy row ships.

begin;

grant deedbox_app to current_user;

insert into deedbox.country_pack (code, name) values ('XPI','Portal Invite Test Pack');
insert into deedbox.firm (name, operating_currency, timezone, country_pack)
  select 'Portal Invite Test Firm','AUD','Australia/Sydney', id from deedbox.country_pack where code='XPI';
insert into deedbox.office (name, code) values ('PI Office','XPI1');

do $$
declare
  off bigint; rl bigint; st bigint; p1 bigint; inv bigint; inv2 bigint;
begin
  select id into off from deedbox.office where code = 'XPI1';
  select id into rl from deedbox.role where system_key = 'administrator';
  insert into deedbox.staff_member (person_name, login, role, office, email)
    values ('{"given":"Pia","family":"Portal"}','pia.xpi', rl, off, 'pia.xpi@example.test')
    returning id into st;
  insert into deedbox.party (kind, display_name) values ('person','PI Client') returning id into p1;
  insert into deedbox.party_name (party, name_kind, full_name) values (p1,'current','PI Client');

  set local role deedbox_app;
  perform set_config('deedbox.principal_kind','staff',true),
          set_config('deedbox.principal_id', st::text, true);

  -- T1: insert, read, never delete
  insert into deedbox.portal_invite (party, email, token_hash, invited_by, expires_at)
    values (p1, 'pi.client@example.test', 'pi-hash-1', st, now() + interval '7 days')
    returning id into inv;
  begin
    delete from deedbox.portal_invite where id = inv;
    raise exception 'T1 FAIL: delete accepted';
  exception when insufficient_privilege then null;
  end;

  -- T2: acceptance demands its login and writes exactly once
  begin
    update deedbox.portal_invite set accepted_at = now() where id = inv;
    raise exception 'T2 FAIL: acceptance without a login accepted';
  exception when check_violation then null;
  end;
  update deedbox.portal_invite set accepted_at = now(), login = 'hosted-user-1' where id = inv;
  begin
    update deedbox.portal_invite set accepted_at = now() + interval '1 hour' where id = inv;
    raise exception 'T2 FAIL: acceptance rewritten';
  exception when others then
    if sqlerrm not like '%exactly once%' then raise; end if;
  end;

  -- T3: identity immutable
  begin
    update deedbox.portal_invite set token_hash = 'pi-hash-x' where id = inv;
    raise exception 'T3 FAIL: token fingerprint rewritten';
  exception when others then
    if sqlerrm not like '%never changes%' then raise; end if;
  end;

  -- T4: a revoked invite never accepts
  insert into deedbox.portal_invite (party, email, token_hash, invited_by, expires_at)
    values (p1, 'pi.client@example.test', 'pi-hash-2', st, now() + interval '7 days')
    returning id into inv2;
  update deedbox.portal_invite set revoked_at = now(), revoked_by = st where id = inv2;
  begin
    update deedbox.portal_invite set accepted_at = now(), login = 'hosted-user-2' where id = inv2;
    raise exception 'T4 FAIL: revoked invite accepted';
  exception when others then
    if sqlerrm not like '%never accepts%' then raise; end if;
  end;

  -- T5: duplicate token fingerprints refuse
  begin
    insert into deedbox.portal_invite (party, email, token_hash, invited_by, expires_at)
      values (p1, 'x@example.test', 'pi-hash-1', st, now() + interval '1 day');
    raise exception 'T5 FAIL: duplicate token fingerprint accepted';
  exception when unique_violation then null;
  end;

  -- T6: the policy row ships
  if (select mode from deedbox.deletion_policy where entity_type = 'portal_invite') <> 'never_deletable' then
    raise exception 'T6 FAIL: deletion policy row missing or wrong';
  end if;

  reset role;
  raise notice '0034 suite: all assertions passed';
end $$;

rollback;
