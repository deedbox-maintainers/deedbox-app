-- Tests for 0017_import_interface. Run as deployment role AFTER 0001–0017.

begin;

insert into deedbox.country_pack (code, name) values ('AU-NSW','Australia (NSW)');
insert into deedbox.pack_version (pack, version) select id, '0.0.1' from deedbox.country_pack;
update deedbox.country_pack cp set active_version = pv.id from deedbox.pack_version pv where pv.pack = cp.id;
insert into deedbox.firm (name, operating_currency, timezone, country_pack)
  select 'Test Firm','AUD','Australia/Sydney', id from deedbox.country_pack;
insert into deedbox.office (name, code) values ('Sydney','SYD');

do $$
declare o bigint; r_admin bigint; r_lawyer bigint; s_admin bigint; s_law bigint;
        p1 bigint; pa bigint; m1 bigint; tpl bigint; seq bigint; h6a bigint; h6b bigint;
        mig bigint; map1 bigint; bat bigint; ik bigint; sub bigint;
begin
  select id into o from deedbox.office limit 1;
  select id into r_admin from deedbox.role where system_key='administrator';
  select id into r_lawyer from deedbox.role where system_key='lawyer';
  insert into deedbox.staff_member (person_name, login, role, office, email)
    values ('{"display":"Ada Admin"}','ada', r_admin, o, 'ada@x.test') returning id into s_admin;
  insert into deedbox.staff_member (person_name, login, role, office, email)
    values ('{"display":"Lee Lawyer"}','lee', r_lawyer, o, 'lee@x.test') returning id into s_law;
  insert into deedbox.party (kind, display_name) values ('person','Cli') returning id into p1;
  insert into deedbox.party_name (party, name_kind, full_name) values (p1,'current','Cli');
  insert into deedbox.practice_area (name) values ('Litigation') returning id into pa;
  insert into deedbox.matter (matter_number, title, client_party, responsible_lawyer, office, practice_area)
    values (deedbox.allocate_number('matter', null, current_date), 'Interface host', p1, s_law, o, pa) returning id into m1;

  ------------------------------------------------------------------
  -- 1. Templates: channel discipline; pack rows read-only.
  ------------------------------------------------------------------
  insert into deedbox.message_template (name, channel, purpose, body, tokens_used)
    values ('First reminder', 'email', 'reminder_step', 'Dear {client_name}, bill {bill_number}...', '["client_name","bill_number"]')
    returning id into tpl;
  insert into deedbox.reminder_sequence (name) values ('Seq A') returning id into seq;
  begin
    insert into deedbox.reminder_step (sequence, step_no, days_after_previous, channel, template)
      values (seq, 1, 7, 'text_message', tpl);
    raise exception 'step channel mismatched its template';
  exception when others then
    if sqlerrm not like '%match its channel%' then raise; end if;
  end;
  insert into deedbox.reminder_step (sequence, step_no, days_after_previous, channel, template)
    values (seq, 1, 7, 'email', tpl);
  insert into deedbox.message_template (name, channel, purpose, body, tokens_used, pack_version)
    select 'Pack letter', 'email', 'statement_cover', '...', '[]', cp.active_version from deedbox.country_pack cp;
  begin
    update deedbox.message_template set body='firm edit' where name='Pack letter';
    raise exception 'pack template edited by the firm';
  exception when others then
    if sqlerrm not like '%read-only to firms%' then raise; end if;
  end;

  ------------------------------------------------------------------
  -- 2. Slot re-resolution proposals: freshest-only-pending.
  ------------------------------------------------------------------
  insert into deedbox.slot_reresolution_proposal (matter, trigger_facts, items)
    values (m1, '{"old":"lee"}', '[]') returning id into h6a;
  insert into deedbox.slot_reresolution_proposal (matter, trigger_facts, items)
    values (m1, '{"old":"lee","new":"ada"}', '[]') returning id into h6b;
  if (select state from deedbox.slot_reresolution_proposal where id = h6a) <> 'superseded' then
    raise exception 'stale proposal not superseded';
  end if;
  update deedbox.slot_reresolution_proposal set state='confirmed', decided_by=s_admin, decided_at=now() where id = h6b;
  begin
    update deedbox.slot_reresolution_proposal set state='rejected' where id = h6b;
    raise exception 'decided proposal mutated';
  exception when others then
    if sqlerrm not like '%immutable%' then raise; end if;
  end;

  ------------------------------------------------------------------
  -- 3. Imports: read-only product mappings; the batch machine; the
  --    itemised, append-only record and reference layers.
  ------------------------------------------------------------------
  insert into deedbox.mapping_template (source_format_key, record_type, field_map, origin, name)
    values ('csv_generic', 'clients', '{}', 'product', 'Generic clients') returning id into map1;
  begin
    update deedbox.mapping_template set field_map='{"x":1}' where id = map1;
    raise exception 'product mapping edited';
  exception when others then
    if sqlerrm not like '%read-only to firms%' then raise; end if;
  end;
  insert into deedbox.migration (source_system) values ('OldSystem') returning id into mig;
  insert into deedbox.import_batch (migration, mapping, record_domain, mode, source_system)
    values (mig, map1, 'clients', 'real', 'OldSystem') returning id into bat;
  begin
    update deedbox.import_batch set state='reversed' where id = bat;
    raise exception 'running batch jumped to reversed';
  exception when others then
    if sqlerrm not like '%illegal import-batch transition%' then raise; end if;
  end;
  update deedbox.import_batch
     set state='completed', report_artefact='artefact:imp1', counts='{"accepted":2}', finished_at=now()
   where id = bat;
  begin
    update deedbox.import_batch set counts='{"accepted":99}' where id = bat;
    raise exception 'finished report rewritten';
  exception when others then
    if sqlerrm not like '%immutable%' then raise; end if;
  end;
  insert into deedbox.import_record (batch, source_ref, disposition, target_type, target)
    values (bat, 'ROW-1', 'accepted', 'party', p1);
  begin
    insert into deedbox.import_record (batch, source_ref, disposition)
      values (bat, 'ROW-1', 'refused');
    raise exception 'duplicate source ref in one batch';
  exception when others then
    if sqlerrm not like '%duplicate key%' then raise; end if;
  end;
  insert into deedbox.source_reference (source_system, source_ref, target_type, target)
    values ('OldSystem', 'ROW-1', 'party', p1);
  begin
    insert into deedbox.source_reference (source_system, source_ref, target_type, target)
      values ('OldSystem', 'ROW-1', 'party', p1);
    raise exception 'duplicate source reference';
  exception when others then
    if sqlerrm not like '%duplicate key%' then raise; end if;
  end;

  ------------------------------------------------------------------
  -- 4. Integration keys and the structurally idempotent log.
  ------------------------------------------------------------------
  insert into deedbox.integration_key (label, secret_hash, issued_by, key_display)
    values ('Website form', 'hash:abc', s_admin, 'IK-TEST01') returning id into ik;
  begin
    update deedbox.integration_key set secret_hash='hash:new' where id = ik;
    raise exception 'key secret rewritten';
  exception when others then
    if sqlerrm not like '%identity is immutable%' then raise; end if;
  end;
  insert into deedbox.inbound_submission (key, idempotency_key, payload_version, payload_verbatim, outcome, created_type, created, acknowledgement, test)
    values (ik, 'req-1', '1', '{"about":"fence"}', 'created', 'intake_record', 1, '{"id":1}', false)
    returning id into sub;
  begin
    insert into deedbox.inbound_submission (key, idempotency_key, payload_version, payload_verbatim, outcome, acknowledgement, test)
      values (ik, 'req-1', '1', '{"about":"fence"}', 'created', '{"id":1}', false);
    raise exception 'duplicate creation for one idempotency key';
  exception when others then
    if sqlerrm not like '%duplicate key%' then raise; end if;
  end;
  insert into deedbox.inbound_submission (key, idempotency_key, payload_version, payload_verbatim, outcome, acknowledgement, original, test)
    values (ik, 'req-1', '1', '{"about":"fence"}', 'duplicate_replayed', '{"id":1}', sub, false);
  begin
    update deedbox.inbound_submission set acknowledgement='{"id":2}' where id = sub;
    raise exception 'submission log rewritten';
  exception when others then
    if sqlerrm not like '%append-only%' then raise; end if;
  end;
  update deedbox.integration_key set revoked_at=now() where id = ik;
  begin
    update deedbox.integration_key set label='zombie' where id = ik;
    raise exception 'revoked key mutated';
  exception when others then
    if sqlerrm not like '%revoked key is immutable%' then raise; end if;
  end;

  raise notice 'ALL 0017 IMPORT-INTERFACE TESTS PASSED';
end $$;

rollback;
