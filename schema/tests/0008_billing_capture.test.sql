-- Tests for 0008_billing_capture. Run as deployment role AFTER 0001–0008.

begin;

insert into deedbox.country_pack (code, name) values ('AU-NSW','Australia (NSW)');
insert into deedbox.pack_version (pack, version) select id, '0.0.1' from deedbox.country_pack;
update deedbox.country_pack cp set active_version = pv.id from deedbox.pack_version pv where pv.pack = cp.id;
insert into deedbox.firm (name, operating_currency, timezone, country_pack)
  select 'Test Firm','AUD','Australia/Sydney', id from deedbox.country_pack;
insert into deedbox.office (name, code) values ('Sydney','SYD');
grant deedbox_app to current_user;

do $$
declare o bigint; r_admin bigint; r_lawyer bigint; s_admin bigint; s_law bigint;
        p1 bigint; pa bigint; m1 bigint; cat bigint; te bigint; te2 bigint; d1 bigint;
        sig bigint; sug bigint; ct bigint; tm bigint; rr record; cnt int;
        bg bigint; bl bigint; l1 bigint; l2 bigint; l3 bigint; l4 bigint;
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
    values (deedbox.allocate_number('matter', null, current_date), 'Capture host', p1, s_law, o, pa) returning id into m1;
  select ci.id into cat from deedbox.choice_item ci join deedbox.choice_list cl on cl.id=ci.list
   where cl.purpose_key='time_categories' and ci.shipped_key='chargeable';

  -- a draft bill with fixture lines for the on_draft/billed pointer tests
  -- (since 0010 the items' bill_line pointers are real foreign keys).
  insert into deedbox.bill_group (matter, matter_total, payer_share_snapshot)
    values (m1, 0, '[]') returning id into bg;
  insert into deedbox.bill (bill_group, matter, payer_party) values (bg, m1, p1) returning id into bl;
  insert into deedbox.bill_line (bill, position, kind, description, original_value, amount, tax_treatment, tax_amount, category_key)
    values (bl, 1, 'time', 'fixture', 0, 0, 'standard', 0, 'chargeable') returning id into l1;
  insert into deedbox.bill_line (bill, position, kind, description, original_value, amount, tax_treatment, tax_amount, category_key)
    values (bl, 2, 'time', 'fixture', 0, 0, 'standard', 0, 'chargeable') returning id into l2;
  insert into deedbox.bill_line (bill, position, kind, description, original_value, amount, tax_treatment, tax_amount, category_key)
    values (bl, 3, 'disbursement', 'fixture', 0, 0, 'standard', 0, 'chargeable') returning id into l3;
  insert into deedbox.bill_line (bill, position, kind, description, original_value, amount, tax_treatment, tax_amount, category_key)
    values (bl, 4, 'time', 'fixture', 0, 0, 'standard', 0, 'chargeable') returning id into l4;

  ------------------------------------------------------------------
  -- 1. Rates: append-only; resolution order; effective dating.
  ------------------------------------------------------------------
  insert into deedbox.staff_rate (staff, label, rate, effective_from)
    values (s_law, 'standard', 300.00, current_date - 30);
  insert into deedbox.staff_rate (staff, label, rate, effective_from)
    values (s_law, 'standard', 350.00, current_date - 5);
  insert into deedbox.staff_rate (staff, label, rate, effective_from)
    values (s_law, 'standard', 999.00, current_date + 5);   -- future: ignored today
  begin
    update deedbox.staff_rate set rate = 1.00 where staff = s_law;
    raise exception 'RT1 staff rate rewritten';
  exception when others then
    if sqlerrm not like '%append-only%' then raise; end if;
  end;

  select * into rr from deedbox.resolve_rate(m1, s_law, null, current_date);
  if rr.rate <> 350.00 or rr.rate_source <> 'staff_rate' then
    raise exception 'RT2 expected latest effective staff rate, got % from %', rr.rate, rr.rate_source;
  end if;
  insert into deedbox.matter_rate_override (matter, staff, label, rate, effective_from)
    values (m1, null, null, 280.00, current_date - 10);      -- all-staff, any label
  select * into rr from deedbox.resolve_rate(m1, s_law, null, current_date);
  if rr.rate <> 280.00 or rr.rate_source <> 'matter_override' then
    raise exception 'RT3 all-staff override not applied: % from %', rr.rate, rr.rate_source;
  end if;
  insert into deedbox.matter_rate_override (matter, staff, label, rate, effective_from)
    values (m1, s_law, 'standard', 260.00, current_date - 10);  -- staff-named beats all-staff
  select * into rr from deedbox.resolve_rate(m1, s_law, 'standard', current_date);
  if rr.rate <> 260.00 then
    raise exception 'RT4 staff-named override did not win: %', rr.rate;
  end if;

  ------------------------------------------------------------------
  -- 2. Cost rates: structurally confined to see_cost_rates holders.
  ------------------------------------------------------------------
  insert into deedbox.staff_cost_rate (staff, cost_rate, effective_from)
    values (s_law, 120.00, current_date - 30);
  set local role deedbox_app;
  perform set_config('deedbox.principal_kind','staff', true);
  perform set_config('deedbox.principal_id', s_law::text, true);   -- lawyer: no capability
  select count(*) into cnt from deedbox.staff_cost_rate;
  if cnt <> 0 then
    raise exception 'CR1 cost rates visible without see_cost_rates (% rows)', cnt;
  end if;
  perform set_config('deedbox.principal_id', s_admin::text, true); -- administrator: holds it
  select count(*) into cnt from deedbox.staff_cost_rate;
  if cnt <> 1 then
    raise exception 'CR2 cost rates invisible to a see_cost_rates holder';
  end if;
  perform set_config('deedbox.principal_kind','', true);           -- absent context fails closed
  perform set_config('deedbox.principal_id','', true);
  select count(*) into cnt from deedbox.staff_cost_rate;
  if cnt <> 0 then
    raise exception 'CR3 cost rates visible without principal context';
  end if;
  reset role;

  ------------------------------------------------------------------
  -- 3. Time entries: the value formula is stored and verified.
  ------------------------------------------------------------------
  begin
    insert into deedbox.time_entry (matter, staff, work_date, kind, units, unit_minutes_applied,
                                    applied_rate, rate_source, value, narrative, category, origin)
      values (m1, s_law, current_date, 'timed', 3, 6, 260.00, 'matter_override',
              999.99, 'wrong value', cat, 'manual');
    raise exception 'T1 wrong stored value accepted';
  exception when others then
    if sqlerrm not like '%check%' then raise; end if;
  end;
  insert into deedbox.time_entry (matter, staff, work_date, kind, units, unit_minutes_applied,
                                  applied_rate, rate_source, value, narrative, category, origin)
    values (m1, s_law, current_date, 'timed', 3, 6, 260.00, 'matter_override',
            78.00, 'Attend client', cat, 'manual') returning id into te;   -- 3*6*260/60
  begin
    insert into deedbox.time_entry (matter, staff, work_date, kind, fixed_amount, units,
                                    value, narrative, category, origin)
      values (m1, s_law, current_date, 'fixed_fee', 500.00, 2, 500.00, 'fee with units', cat, 'manual');
    raise exception 'T2 fixed-fee entry accepted timed fields';
  exception when others then
    if sqlerrm not like '%check%' then raise; end if;
  end;
  insert into deedbox.time_entry (matter, staff, work_date, kind, fixed_amount, value, narrative, category, origin)
    values (m1, s_law, current_date, 'fixed_fee', 500.00, 500.00, 'Fixed advice fee', cat, 'manual') returning id into te2;

  ------------------------------------------------------------------
  -- 4. The billed-state machine and the lock rule.
  ------------------------------------------------------------------
  begin
    update deedbox.time_entry set billed_state='billed', bill_line=l1 where id = te;
    raise exception 'S1 unbilled jumped straight to billed';
  exception when others then
    if sqlerrm not like '%illegal billed-state transition%' then raise; end if;
  end;
  begin
    update deedbox.time_entry set billed_state='on_draft' where id = te;   -- no line named
    raise exception 'S2 drafted without a bill line';
  exception when others then
    if sqlerrm not like '%check%' then raise; end if;
  end;
  update deedbox.time_entry set billed_state='on_draft', bill_line=l1 where id = te;
  begin
    update deedbox.time_entry set units=10, value=round(10*6*260.00/60.0,2) where id = te;
    raise exception 'S3 drafted item value edited';
  exception when others then
    if sqlerrm not like '%value fields are immutable%' then raise; end if;
  end;
  update deedbox.time_entry set narrative='Attend client (expanded note)' where id = te;  -- always writable
  update deedbox.time_entry set billed_state='unbilled', bill_line=null where id = te;    -- released
  update deedbox.time_entry set billed_state='on_draft', bill_line=l2 where id = te;
  update deedbox.time_entry set billed_state='billed' where id = te;
  begin
    update deedbox.time_entry set bill_line=l4 where id = te;
    raise exception 'S4 billed item moved between lines';
  exception when others then
    if sqlerrm not like '%never leaves its bill line%' then raise; end if;
  end;
  begin
    update deedbox.time_entry set deleted_at=now() where id = te;
    raise exception 'S5 billed item soft-deleted';
  exception when others then
    if sqlerrm not like '%only unbilled items soft-delete%' then raise; end if;
  end;
  begin
    delete from deedbox.time_entry where id = te;
    raise exception 'S6 captured item hard-deleted';
  exception when others then
    if sqlerrm not like '%never hard-deleted%' then raise; end if;
  end;

  begin
    update deedbox.time_entry set billed_state='written_off_before_billing' where id = te2;
    raise exception 'S7 write-off accepted without a reason';
  exception when others then
    if sqlerrm not like '%check%' then raise; end if;
  end;
  update deedbox.time_entry set billed_state='written_off_before_billing',
         writeoff_reason='Goodwill: not chargeable after review' where id = te2;
  begin
    update deedbox.time_entry set narrative='post-mortem edit' where id = te2;
    raise exception 'S8 written-off item edited';
  exception when others then
    if sqlerrm not like '%terminal%' then raise; end if;
  end;

  ------------------------------------------------------------------
  -- 5. Timers are ephemeral; signals are idempotent evidence.
  ------------------------------------------------------------------
  insert into deedbox.timer (staff, matter) values (s_law, m1) returning id into tm;
  delete from deedbox.timer where id = tm;   -- hard delete sanctioned

  insert into deedbox.activity_signal (source_module, signal_kind, source_ref, occurred_at, staff, detail)
    values ('email','email_sent','msg-001', now(), s_law, '{"subject":"x"}') returning id into sig;
  begin
    insert into deedbox.activity_signal (source_module, signal_kind, source_ref, occurred_at, staff, detail)
      values ('email','email_sent','msg-001', now(), s_law, '{"subject":"retry"}');
    raise exception 'A1 duplicate signal accepted';
  exception when others then
    if sqlerrm not like '%duplicate key%' then raise; end if;
  end;
  begin
    update deedbox.activity_signal set detail='{"subject":"rewritten"}' where id = sig;
    raise exception 'A2 signal rewritten';
  exception when others then
    if sqlerrm not like '%append-only%' then raise; end if;
  end;

  ------------------------------------------------------------------
  -- 6. Suggestions: born held/pending; review transitions only;
  --    resolved rows immutable; nothing reaches billing unreviewed.
  ------------------------------------------------------------------
  insert into deedbox.suggested_entry (signal, staff, state, proposed_date, proposed_minutes, proposed_narrative)
    values (sig, s_law, 'held_unmatched', current_date, 30, 'Email to client') returning id into sug;
  begin
    update deedbox.suggested_entry set state='accepted' where id = sug;
    raise exception 'G1 held suggestion accepted directly';
  exception when others then
    if sqlerrm not like '%illegal suggestion transition%' and sqlerrm not like '%check%' then raise; end if;
  end;
  update deedbox.suggested_entry set state='pending', matter=m1 where id = sug;
  -- accept: entry + state + resolved_at in one statement (the op's shape).
  insert into deedbox.time_entry (matter, staff, work_date, kind, units, unit_minutes_applied,
                                  applied_rate, rate_source, value, narrative, category, origin, suggestion)
    values (m1, s_law, current_date, 'timed', 5, 6, 260.00, 'matter_override',
            130.00, 'Email to client', cat, 'suggestion', sug) returning id into te;
  update deedbox.suggested_entry set state='accepted', resulting_entry=te, resolved_at=now() where id = sug;
  begin
    update deedbox.suggested_entry set state='discarded', resulting_entry=null, resolved_at=now() where id = sug;
    raise exception 'G2 resolved suggestion mutated';
  exception when others then
    if sqlerrm not like '%immutable%' then raise; end if;
  end;
  begin
    delete from deedbox.suggested_entry where id = sug;
    raise exception 'G3 suggestion deleted';
  exception when others then
    if sqlerrm not like '%retained as evidence%' then raise; end if;
  end;

  ------------------------------------------------------------------
  -- 7. Disbursements: tax keys bind once the pack declares them.
  ------------------------------------------------------------------
  insert into deedbox.cost_type (name, default_tax_treatment) values ('Court filing fee','standard') returning id into ct;
  insert into deedbox.disbursement (matter, incurred_date, description, amount, tax_treatment, cost_type)
    values (m1, current_date, 'Filing fee', 285.70, 'anything_goes', ct) returning id into d1;  -- no declarations yet
  insert into deedbox.pack_declaration (pack_version, rule_point, kind, discriminator, body)
    select cp.active_version, 'billing.tax', 'enumeration', 'standard', '{"label":"Standard"}'
      from deedbox.country_pack cp limit 1;
  begin
    insert into deedbox.disbursement (matter, incurred_date, description, amount, tax_treatment)
      values (m1, current_date, 'Bad tax key', 10.00, 'anything_goes');
    raise exception 'D1 undeclared tax key accepted once the pack declared keys';
  exception when others then
    if sqlerrm not like '%not a key of the active pack%' then raise; end if;
  end;
  insert into deedbox.disbursement (matter, incurred_date, description, amount, tax_treatment)
    values (m1, current_date, 'Good tax key', 10.00, 'standard');
  begin
    insert into deedbox.disbursement (matter, incurred_date, description, amount, tax_treatment)
      values (m1, current_date, 'Zero amount', 0.00, 'standard');
    raise exception 'D2 zero-amount disbursement accepted';
  exception when others then
    if sqlerrm not like '%check%' then raise; end if;
  end;
  -- lock rule mirrors time entries; description stays correctable.
  update deedbox.disbursement set billed_state='on_draft', bill_line=l3 where id = d1;
  begin
    update deedbox.disbursement set amount=999.00 where id = d1;
    raise exception 'D3 drafted disbursement amount edited';
  exception when others then
    if sqlerrm not like '%value fields are immutable%' then raise; end if;
  end;
  update deedbox.disbursement set description='Filing fee (District Court)' where id = d1;

  raise notice 'ALL 0008 BILLING-CAPTURE TESTS PASSED';
end $$;

rollback;
