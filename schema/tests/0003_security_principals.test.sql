-- Tests for 0003_security_principals. Run as deployment role AFTER 0001–0003.

begin;

insert into deedbox.country_pack (code, name) values ('AU-NSW','Australia (NSW)');
insert into deedbox.pack_version (pack, version)
  select id, '0.0.1' from deedbox.country_pack where code='AU-NSW';
update deedbox.country_pack cp set active_version = pv.id
  from deedbox.pack_version pv where pv.pack = cp.id;
insert into deedbox.firm (name, operating_currency, timezone, country_pack)
  select 'Test Firm','AUD','Australia/Sydney', id from deedbox.country_pack;
insert into deedbox.office (name, code) values ('Sydney','SYD');

do $$
declare f bigint; n bigint; r_admin bigint; r_portal bigint; r_lawyer bigint;
        s1 bigint; s2 bigint; d1 bigint; sess bigint; o bigint;
begin
  select id into f from deedbox.firm limit 1;
  select id into o from deedbox.office limit 1;
  select id into r_admin from deedbox.role where system_key='administrator';
  select id into r_portal from deedbox.role where system_key='portal_client';
  select id into r_lawyer from deedbox.role where system_key='lawyer';

  -- 1. The capability catalogue ships exactly 52 keys with correct metadata
  --    (47 + documents.manage from 0030 + assistant.manage from 0036 +
  --    gl.manage from 0037 + time.record_for_others from 0053 +
  --    matter.see_all_offices from 0054 — the full-chain amendment precedent).
  select count(*) into n from deedbox.capability;
  if n <> 52 then raise exception 'C1 expected 52 capabilities, got %', n; end if;
  select count(*) into n from deedbox.capability where money_authorisation;
  if n <> 6 then raise exception 'C2 expected 6 money-authorisation keys, got %', n; end if;
  select count(*) into n from deedbox.capability where admin_floor;
  if n <> 2 then raise exception 'C3 expected 2 admin-floor keys, got %', n; end if;
  select count(*) into n from deedbox.capability where external_role_permitted;
  if n <> 0 then raise exception 'C4 no shipped key may be external-permitted'; end if;

  -- 2. Safe bounds: external roles never receive capabilities.
  begin
    insert into deedbox.role_capability (role, capability) values (r_portal, 'conflict.run');
    raise exception 'S1 external role received a capability';
  exception when others then
    if sqlerrm not like '%external roles%' then raise; end if;
  end;

  -- 3. Money-authorisation rows require the explicit grant flag.
  begin
    insert into deedbox.role_capability (role, capability) values (r_lawyer, 'money.receive');
    raise exception 'S2 money capability granted without the explicit operation';
  exception when others then
    if sqlerrm not like '%explicit grant operation%' then raise; end if;
  end;
  perform set_config('deedbox.explicit_money_grant','on', true);
  insert into deedbox.role_capability (role, capability) values (r_lawyer, 'money.receive');
  perform set_config('deedbox.explicit_money_grant','off', true);
  delete from deedbox.role_capability where role = r_lawyer and capability = 'money.receive';

  -- 4. The administrator floor cannot be stripped.
  begin
    delete from deedbox.role_capability where role = r_admin and capability = 'register.read';
    raise exception 'S3 admin floor stripped';
  exception when others then
    if sqlerrm not like '%may never lose%' then raise; end if;
  end;

  -- 5. Shipped roles cannot be deactivated; system_key immutable.
  begin
    update deedbox.role set active = false where id = r_admin;
    raise exception 'S4 shipped role deactivated';
  exception when others then
    if sqlerrm not like '%cannot be deactivated%' then raise; end if;
  end;

  -- 6. Staff: unique login (case-folded); one role per person by shape.
  insert into deedbox.staff_member (person_name, login, role, office, email)
    values ('{"display":"Alice Admin"}','alice', r_admin, o, 'alice@example.test')
    returning id into s1;
  begin
    insert into deedbox.staff_member (person_name, login, role, office, email)
      values ('{"display":"Alice Two"}','ALICE', r_admin, o, 'a2@example.test');
    raise exception 'S5 duplicate login accepted';
  exception when unique_violation then null;
  end;

  -- 7. The last active administrator cannot be deactivated; deactivation ends sessions.
  begin
    update deedbox.staff_member set active = false where id = s1;
    raise exception 'S6 last administrator deactivated';
  exception when others then
    if sqlerrm not like '%last active administrator%' then raise; end if;
  end;
  insert into deedbox.staff_member (person_name, login, role, office, email)
    values ('{"display":"Bob Admin"}','bob', r_admin, o, 'bob@example.test')
    returning id into s2;
  insert into deedbox.device (owner_kind, owner, fingerprint) values ('staff', s2, 'fp-1')
    returning id into d1;
  insert into deedbox.session (principal_kind, principal, device) values ('staff', s2, d1)
    returning id into sess;
  update deedbox.staff_member set active = false where id = s2;
  if not exists (select 1 from deedbox.session
                  where id = sess and ended_at is not null and end_reason = 'deactivation') then
    raise exception 'S7 deactivation did not end the session in-transaction';
  end if;

  -- 8. Sessions are terminal once ended; never deletable.
  begin
    update deedbox.session set last_seen_at = now() where id = sess;
    raise exception 'S8 ended session mutated';
  exception when others then
    if sqlerrm not like '%terminal%' then raise; end if;
  end;
  begin
    delete from deedbox.session where id = sess;
    raise exception 'S8b session deleted';
  exception when others then
    if sqlerrm not like '%never deleted%' then raise; end if;
  end;

  -- 9. MFA mirror maintains staff.mfa_enrolled in the same transaction.
  insert into deedbox.mfa_credential (staff, factor_kind, secret_ref)
    values (s1, 'totp', 'vault://k1');
  if not (select mfa_enrolled from deedbox.staff_member where id = s1) then
    raise exception 'S9 mfa_enrolled mirror not set';
  end if;
  update deedbox.mfa_credential set revoked_at = now(), revoked_by = s1 where staff = s1;
  if (select mfa_enrolled from deedbox.staff_member where id = s1) then
    raise exception 'S9b mfa_enrolled mirror not cleared on revocation';
  end if;

  -- 10. Register catalogue hardening: reason and privileged rules enforced.
  begin
    insert into deedbox.register_entry (firm, actor_kind, event_kind, subject_type, subject, detail)
      values (f, 'staff', 'examiner.revoked', 'examiner_grant', 1,
              '{"before":{"active":true},"after":{"active":false}}');
    raise exception 'R1 reason-required kind accepted without a reason';
  exception when others then
    if sqlerrm not like '%requires a reason%' then raise; end if;
  end;
  insert into deedbox.register_entry (firm, actor_kind, event_kind, subject_type, subject, detail, reason)
    values (f, 'staff', 'examiner.revoked', 'examiner_grant', 1,
            '{"before":{"active":true},"after":{"active":false}}', 'engagement ended early');
  begin
    insert into deedbox.register_entry (firm, actor_kind, event_kind, subject_type, subject)
      values (f, 'staff', 'restricted.read', 'matter_ledger', 1);
    raise exception 'R2 matter-link-required kind accepted without a matter';
  exception when others then
    if sqlerrm not like '%requires a matter link%' then raise; end if;
  end;
  if deedbox.register_verify_chain(f) <> 0 then
    raise exception 'R3 chain broken';
  end if;

  -- 11. Examiner grant shape constraints.
  begin
    insert into deedbox.examiner_grant
      (examiner_name, login, secret_hash, period_start, period_end, starts_at, expires_at, granted_by)
    values ('Eve Examiner','eve','h', '2026-01-01','2026-06-30', now(), now() - interval '1 hour', s1);
    raise exception 'X1 expires-before-starts accepted';
  exception when check_violation then null;
  end;

  -- 12. Anomaly rules seeded (0003's four + 0027's chain_break) and alerts
  -- undeletable. Amended by 0027, which seeds the fifth rule — the chain
  -- verifier's alert category (suites run against the full chain).
  select count(*) into n from deedbox.anomaly_rule;
  if n <> 5 then raise exception 'A1 expected 5 anomaly rules, got %', n; end if;
  if not exists (select 1 from deedbox.anomaly_rule where key = 'chain_break') then
    raise exception 'A1 the fifth rule is not chain_break';
  end if;

  raise notice 'ALL 0003 SECURITY-PRINCIPALS TESTS PASSED';
end $$;

rollback;
