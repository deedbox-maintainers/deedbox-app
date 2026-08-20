-- Tests for 0009_billing_guardrails. Run as deployment role AFTER 0001–0009.

begin;

insert into deedbox.country_pack (code, name) values ('AU-NSW','Australia (NSW)');
insert into deedbox.pack_version (pack, version) select id, '0.0.1' from deedbox.country_pack;
update deedbox.country_pack cp set active_version = pv.id from deedbox.pack_version pv where pv.pack = cp.id;
insert into deedbox.firm (name, operating_currency, timezone, country_pack)
  select 'Test Firm','AUD','Australia/Sydney', id from deedbox.country_pack;
insert into deedbox.office (name, code) values ('Sydney','SYD');

do $$
declare o bigint; r_admin bigint; r_lawyer bigint; s_admin bigint; s_law bigint;
        p1 bigint; pa bigint; m1 bigint; h bigint; est bigint; b1 bigint; fp bigint;
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
    values (deedbox.allocate_number('matter', null, current_date), 'Guardrail host', p1, s_law, o, pa) returning id into m1;

  ------------------------------------------------------------------
  -- 1. Billing holds: one open; the mirror follows; release is the
  --    single mutation; the record is permanent.
  ------------------------------------------------------------------
  insert into deedbox.billing_hold (matter, reason, placed_by)
    values (m1, 'Fee dispute under discussion', s_admin) returning id into h;
  if not (select billing_hold from deedbox.matter where id = m1) then
    raise exception 'H1 mirror not set on place';
  end if;
  begin
    insert into deedbox.billing_hold (matter, reason, placed_by) values (m1, 'Second hold', s_admin);
    raise exception 'H2 second open hold accepted';
  exception when others then
    if sqlerrm not like '%billing_hold_one_open%' and sqlerrm not like '%duplicate key%' then raise; end if;
  end;
  begin
    update deedbox.billing_hold set reason='rewritten' where id = h;
    raise exception 'H3 hold reason rewritten';
  exception when others then
    if sqlerrm not like '%exactly one mutation%' then raise; end if;
  end;
  update deedbox.billing_hold set released_by=s_admin, released_at=now() where id = h;
  if (select billing_hold from deedbox.matter where id = m1) then
    raise exception 'mirror not cleared on release';
  end if;
  begin
    update deedbox.billing_hold set released_at=null, released_by=null where id = h;
    raise exception 'released hold reopened';
  exception when others then
    if sqlerrm not like '%immutable%' then raise; end if;
  end;
  begin
    delete from deedbox.billing_hold where id = h;
    raise exception 'hold deleted';
  exception when others then
    if sqlerrm not like '%never deleted%' then raise; end if;
  end;
  insert into deedbox.billing_hold (matter, reason, placed_by) values (m1, 'Fresh hold', s_admin);
  if not (select billing_hold from deedbox.matter where id = m1) then
    raise exception 'mirror not set on re-place after release';
  end if;

  ------------------------------------------------------------------
  -- 2. Estimates: the amount moves only through revisions; the
  --    history is append-only, densely numbered; revising re-arms.
  ------------------------------------------------------------------
  insert into deedbox.cost_estimate (matter, current_amount, alert_thresholds)
    values (m1, 5000.00, '[50,80,100]') returning id into est;
  insert into deedbox.estimate_revision (estimate, amount, author, reason)
    values (est, 5000.00, s_law, 'initial');
  if (select current_amount from deedbox.cost_estimate where id = est) <> 5000.00
     or (select arming_version from deedbox.cost_estimate where id = est) <> 1 then
    raise exception 'creation revision moved the arming version';
  end if;
  begin
    update deedbox.cost_estimate set current_amount = 9999.00 where id = est;
    raise exception 'estimate amount edited directly';
  exception when others then
    if sqlerrm not like '%only through a revision%' then raise; end if;
  end;
  insert into deedbox.estimate_revision (estimate, amount, author, reason)
    values (est, 8000.00, s_law, 'Scope grew: contested hearing now likely');
  if (select current_amount from deedbox.cost_estimate where id = est) <> 8000.00
     or (select arming_version from deedbox.cost_estimate where id = est) <> 2 then
    raise exception 'revision did not move the amount and re-arm';
  end if;
  if (select max(revision_no) from deedbox.estimate_revision where estimate = est) <> 2 then
    raise exception 'revision numbering not dense';
  end if;
  begin
    update deedbox.estimate_revision set amount = 1.00 where estimate = est and revision_no = 1;
    raise exception 'revision history rewritten';
  exception when others then
    if sqlerrm not like '%append-only%' then raise; end if;
  end;
  begin
    insert into deedbox.estimate_revision (estimate, amount, author, reason) values (est, 100.00, s_law, '');
    raise exception 'empty revision reason accepted';
  exception when others then
    if sqlerrm not like '%check%' then raise; end if;
  end;
  -- the estimate's alert thresholds stay user-editable without ceremony.
  update deedbox.cost_estimate set alert_thresholds = '[50,75,90,100]' where id = est;

  ------------------------------------------------------------------
  -- 3. Budgets: one active per scope; rows immutable; supersession
  --    deactivates and replaces; no reactivation.
  ------------------------------------------------------------------
  insert into deedbox.budget (matter, level, amount, thresholds, recipients)
    values (m1, 'matter', 10000.00, '[50,80,100]', jsonb_build_array(s_law)) returning id into b1;
  begin
    insert into deedbox.budget (matter, level, amount, thresholds, recipients)
      values (m1, 'matter', 12000.00, '[50,80,100]', jsonb_build_array(s_law));
    raise exception 'two active budgets on one scope';
  exception when others then
    if sqlerrm not like '%budget_one_active_per_scope%' and sqlerrm not like '%duplicate key%' then raise; end if;
  end;
  begin
    update deedbox.budget set amount = 12000.00 where id = b1;
    raise exception 'budget amount edited in place';
  exception when others then
    if sqlerrm not like '%immutable%' then raise; end if;
  end;
  update deedbox.budget set active = false where id = b1;
  insert into deedbox.budget (matter, level, amount, thresholds, recipients, arming_version)
    values (m1, 'matter', 12000.00, '[50,80,100]', jsonb_build_array(s_law), 2);
  begin
    update deedbox.budget set active = true where id = b1;
    raise exception 'superseded budget reactivated';
  exception when others then
    if sqlerrm not like '%never reactivates%' then raise; end if;
  end;
  begin
    insert into deedbox.budget (matter, level, amount, thresholds, recipients)
      values (m1, 'stage', 1000.00, '[100]', jsonb_build_array(s_law));
    raise exception 'stage-level budget accepted without a stage';
  exception when others then
    if sqlerrm not like '%check%' then raise; end if;
  end;

  ------------------------------------------------------------------
  -- 4. Funds policy: target >= minimum; the one mutable policy row.
  ------------------------------------------------------------------
  begin
    insert into deedbox.matter_funds_policy (matter, minimum_threshold, target_amount, attach_to_next_bill, auto_issue)
      values (m1, 2000.00, 1000.00, false, false);
    raise exception 'target below minimum accepted';
  exception when others then
    if sqlerrm not like '%check%' then raise; end if;
  end;
  insert into deedbox.matter_funds_policy (matter, minimum_threshold, target_amount, attach_to_next_bill, auto_issue)
    values (m1, 1000.00, 3000.00, false, false) returning id into fp;
  update deedbox.matter_funds_policy set target_amount = 4000.00, arming_version = 2 where id = fp;

  ------------------------------------------------------------------
  -- 5. Threshold alerts: once per threshold per arming, structurally.
  ------------------------------------------------------------------
  insert into deedbox.threshold_alert (subject_type, subject, threshold_pct, arming_version, recipients)
    values ('estimate', est, 80, 2, jsonb_build_array(s_law));
  begin
    insert into deedbox.threshold_alert (subject_type, subject, threshold_pct, arming_version, recipients)
      values ('estimate', est, 80, 2, jsonb_build_array(s_law));
    raise exception 'the same threshold fired twice in one arming';
  exception when others then
    if sqlerrm not like '%duplicate key%' then raise; end if;
  end;
  insert into deedbox.threshold_alert (subject_type, subject, threshold_pct, arming_version, recipients)
    values ('estimate', est, 80, 3, jsonb_build_array(s_law));   -- re-armed: fires again
  begin
    update deedbox.threshold_alert set threshold_pct = 90 where subject_type='estimate' and subject=est and arming_version=2;
    raise exception 'fired alert rewritten';
  exception when others then
    if sqlerrm not like '%append-only%' then raise; end if;
  end;

  raise notice 'ALL 0009 BILLING-GUARDRAILS TESTS PASSED';
end $$;

rollback;
