-- Tests for 0006_matters_completion. Run as deployment role AFTER 0001–0006.

begin;

insert into deedbox.country_pack (code, name) values ('AU-NSW','Australia (NSW)');
insert into deedbox.pack_version (pack, version) select id, '0.0.1' from deedbox.country_pack;
update deedbox.country_pack cp set active_version = pv.id from deedbox.pack_version pv where pv.pack = cp.id;
insert into deedbox.firm (name, operating_currency, timezone, country_pack)
  select 'Test Firm','AUD','Australia/Sydney', id from deedbox.country_pack;
insert into deedbox.office (name, code) values ('Sydney','SYD');

do $$
declare o bigint; r_admin bigint; r_lawyer bigint; s_admin bigint; s_law bigint;
        p1 bigint; p2 bigint; pa bigint; pa2 bigint; m1 bigint; m2 bigint; m3 bigint;
        ir bigint; ir2 bigint; st1 bigint; cr bigint; n1 bigint; rel bigint;
        lbl bigint; cap_client bigint; cap_witness bigint; cnt int; txt text;
begin
  select id into o from deedbox.office limit 1;
  select id into r_admin from deedbox.role where system_key='administrator';
  select id into r_lawyer from deedbox.role where system_key='lawyer';
  insert into deedbox.staff_member (person_name, login, role, office, email)
    values ('{"display":"Ada Admin"}','ada', r_admin, o, 'ada@x.test') returning id into s_admin;
  insert into deedbox.staff_member (person_name, login, role, office, email)
    values ('{"display":"Lee Lawyer"}','lee', r_lawyer, o, 'lee@x.test') returning id into s_law;

  insert into deedbox.party (kind, display_name) values ('person','Cli One') returning id into p1;
  insert into deedbox.party_name (party, name_kind, full_name) values (p1,'current','Cli One');
  insert into deedbox.party (kind, display_name) values ('person','Cli Two') returning id into p2;
  insert into deedbox.party_name (party, name_kind, full_name) values (p2,'current','Cli Two');
  insert into deedbox.practice_area (name) values ('Litigation') returning id into pa;
  insert into deedbox.practice_area (name) values ('Conveyancing-Style Work') returning id into pa2;

  select ci.id into cap_client from deedbox.choice_item ci
    join deedbox.choice_list cl on cl.id = ci.list
   where cl.purpose_key='matter_party_capacities' and ci.shipped_key='client';
  select ci.id into cap_witness from deedbox.choice_item ci
    join deedbox.choice_list cl on cl.id = ci.list
   where cl.purpose_key='matter_party_capacities' and ci.shipped_key='witness';

  ------------------------------------------------------------------
  -- 1. Matters are born open; creation writes the corpus and the
  --    automatic client matter-party row.
  ------------------------------------------------------------------
  begin
    insert into deedbox.matter (matter_number, title, client_party, responsible_lawyer, office, practice_area, status, closed_date)
      values ('X-BAD', 'Born closed', p1, s_law, o, pa, 'closed', current_date);
    raise exception 'a matter was created closed';
  exception when others then
    if sqlerrm not like '%created open%' then raise; end if;
  end;

  insert into deedbox.matter (matter_number, title, client_party, responsible_lawyer, office, practice_area, summary, origin_note)
    values (deedbox.allocate_number('matter', null, current_date),
            'Corpus matter', p1, s_law, o, pa, 'A summary.', 'Walked in.') returning id into m1;
  if (select count(*) from deedbox.registered_text rt
       where rt.source_module='core' and rt.source_type in ('matter_title','matter_summary','matter_origin_note')
         and rt.source_ref = m1::text and rt.superseded_at is null) <> 3 then
    raise exception 'matter creation did not register title+summary+origin note';
  end if;
  if not exists (select 1 from deedbox.matter_party mp
                  where mp.matter = m1 and mp.party = p1 and mp.capacity = cap_client and mp.deleted_at is null) then
    raise exception 'automatic client matter-party row missing';
  end if;

  ------------------------------------------------------------------
  -- 2. Corpus discipline: supersede-on-change, withdraw-on-clear,
  --    idempotent re-registration, immutability.
  ------------------------------------------------------------------
  update deedbox.matter set title = 'Corpus matter (renamed)' where id = m1;
  if (select count(*) from deedbox.registered_text rt
       where rt.source_type='matter_title' and rt.source_ref=m1::text) <> 2 then
    raise exception 'title change did not supersede-and-insert';
  end if;
  select rt.content into txt from deedbox.registered_text rt
   where rt.source_type='matter_title' and rt.source_ref=m1::text and rt.superseded_at is null;
  if txt <> 'Corpus matter (renamed)' then
    raise exception 'current corpus row is not the new title';
  end if;
  update deedbox.matter set origin_note = null where id = m1;
  if exists (select 1 from deedbox.registered_text rt
              where rt.source_type='matter_origin_note' and rt.source_ref=m1::text and rt.superseded_at is null) then
    raise exception 'cleared origin note still current in the corpus';
  end if;
  select count(*) into cnt from deedbox.registered_text;
  perform deedbox.corpus_upsert('core','matter_title', m1::text, 'Corpus matter (renamed)', m1, null);
  if (select count(*) from deedbox.registered_text) <> cnt then
    raise exception 'identical re-registration was not a no-op';
  end if;
  begin
    update deedbox.registered_text set content = 'tampered'
     where source_type='matter_title' and source_ref=m1::text and superseded_at is null;
    raise exception 'corpus content edited';
  exception when others then
    if sqlerrm not like '%exactly one mutation%' then raise; end if;
  end;
  begin
    delete from deedbox.registered_text where source_ref = m1::text;
    raise exception 'corpus row deleted';
  exception when others then
    if sqlerrm not like '%never deleted%' then raise; end if;
  end;

  ------------------------------------------------------------------
  -- 3. Close discipline: no close without its approved request in the
  --    same transaction; born-approved works; one pending per matter;
  --    self-approval refused; rejection needs a note; terminal rows
  --    are immutable; a stale pending request blocks a direct close.
  ------------------------------------------------------------------
  begin
    update deedbox.matter set status='closed' where id = m1;
    raise exception 'matter closed without a close request';
  exception when others then
    if sqlerrm not like '%exactly one approved close request%' then raise; end if;
  end;

  begin
    insert into deedbox.matter_close_request (matter, requested_by, financial_position, condition_evaluation, state)
      values (m1, s_law, '{}', '{}', 'rejected');
    raise exception 'close request born in a decided state other than approved';
  exception when others then
    if sqlerrm not like '%created pending or born approved%' then raise; end if;
  end;

  insert into deedbox.matter_close_request (matter, requested_by, financial_position, condition_evaluation)
    values (m1, s_law, '{"unbilled":0}', '{}') returning id into cr;
  begin
    insert into deedbox.matter_close_request (matter, requested_by, financial_position, condition_evaluation)
      values (m1, s_admin, '{}', '{}');
    raise exception 'second pending close request accepted';
  exception when others then
    if sqlerrm not like '%close_request_one_pending%' and sqlerrm not like '%duplicate key%' then raise; end if;
  end;

  -- a pending request left undecided blocks even a fresh born-approved close.
  begin
    insert into deedbox.matter_close_request (matter, requested_by, financial_position, condition_evaluation, state, decided_by, decided_at)
      values (m1, s_admin, '{}', '{}', 'approved', s_admin, now());
    update deedbox.matter set status='closed' where id = m1;
    raise exception 'matter closed while a request was still pending';
  exception when others then
    if sqlerrm not like '%remains pending%' then raise; end if;
  end;

  begin
    update deedbox.matter_close_request set state='approved', decided_by=s_law, decided_at=now() where id = cr;
    raise exception 'requester approved their own close request';
  exception when others then
    if sqlerrm not like '%never decides their own%' then raise; end if;
  end;
  begin
    update deedbox.matter_close_request set state='rejected', decided_by=s_admin, decided_at=now() where id = cr;
    raise exception 'rejection accepted without a decision note';
  exception when others then
    if sqlerrm not like '%decision note%' then raise; end if;
  end;

  -- approve by another + close: the sanctioned path.
  update deedbox.matter_close_request set state='approved', decided_by=s_admin, decided_at=now() where id = cr;
  update deedbox.matter set status='closed' where id = m1;
  if (select status from deedbox.matter where id = m1) <> 'closed' then
    raise exception 'sanctioned close did not commit';
  end if;
  begin
    update deedbox.matter_close_request set decision_note='revisionism' where id = cr;
    raise exception 'decided close request mutated';
  exception when others then
    if sqlerrm not like '%immutable%' then raise; end if;
  end;
  begin
    delete from deedbox.matter_close_request where id = cr;
    raise exception 'close request deleted';
  exception when others then
    if sqlerrm not like '%never deleted%' then raise; end if;
  end;

  -- reopen; the exactly-one rule: two fresh approved requests refuse the
  -- close. (The stale-request exclusion — an old transaction's decided_at
  -- no longer counting — cannot be exercised inside this single test
  -- transaction, where now() is frozen; decided-row immutability plus the
  -- timestamp comparison carry it in production.)
  update deedbox.matter set status='open' where id = m1;
  begin
    insert into deedbox.matter_close_request (matter, requested_by, financial_position, condition_evaluation, state, decided_by, decided_at)
      values (m1, s_admin, '{}', '{}', 'approved', s_admin, now());
    update deedbox.matter set status='closed' where id = m1;
    raise exception 'close accepted with two fresh approved requests';
  exception when others then
    if sqlerrm not like '%exactly one approved close request%' then raise; end if;
  end;

  ------------------------------------------------------------------
  -- 4. Client-party discipline: the client row follows the column;
  --    direct removal refused; client change demotes the old client
  --    to related party; merged parties refused; closed matters
  --    refuse a client change.
  ------------------------------------------------------------------
  begin
    update deedbox.matter_party set deleted_at = now()
     where matter = m1 and party = p1 and capacity = cap_client and deleted_at is null;
    raise exception 'live client row removed directly';
  exception when others then
    if sqlerrm not like '%cannot be removed or altered directly%' then raise; end if;
  end;
  begin
    insert into deedbox.matter_party (matter, party, capacity) values (m1, p2, cap_client);
    raise exception 'second party seated in the client capacity';
  exception when others then
    if sqlerrm not like '%another party cannot hold the client capacity%' then raise; end if;
  end;

  update deedbox.matter set client_party = p2 where id = m1;
  if not exists (select 1 from deedbox.matter_party mp
                  where mp.matter=m1 and mp.party=p2 and mp.capacity=cap_client and mp.deleted_at is null) then
    raise exception 'new client row not installed';
  end if;
  if exists (select 1 from deedbox.matter_party mp
              where mp.matter=m1 and mp.party=p1 and mp.capacity=cap_client and mp.deleted_at is null) then
    raise exception 'old client row still live';
  end if;
  if not exists (select 1 from deedbox.matter_party mp
                  join deedbox.choice_item ci on ci.id = mp.capacity
                 where mp.matter=m1 and mp.party=p1 and ci.shipped_key='related_party' and mp.deleted_at is null) then
    raise exception 'old client not retained as related party';
  end if;

  -- a merged party can never become the client.
  insert into deedbox.party (kind, display_name) values ('person','Absorbed') returning id into rel;
  insert into deedbox.party_name (party, name_kind, full_name) values (rel,'current','Absorbed');
  update deedbox.party set state='merged', merged_into=p1 where id = rel;
  begin
    update deedbox.matter set client_party = rel where id = m1;
    raise exception 'merged party seated as client';
  exception when others then
    if sqlerrm not like '%active party%' then raise; end if;
  end;

  -- closed matters refuse a client change even under the edit ceremony.
  -- (cr's approval carries this close too: decided_at = the frozen
  -- transaction now() — an artifact of the one-transaction test.)
  update deedbox.matter set status='closed' where id = m1;
  perform set_config('deedbox.edit_closed','on', true);
  begin
    update deedbox.matter set client_party = p1 where id = m1;
    raise exception 'client changed on a closed matter';
  exception when others then
    if sqlerrm not like '%open or on-hold%' then raise; end if;
  end;
  perform set_config('deedbox.edit_closed','off', true);

  ------------------------------------------------------------------
  -- 5. Notes: owner validated; corpus follows create/edit/soft-delete/
  --    restore; a note never moves owners.
  ------------------------------------------------------------------
  begin
    insert into deedbox.note (owner_type, owner, body) values ('matter', 999999, 'orphan');
    raise exception 'note accepted for a nonexistent owner';
  exception when others then
    if sqlerrm not like '%does not exist%' then raise; end if;
  end;
  insert into deedbox.matter (matter_number, title, client_party, responsible_lawyer, office, practice_area)
    values (deedbox.allocate_number('matter', null, current_date), 'Note host', p1, s_law, o, pa) returning id into m2;
  insert into deedbox.note (owner_type, owner, body) values ('matter', m2, 'First observation.') returning id into n1;
  if not exists (select 1 from deedbox.registered_text rt
                  where rt.source_type='note' and rt.source_ref=n1::text
                    and rt.matter = m2 and rt.superseded_at is null) then
    raise exception 'note corpus row missing or unlinked';
  end if;
  update deedbox.note set body = 'First observation, corrected.' where id = n1;
  if (select rt.content from deedbox.registered_text rt
       where rt.source_type='note' and rt.source_ref=n1::text and rt.superseded_at is null)
     <> 'First observation, corrected.' then
    raise exception 'note edit did not re-register';
  end if;
  update deedbox.note set deleted_at = now(), deleted_by = s_admin where id = n1;
  if exists (select 1 from deedbox.registered_text rt
              where rt.source_type='note' and rt.source_ref=n1::text and rt.superseded_at is null) then
    raise exception 'soft-deleted note still current in the corpus';
  end if;
  update deedbox.note set deleted_at = null, deleted_by = null where id = n1;
  if not exists (select 1 from deedbox.registered_text rt
                  where rt.source_type='note' and rt.source_ref=n1::text and rt.superseded_at is null) then
    raise exception 'restored note not re-registered';
  end if;
  begin
    update deedbox.note set owner = m1 where id = n1;
    raise exception 'note moved to another owner';
  exception when others then
    if sqlerrm not like '%never moves%' then raise; end if;
  end;

  ------------------------------------------------------------------
  -- 6. Party notes reach the corpus; clearing withdraws.
  ------------------------------------------------------------------
  update deedbox.party set notes = 'Prefers email.' where id = p1;
  if not exists (select 1 from deedbox.registered_text rt
                  where rt.source_type='party_note' and rt.source_ref=p1::text
                    and rt.party = p1 and rt.superseded_at is null) then
    raise exception 'party note not registered';
  end if;
  update deedbox.party set notes = null where id = p1;
  if exists (select 1 from deedbox.registered_text rt
              where rt.source_type='party_note' and rt.source_ref=p1::text and rt.superseded_at is null) then
    raise exception 'cleared party note still current';
  end if;

  ------------------------------------------------------------------
  -- 7. Relations: canonical storage both insertion orders; self refused;
  --    forbidden pair refused; absent pair honours the setting.
  ------------------------------------------------------------------
  insert into deedbox.choice_item (list, label, position)
    select cl.id, 'Related proceeding', 1 from deedbox.choice_list cl where cl.purpose_key='relation_labels'
    returning id into lbl;
  begin
    insert into deedbox.matter_relation (matter_a, matter_b, label) values (m2, m2, lbl);
    raise exception 'self-relation accepted';
  exception when others then
    if sqlerrm not like '%relate to itself%' then raise; end if;
  end;
  insert into deedbox.matter_relation (matter_a, matter_b, label) values (m2, m1, lbl) returning id into rel;
  if (select r.matter_a from deedbox.matter_relation r where r.id = rel) <> least(m1, m2) then
    raise exception 'relation not stored canonically';
  end if;
  begin
    insert into deedbox.matter_relation (matter_a, matter_b, label) values (m1, m2, lbl);
    raise exception 'duplicate canonical relation accepted';
  exception when others then
    if sqlerrm not like '%matter_relation_unique%' and sqlerrm not like '%duplicate key%' then raise; end if;
  end;

  -- absent pair + setting false => refused; explicit allowed pair => permitted.
  insert into deedbox.matter (matter_number, title, client_party, responsible_lawyer, office, practice_area)
    values (deedbox.allocate_number('matter', null, current_date), 'Other-area matter', p1, s_law, o, pa2) returning id into m3;
  insert into deedbox.firm_setting (definition, value, effective_from)
    select sd.id, 'false'::jsonb, now() - interval '2 hours'
      from deedbox.setting_definition sd where sd.key='matter.relations_absent_means_allowed';
  begin
    insert into deedbox.matter_relation (matter_a, matter_b, label) values (m2, m3, lbl);
    raise exception 'absent pair related while the setting forbade it';
  exception when others then
    if sqlerrm not like '%may not be related%' then raise; end if;
  end;
  insert into deedbox.practice_area_relatable (area_a, area_b, allowed) values (pa2, pa, true);
  insert into deedbox.matter_relation (matter_a, matter_b, label) values (m2, m3, lbl);
  -- and an explicit forbidden pair refuses regardless of the setting:
  update deedbox.practice_area_relatable set allowed = false where area_a = pa2 and area_b = pa;
  begin
    insert into deedbox.matter_relation (matter_a, matter_b, label) values (m1, m3, lbl);
    raise exception 'forbidden pair related';
  exception when others then
    if sqlerrm not like '%may not be related%' then raise; end if;
  end;

  ------------------------------------------------------------------
  -- 8. Intake: gate on the setting; corpus for about/notes; outcome
  --    optional and clearable; stage discipline; conversion terminal;
  --    converted matter unique; triple uniqueness on intake parties.
  ------------------------------------------------------------------
  insert into deedbox.firm_setting (definition, value, effective_from)
    select sd.id, 'false'::jsonb, now() - interval '2 hours'
      from deedbox.setting_definition sd where sd.key='intake.enabled';
  begin
    insert into deedbox.intake_record (prospect_party, contact_phone, about)
      values (p1, '0400 000 000', 'Wants advice.');
    raise exception 'intake record created while intake was off';
  exception when others then
    if sqlerrm not like '%switched off%' then raise; end if;
  end;
  insert into deedbox.firm_setting (definition, value, effective_from)
    select sd.id, 'true'::jsonb, now() - interval '1 hour'
      from deedbox.setting_definition sd where sd.key='intake.enabled';

  insert into deedbox.intake_stage (name, position) values ('New', 1) returning id into st1;
  begin
    insert into deedbox.intake_stage (name, position) values ('New', 2);
    raise exception 'duplicate active stage name accepted';
  exception when others then
    if sqlerrm not like '%intake_stage_name_unique%' and sqlerrm not like '%duplicate key%' then raise; end if;
  end;

  insert into deedbox.intake_record (prospect_party, contact_phone, about, notes, practice_area, stage)
    values (p1, '0400 000 000', 'Wants advice about a fence.', 'Sounded anxious.', pa, st1)
    returning id into ir;
  if (select count(*) from deedbox.registered_text rt
       where rt.source_type in ('intake_about','intake_note') and rt.source_ref=ir::text
         and rt.party = p1 and rt.superseded_at is null) <> 2 then
    raise exception 'intake about+notes not registered in the corpus';
  end if;

  -- outcome set + cleared, never demanded; close and reopen keep it.
  update deedbox.intake_record set outcome_reason =
    (select ci.id from deedbox.choice_item ci join deedbox.choice_list cl on cl.id=ci.list
      where cl.purpose_key='intake_outcomes' and ci.shipped_key='did_not_proceed')
   where id = ir;
  if (select outcome_at from deedbox.intake_record where id = ir) is null then
    raise exception 'outcome_at not stamped';
  end if;
  update deedbox.intake_record set state='closed' where id = ir;
  update deedbox.intake_record set state='open' where id = ir;
  if (select outcome_reason from deedbox.intake_record where id = ir) is null then
    raise exception 'reopen lost the recorded outcome';
  end if;
  update deedbox.intake_record set outcome_reason = null, outcome_note = null where id = ir;
  if (select outcome_at from deedbox.intake_record where id = ir) is not null then
    raise exception 'cleared outcome kept its timestamp';
  end if;

  -- stage moves only onto active stages.
  update deedbox.intake_stage set active = false where id = st1;
  begin
    update deedbox.intake_record set stage = st1 where id = ir and stage is null;
    -- (stage is still st1 from creation; move it off and back to exercise the guard)
    update deedbox.intake_record set stage = null where id = ir;
    update deedbox.intake_record set stage = st1 where id = ir;
    raise exception 'record moved onto a deactivated stage';
  exception when others then
    if sqlerrm not like '%active stage%' then raise; end if;
  end;

  -- intake parties: duplicate triple refused.
  insert into deedbox.intake_party (intake, party, capacity) values (ir, p2, cap_witness);
  begin
    insert into deedbox.intake_party (intake, party, capacity) values (ir, p2, cap_witness);
    raise exception 'duplicate intake party triple accepted';
  exception when others then
    if sqlerrm not like '%intake_party_unique%' and sqlerrm not like '%duplicate key%' then raise; end if;
  end;

  -- conversion: link + terminal state; the converted matter is claimed once.
  begin
    update deedbox.intake_record set state='converted' where id = ir;
    raise exception 'converted without a matter link';
  exception when others then
    if sqlerrm not like '%check%' then raise; end if;
  end;
  update deedbox.intake_record set state='converted', converted_matter=m2 where id = ir;
  begin
    update deedbox.intake_record set notes='late edit' where id = ir;
    raise exception 'converted record mutated';
  exception when others then
    if sqlerrm not like '%immutable%' then raise; end if;
  end;
  insert into deedbox.intake_record (prospect_party, contact_phone, about)
    values (p2, '0400 111 222', 'Second approach.') returning id into ir2;
  begin
    update deedbox.intake_record set state='converted', converted_matter=m2 where id = ir2;
    raise exception 'two intake records converted to one matter';
  exception when others then
    if sqlerrm not like '%intake_converted_matter_unique%' and sqlerrm not like '%duplicate key%' then raise; end if;
  end;

  -- soft-delete withdraws intake corpus rows.
  update deedbox.intake_record set deleted_at = now(), deleted_by = s_admin where id = ir2;
  if exists (select 1 from deedbox.registered_text rt
              where rt.source_type='intake_about' and rt.source_ref=ir2::text and rt.superseded_at is null) then
    raise exception 'soft-deleted intake record still current in the corpus';
  end if;

  raise notice 'ALL 0006 MATTERS-COMPLETION TESTS PASSED';
end $$;

rollback;
