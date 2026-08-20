-- Tests for 0001_substrate_bedrock. Run as the deployment role AFTER 0001.
-- Every block raises on failure; a clean run prints only the final notice.

begin;

-- Fixture: a pack + firm (provisioning path).
insert into deedbox.country_pack (code, name) values ('AU-NSW','Australia (NSW)');
insert into deedbox.pack_version (pack, version)
  select id, '0.0.1' from deedbox.country_pack where code = 'AU-NSW';
update deedbox.country_pack cp
   set active_version = pv.id
  from deedbox.pack_version pv
 where pv.pack = cp.id and cp.code = 'AU-NSW';
insert into deedbox.firm (name, operating_currency, timezone, country_pack)
  select 'Test Firm','AUD','Australia/Sydney', id from deedbox.country_pack where code='AU-NSW';

do $$
declare v jsonb; f bigint; n bigint;
begin
  select id into f from deedbox.firm limit 1;

  ------------------------------------------------------------------
  -- 1. Settings: neutral default applies when no firm row exists.
  ------------------------------------------------------------------
  v := deedbox.current_setting_value('billing.default_terms_days');
  if v::text <> '14' then raise exception 'T1 neutral default: expected 14, got %', v; end if;

  -- 2. The block default on the held-funds close condition.
  v := deedbox.current_setting_value('matter.close_condition_held_funds');
  if v::text <> '"block"' then raise exception 'T2 held-funds default: expected block, got %', v; end if;

  -- 3. Firm value supersedes; history preserved; latest-effective read.
  insert into deedbox.firm_setting (definition, value, effective_from)
    select id, '30'::jsonb, now() - interval '1 day' from deedbox.setting_definition where key='billing.default_terms_days';
  insert into deedbox.firm_setting (definition, value, effective_from)
    select id, '21'::jsonb, now() - interval '1 hour' from deedbox.setting_definition where key='billing.default_terms_days';
  v := deedbox.current_setting_value('billing.default_terms_days');
  if v::text <> '21' then raise exception 'T3 latest-effective: expected 21, got %', v; end if;

  -- 4. A scheduled (future) row does not govern yet.
  insert into deedbox.firm_setting (definition, value, effective_from)
    select id, '7'::jsonb, now() + interval '1 day' from deedbox.setting_definition where key='billing.default_terms_days';
  v := deedbox.current_setting_value('billing.default_terms_days');
  if v::text <> '21' then raise exception 'T4 future row governs early: got %', v; end if;

  -- 5. firm_setting is append-only.
  begin
    update deedbox.firm_setting set value = '99'::jsonb where true;
    raise exception 'T5 firm_setting update was permitted';
  exception when others then
    if sqlerrm not like '%append-only%' then raise; end if;
  end;
  begin
    delete from deedbox.firm_setting where true;
    raise exception 'T5b firm_setting delete was permitted';
  exception when others then
    if sqlerrm not like '%append-only%' then raise; end if;
  end;

  ------------------------------------------------------------------
  -- 6. Register: ordinary write chains correctly.
  ------------------------------------------------------------------
  insert into deedbox.register_entry (firm, actor_kind, event_kind, subject_type, subject, detail)
    values (f, 'system_job', 'record.created', 'firm', f, '{"changed":["name"]}');
  insert into deedbox.register_entry (firm, actor_kind, event_kind, subject_type, subject)
    values (f, 'system_job', 'record.changed', 'firm', f);
  select count(*) into n from deedbox.register_entry where firm = f;
  if n <> 2 then raise exception 'T6 expected 2 entries, got %', n; end if;
  if deedbox.register_verify_chain(f) <> 0 then
    raise exception 'T6b chain broken on honest writes';
  end if;

  -- 7. The register is append-only even for the deployment role.
  begin
    update deedbox.register_entry set reason = 'tamper' where firm = f;
    raise exception 'T7 register update was permitted';
  exception when others then
    if sqlerrm not like '%append-only%' then raise; end if;
  end;
  begin
    delete from deedbox.register_entry where firm = f;
    raise exception 'T7b register delete was permitted';
  exception when others then
    if sqlerrm not like '%append-only%' then raise; end if;
  end;

  -- 8. A privileged event without before/after is physically refused.
  begin
    insert into deedbox.register_entry (firm, actor_kind, event_kind, subject_type, subject, detail)
      values (f, 'staff', 'restriction.changed', 'matter', 1, '{"note":"missing before/after"}');
    raise exception 'T8 privileged write without before/after was permitted';
  exception when others then
    if sqlerrm not like '%privileged register write refused%' then raise; end if;
  end;

  -- 9. With before/after (and, since 0003, the required reason) it lands,
  -- flagged privileged.
  insert into deedbox.register_entry (firm, actor_kind, event_kind, subject_type, subject, detail, reason)
    values (f, 'staff', 'restriction.changed', 'matter', 1,
            '{"before":{"grants":[]},"after":{"grants":[7]}}', 'restriction granted');
  select count(*) into n from deedbox.register_entry where firm = f and privileged;
  if n <> 1 then raise exception 'T9 privileged flag not set'; end if;

  -- 10. Unknown event kinds are refused (closed catalogue).
  begin
    insert into deedbox.register_entry (firm, actor_kind, event_kind, subject_type, subject)
      values (f, 'staff', 'made.up_kind', 'firm', f);
    raise exception 'T10 unknown event kind was permitted';
  exception when foreign_key_violation then null;
  end;

  -- 11. Chain still verifies after all of the above.
  if deedbox.register_verify_chain(f) <> 0 then
    raise exception 'T11 chain verification failed';
  end if;

  ------------------------------------------------------------------
  -- 12. Firm guards: currency immutable, delete refused.
  ------------------------------------------------------------------
  begin
    update deedbox.firm set operating_currency = 'USD' where id = f;
    raise exception 'T12 currency change was permitted';
  exception when others then
    if sqlerrm not like '%immutable%' then raise; end if;
  end;
  begin
    delete from deedbox.firm where id = f;
    raise exception 'T12b firm delete was permitted';
  exception when others then
    if sqlerrm not like '%never deleted%' then raise; end if;
  end;

  raise notice 'ALL 0001 SUBSTRATE TESTS PASSED';
end $$;

rollback;  -- tests leave no data behind

------------------------------------------------------------------------------
-- App-role privilege posture (outside the rolled-back block; read-only checks).
------------------------------------------------------------------------------
do $$
begin
  -- deedbox_app must NOT hold update or delete on the evidential tables.
  if exists (
    select 1 from information_schema.role_table_grants
    where grantee = 'deedbox_app'
      and table_schema = 'deedbox'
      and table_name in ('register_entry','firm_setting','register_chain_head')
      and privilege_type in ('UPDATE','DELETE','TRUNCATE')
  ) then
    raise exception 'P1 deedbox_app holds a forbidden privilege on an evidential table';
  end if;
  -- and must not touch the chain head at all.
  if exists (
    select 1 from information_schema.role_table_grants
    where grantee = 'deedbox_app'
      and table_schema = 'deedbox'
      and table_name = 'register_chain_head'
  ) then
    raise exception 'P2 deedbox_app can reach the chain head directly';
  end if;
  raise notice 'APP-ROLE PRIVILEGE POSTURE VERIFIED';
end $$;
