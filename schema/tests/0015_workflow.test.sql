-- Tests for 0015_workflow. Run as deployment role AFTER 0001–0015.

begin;

insert into deedbox.country_pack (code, name) values ('AU-NSW','Australia (NSW)');
insert into deedbox.pack_version (pack, version) select id, '0.0.1' from deedbox.country_pack;
update deedbox.country_pack cp set active_version = pv.id from deedbox.pack_version pv where pv.pack = cp.id;
insert into deedbox.firm (name, operating_currency, timezone, country_pack)
  select 'Test Firm','AUD','Australia/Sydney', id from deedbox.country_pack;
insert into deedbox.office (name, code) values ('Sydney','SYD');

do $$
declare o bigint; r_admin bigint; r_lawyer bigint; s_admin bigint; s_law bigint;
        p1 bigint; pa bigint; m1 bigint; tpl bigint; tst bigint; adef bigint;
        prop1 bigint; prop2 bigint; ms bigint; tk bigint; kdt bigint;
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
    values (deedbox.allocate_number('matter', null, current_date), 'Workflow host', p1, s_law, o, pa) returning id into m1;

  ------------------------------------------------------------------
  -- 1. Templates: named-person slots name their person.
  ------------------------------------------------------------------
  insert into deedbox.workflow_template (name, practice_area) values ('Standard litigation', pa) returning id into tpl;
  insert into deedbox.template_stage (template, name, position) values (tpl, 'Pleadings', 1) returning id into tst;
  begin
    insert into deedbox.template_task (stage, title, assignee_slot, due_rule)
      values (tst, 'File defence', 'named_person', '{"basis":"stage_entry","offset_days":14}');
    raise exception 'named-person slot accepted without a person';
  exception when others then
    if sqlerrm not like '%check%' then raise; end if;
  end;
  insert into deedbox.template_task (stage, title, assignee_slot, named_staff, due_rule)
    values (tst, 'File defence', 'named_person', s_law, '{"basis":"stage_entry","offset_days":14}');

  ------------------------------------------------------------------
  -- 2. Anchor recompute proposals: born pending; the freshest is the
  --    only pending one; decided rows immutable.
  ------------------------------------------------------------------
  insert into deedbox.anchor_date_definition (name) values ('Date of incident') returning id into adef;
  insert into deedbox.matter_anchor_date (matter, definition, value) values (m1, adef, current_date - 100);
  insert into deedbox.date_recompute_proposal (matter, changes)
    values (m1, '[{"task":"File defence","old":null,"new":"2026-09-01"}]') returning id into prop1;
  insert into deedbox.date_recompute_proposal (matter, changes)
    values (m1, '[{"task":"File defence","old":null,"new":"2026-09-08"}]') returning id into prop2;
  if (select state from deedbox.date_recompute_proposal where id = prop1) <> 'superseded' then
    raise exception 'stale proposal not superseded by the fresh one';
  end if;
  update deedbox.date_recompute_proposal set state='confirmed' where id = prop2;
  begin
    update deedbox.date_recompute_proposal set state='rejected' where id = prop2;
    raise exception 'decided proposal mutated';
  exception when others then
    if sqlerrm not like '%immutable%' then raise; end if;
  end;

  ------------------------------------------------------------------
  -- 3. Matter stages: exactly one current.
  ------------------------------------------------------------------
  insert into deedbox.matter_stage (matter, name, position, state, entered_at)
    values (m1, 'Pleadings', 1, 'current', now()) returning id into ms;
  begin
    insert into deedbox.matter_stage (matter, name, position, state, entered_at)
      values (m1, 'Discovery', 2, 'current', now());
    raise exception 'two current stages on one matter';
  exception when others then
    if sqlerrm not like '%duplicate key%' then raise; end if;
  end;
  insert into deedbox.matter_stage (matter, name, position) values (m1, 'Discovery', 2);

  -- the billing guardrail's stage pointer is now a real reference.
  insert into deedbox.budget (matter, level, stage, amount, thresholds, recipients)
    values (m1, 'stage', ms, 5000.00, '[80,100]', jsonb_build_array(s_law));

  ------------------------------------------------------------------
  -- 4. Tasks: the closed-matter rule admits no exceptions; done
  --    stamps and clears its evidence.
  ------------------------------------------------------------------
  insert into deedbox.task (matter, stage, title, owner, origin)
    values (m1, ms, 'Draft defence', s_law, 'template') returning id into tk;
  update deedbox.task set done=true, done_by=s_law where id = tk;
  if (select done_at from deedbox.task where id = tk) is null then
    raise exception 'T1 completion not stamped';
  end if;
  update deedbox.task set done=false where id = tk;
  if (select done_at from deedbox.task where id = tk) is not null then
    raise exception 'T2 un-done kept its stamp';
  end if;

  insert into deedbox.matter_close_request (matter, requested_by, financial_position, condition_evaluation, state, decided_by, decided_at)
    values (m1, s_admin, '{}', '{}', 'approved', s_admin, now());
  update deedbox.matter set status='closed' where id = m1;
  begin
    update deedbox.task set done=true, done_by=s_law where id = tk;
    raise exception 'T3 task completed on a closed matter without the ceremony';
  exception when others then
    if sqlerrm not like '%matter.edit_closed%' then raise; end if;
  end;
  begin
    insert into deedbox.task (matter, title, owner) values (m1, 'Late task', s_law);
    raise exception 'T4 task created on a closed matter without the ceremony';
  exception when others then
    if sqlerrm not like '%matter.edit_closed%' then raise; end if;
  end;
  perform set_config('deedbox.edit_closed','on', true);
  update deedbox.task set done=true, done_by=s_law where id = tk;
  perform set_config('deedbox.edit_closed','off', true);
  update deedbox.matter set status='open' where id = m1;

  -- personal tasks carry no matter and no closed-matter gate.
  insert into deedbox.task (title, owner) values ('Renew practising certificate', s_admin);

  ------------------------------------------------------------------
  -- 5. Key dates: typed from the shipped list; ends after starts.
  ------------------------------------------------------------------
  select ci.id into kdt from deedbox.choice_item ci join deedbox.choice_list cl on cl.id=ci.list
   where cl.purpose_key='key_date_types' and ci.shipped_key='court_date';
  begin
    insert into deedbox.key_date (matter, kind, type, title, starts_at, ends_at)
      values (m1, 'appointment', kdt, 'Backwards booking', now(), now() - interval '1 hour');
    raise exception 'key date ending before it starts';
  exception when others then
    if sqlerrm not like '%check%' then raise; end if;
  end;
  insert into deedbox.key_date (matter, kind, type, title, starts_at, critical)
    values (m1, 'key_date', kdt, 'Directions hearing', now() + interval '10 days', true);

  raise notice 'ALL 0015 WORKFLOW TESTS PASSED';
end $$;

rollback;
