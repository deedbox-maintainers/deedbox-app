-- Tests for 0011_receivables_post_issue. Run as deployment role AFTER 0001–0011.

begin;

insert into deedbox.country_pack (code, name) values ('AU-NSW','Australia (NSW)');
insert into deedbox.pack_version (pack, version) select id, '0.0.1' from deedbox.country_pack;
update deedbox.country_pack cp set active_version = pv.id from deedbox.pack_version pv where pv.pack = cp.id;
insert into deedbox.firm (name, operating_currency, timezone, country_pack)
  select 'Test Firm','AUD','Australia/Sydney', id from deedbox.country_pack;
insert into deedbox.office (name, code) values ('Sydney','SYD');

do $$
declare o bigint; r_admin bigint; r_lawyer bigint; s_admin bigint; s_law bigint;
        p1 bigint; pa bigint; m1 bigint; bg bigint; b1 bigint;
        disp bigint; cn bigint; pay bigint; pay2 bigint; pref bigint; chp bigint;
        pol bigint; arr bigint; inst bigint; seq bigint; brs bigint; fp bigint; tur bigint;
        run1 bigint; fa bigint; bo bigint; alloc bigint; att1 bigint;
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
    values (deedbox.allocate_number('matter', null, current_date), 'Post-issue host', p1, s_law, o, pa) returning id into m1;
  insert into deedbox.bill_group (matter, matter_total, payer_share_snapshot)
    values (m1, 1000.00, '[]') returning id into bg;
  insert into deedbox.bill (bill_group, matter, payer_party) values (bg, m1, p1) returning id into b1;
  update deedbox.bill
     set state='issued', bill_number=deedbox.allocate_number('bill', null, current_date),
         issue_date=current_date, terms_days_applied=14, due_date=current_date+14,
         rendered_artefact='artefact:pi'
   where id = b1;
  insert into deedbox.bill_journal_entry (bill, entry_kind, signed_amount, source_type, source, effective_date, entered_by)
    values (b1, 'issue_total', 1000.00, 'bill', b1, current_date, s_admin);

  ------------------------------------------------------------------
  -- 1. Disputes: one open per bill; resolution the single mutation.
  ------------------------------------------------------------------
  insert into deedbox.bill_dispute (bill, raised_by, detail)
    values (b1, s_law, 'Client questions the second line') returning id into disp;
  begin
    insert into deedbox.bill_dispute (bill, raised_by, detail) values (b1, s_law, 'again');
    raise exception 'D1 two open disputes on one bill';
  exception when others then
    if sqlerrm not like '%duplicate key%' then raise; end if;
  end;
  begin
    update deedbox.bill_dispute set detail='rewritten' where id = disp;
    raise exception 'D2 dispute detail rewritten';
  exception when others then
    if sqlerrm not like '%exactly one mutation%' then raise; end if;
  end;
  update deedbox.bill_dispute set resolved_at=now(), resolution_note='Explained; client satisfied' where id = disp;
  begin
    update deedbox.bill_dispute set resolution_note='changed my mind' where id = disp;
    raise exception 'D3 resolved dispute mutated';
  exception when others then
    if sqlerrm not like '%immutable%' then raise; end if;
  end;

  ------------------------------------------------------------------
  -- 2. Payments and journal caps: allocations never exceed the
  --    payment; a cancelled payment never allocates; credit
  --    applications never exceed the note.
  ------------------------------------------------------------------
  insert into deedbox.receivable_payment (payer_party, received_date, amount, method, receipt_number)
    values (p1, current_date, 600.00, 'eft', deedbox.allocate_number('receivable_receipt', null, current_date))
    returning id into pay;
  insert into deedbox.bill_journal_entry (bill, entry_kind, signed_amount, source_type, source, effective_date, entered_by)
    values (b1, 'payment_allocation', -400.00, 'receivable_payment', pay, current_date, s_admin) returning id into alloc;
  begin
    insert into deedbox.bill_journal_entry (bill, entry_kind, signed_amount, source_type, source, effective_date, entered_by)
      values (b1, 'payment_allocation', -300.00, 'receivable_payment', pay, current_date, s_admin);
    raise exception 'P1 allocations exceeded the payment';
  exception when others then
    if sqlerrm not like '%exceed its amount%' then raise; end if;
  end;
  -- cancel the payment with a mirror; further allocation refused.
  insert into deedbox.receivable_payment (payer_party, received_date, amount, method, receipt_number, reverses, reason)
    values (p1, current_date, 600.00, 'eft', deedbox.allocate_number('receivable_receipt', null, current_date),
            pay, 'banked against the wrong client') returning id into pay2;
  begin
    insert into deedbox.bill_journal_entry (bill, entry_kind, signed_amount, source_type, source, effective_date, entered_by)
      values (b1, 'payment_allocation', -100.00, 'receivable_payment', pay, current_date, s_admin);
    raise exception 'P2 cancelled payment allocated';
  exception when others then
    if sqlerrm not like '%cancelled payment%' then raise; end if;
  end;
  begin
    update deedbox.receivable_payment set amount=999.00 where id = pay;
    raise exception 'P3 payment rewritten';
  exception when others then
    if sqlerrm not like '%insert-only%' then raise; end if;
  end;

  insert into deedbox.credit_note (credit_number, bill, amount, reason, issued_by, rendered_artefact)
    values (deedbox.allocate_number('credit_note', null, current_date), b1, 150.00,
            'Goodwill on the disputed line', s_admin, 'artefact:cn') returning id into cn;
  insert into deedbox.bill_journal_entry (bill, entry_kind, signed_amount, source_type, source, effective_date, entered_by)
    values (b1, 'credit_application', -100.00, 'credit_note', cn, current_date, s_admin);
  begin
    insert into deedbox.bill_journal_entry (bill, entry_kind, signed_amount, source_type, source, effective_date, entered_by)
      values (b1, 'credit_application', -100.00, 'credit_note', cn, current_date, s_admin);
    raise exception 'P4 credit applications exceeded the note';
  exception when others then
    if sqlerrm not like '%exceed its amount%' then raise; end if;
  end;

  ------------------------------------------------------------------
  -- 3. Attribution: the current set sums to the issue total; the
  --    collection fan sums to its allocation exactly.
  ------------------------------------------------------------------
  insert into deedbox.bill_attribution (bill, staff, billed_share) values (b1, s_law, 700.00) returning id into att1;
  insert into deedbox.bill_attribution (bill, staff, billed_share) values (b1, s_admin, 300.00);
  begin
    set constraints deedbox.z_assert_attribution_sum immediate;
  exception when others then
    raise exception 'A1 a correct attribution set was refused: %', sqlerrm;
  end;
  begin
    update deedbox.bill_attribution set superseded_at = now() where id = att1;
    set constraints deedbox.z_assert_attribution_sum immediate;
    raise exception 'A2 a short attribution set stood at check';
  exception when others then
    if sqlerrm not like '%sum to its issue total%' then raise; end if;
  end;
  set constraints deedbox.z_assert_attribution_sum deferred;

  begin
    insert into deedbox.collection_attribution (allocation_entry, staff, amount) values (alloc, s_law, 280.00);
    set constraints deedbox.z_assert_collection_fan immediate;
    raise exception 'A3 a short collection fan stood at check';
  exception when others then
    if sqlerrm not like '%sum to its amount%' then raise; end if;
  end;
  set constraints deedbox.z_assert_collection_fan deferred;
  insert into deedbox.collection_attribution (allocation_entry, staff, amount) values (alloc, s_law, 280.00);
  insert into deedbox.collection_attribution (allocation_entry, staff, amount) values (alloc, s_admin, 120.00);
  set constraints deedbox.z_assert_collection_fan immediate;

  ------------------------------------------------------------------
  -- 4. References and channel payments: forward-only, idempotent,
  --    settlement carries its receipt.
  ------------------------------------------------------------------
  insert into deedbox.payment_reference (code, target_kind, target)
    values ('REF-8f3k2m9x7q4w1z6v5b0n8j2h4g6d', 'bill', b1) returning id into pref;
  insert into deedbox.channel_payment (payment_reference, channel, method, amount, state_history, channel_event_ref)
    values (pref, 'cardgate', 'card', 500.00, '[]', 'evt-001') returning id into chp;
  begin
    insert into deedbox.channel_payment (payment_reference, channel, method, amount, state_history, channel_event_ref)
      values (pref, 'cardgate', 'card', 500.00, '[]', 'evt-001');
    raise exception 'C1 replayed channel event accepted';
  exception when others then
    if sqlerrm not like '%duplicate key%' then raise; end if;
  end;
  begin
    update deedbox.channel_payment set state='settled' where id = chp;
    raise exception 'C2 settled without its resulting receipt';
  exception when others then
    if sqlerrm not like '%check%' then raise; end if;
  end;
  update deedbox.channel_payment
     set state='settled', resulting_receipt_type='receivable_payment', resulting_receipt=pay2
   where id = chp;
  begin
    update deedbox.channel_payment set state='failed' where id = chp;
    raise exception 'C3 settled payment moved again';
  exception when others then
    if sqlerrm not like '%immutable%' then raise; end if;
  end;
  begin
    update deedbox.payment_reference set code='REF-changed' where id = pref;
    raise exception 'C4 reference re-coded';
  exception when others then
    if sqlerrm not like '%exactly one mutation%' then raise; end if;
  end;
  update deedbox.payment_reference set active=false where id = pref;

  ------------------------------------------------------------------
  -- 5. Interest: one active policy per scope; charge periods can
  --    never overlap; every charge carries its approval.
  ------------------------------------------------------------------
  insert into deedbox.interest_policy (scope, annual_rate_pct, grace_days, effective_from)
    values ('firm', 8.500, 30, current_date - 100) returning id into pol;
  begin
    insert into deedbox.interest_policy (scope, annual_rate_pct, grace_days, effective_from)
      values ('firm', 9.000, 30, current_date);
    raise exception 'I1 two active firm policies';
  exception when others then
    if sqlerrm not like '%duplicate key%' then raise; end if;
  end;
  begin
    update deedbox.interest_policy set annual_rate_pct = 12.000 where id = pol;
    raise exception 'I2 policy edited in place';
  exception when others then
    if sqlerrm not like '%immutable%' then raise; end if;
  end;
  insert into deedbox.interest_charge (bill, period_from, period_to, rate_pct_applied, amount,
                                       computed_by, approved_by, approved_at, supplementary_rendering)
    values (b1, current_date - 60, current_date - 31, 8.500, 12.34, 'system', s_admin, now(), 'artefact:int1');
  begin
    insert into deedbox.interest_charge (bill, period_from, period_to, rate_pct_applied, amount,
                                         computed_by, approved_by, approved_at, supplementary_rendering)
      values (b1, current_date - 40, current_date - 20, 8.500, 5.00, 'system', s_admin, now(), 'artefact:int2');
    raise exception 'I3 overlapping interest periods accepted';
  exception when others then
    if sqlerrm not like '%interest_charge_periods_disjoint%' and sqlerrm not like '%conflicting key%' then raise; end if;
  end;
  insert into deedbox.interest_charge (bill, period_from, period_to, rate_pct_applied, amount,
                                       computed_by, approved_by, approved_at, supplementary_rendering)
    values (b1, current_date - 30, current_date - 20, 8.500, 4.10, 'system', s_admin, now(), 'artefact:int3');

  ------------------------------------------------------------------
  -- 6. Arrangements: one live arrangement per bill; instalments are
  --    born scheduled and move forward; broken reactivates, finished
  --    never does.
  ------------------------------------------------------------------
  insert into deedbox.payment_arrangement (client_party, matter, instalment_amount, frequency, instalment_count)
    values (p1, m1, 250.00, 'weekly', 4) returning id into arr;
  insert into deedbox.arrangement_bill (arrangement, bill) values (arr, b1);
  declare arr2 bigint;
  begin
    insert into deedbox.payment_arrangement (client_party, matter, instalment_amount, frequency, instalment_count)
      values (p1, m1, 100.00, 'monthly', 2) returning id into arr2;
    insert into deedbox.arrangement_bill (arrangement, bill) values (arr2, b1);
    raise exception 'R1 a second live arrangement covered the bill';
  exception when others then
    if sqlerrm not like '%already covers bill%' then raise; end if;
  end;
  begin
    insert into deedbox.instalment (arrangement, sequence_no, due_date, amount, state)
      values (arr, 1, current_date + 7, 250.00, 'paid');
    raise exception 'R2 instalment born paid';
  exception when others then
    if sqlerrm not like '%born scheduled%' then raise; end if;
  end;
  insert into deedbox.instalment (arrangement, sequence_no, due_date, amount)
    values (arr, 1, current_date + 7, 250.00) returning id into inst;
  update deedbox.instalment set state='notified' where id = inst;
  if (select notified_at from deedbox.instalment where id = inst) is null then
    raise exception 'R3 notification not stamped';
  end if;
  update deedbox.instalment set state='missed' where id = inst;
  begin
    update deedbox.instalment set state='paid' where id = inst;
    raise exception 'R4 missed instalment resurrected';
  exception when others then
    if sqlerrm not like '%terminal%' then raise; end if;
  end;
  update deedbox.payment_arrangement set state='broken' where id = arr;
  if (select broken_at from deedbox.payment_arrangement where id = arr) is null then
    raise exception 'R5 broken_at not stamped';
  end if;
  update deedbox.payment_arrangement set state='active' where id = arr;   -- reactivation is sanctioned
  update deedbox.payment_arrangement set state='cancelled' where id = arr;
  begin
    update deedbox.payment_arrangement set state='active' where id = arr;
    raise exception 'R6 cancelled arrangement revived';
  exception when others then
    if sqlerrm not like '%illegal arrangement transition%' then raise; end if;
  end;

  ------------------------------------------------------------------
  -- 7. Reminders: one default sequence; step discipline; the per-bill
  --    state machine with the manual-hold fields; contact evidence.
  ------------------------------------------------------------------
  insert into deedbox.reminder_sequence (name, default_for_new_bills) values ('Standard', true) returning id into seq;
  begin
    insert into deedbox.reminder_sequence (name, default_for_new_bills) values ('Second default', true);
    raise exception 'M1 two default sequences';
  exception when others then
    if sqlerrm not like '%duplicate key%' then raise; end if;
  end;
  insert into deedbox.reminder_step (sequence, step_no, days_after_previous, channel) values (seq, 1, 7, 'email');
  begin
    insert into deedbox.reminder_step (sequence, step_no, days_after_previous, channel) values (seq, 1, 14, 'email');
    raise exception 'M2 duplicate step number';
  exception when others then
    if sqlerrm not like '%duplicate key%' then raise; end if;
  end;
  insert into deedbox.bill_reminder_state (bill, sequence, next_step_at)
    values (b1, seq, now() + interval '7 days') returning id into brs;
  begin
    update deedbox.bill_reminder_state set status='held_manual' where id = brs;
    raise exception 'M3 manual hold accepted without who, when and why';
  exception when others then
    if sqlerrm not like '%check%' then raise; end if;
  end;
  update deedbox.bill_reminder_state
     set status='held_manual', held_by=s_admin, held_at=now(), hold_reason='Client in hospital' where id = brs;
  update deedbox.bill_reminder_state set status='running' where id = brs;
  if (select hold_reason from deedbox.bill_reminder_state where id = brs) is not null then
    raise exception 'M4 resume did not clear the hold fields';
  end if;
  begin
    update deedbox.bill_reminder_state set status='stopped_paid' where id = brs;
    update deedbox.bill_reminder_state set status='exhausted' where id = brs;
    raise exception 'M5 stopped state jumped to exhausted';
  exception when others then
    if sqlerrm not like '%illegal reminder transition%' then raise; end if;
  end;
  insert into deedbox.reminder_contact (bill, step_no, channel) values (b1, 1, 'email');
  begin
    delete from deedbox.reminder_contact where bill = b1;
    raise exception 'M6 contact evidence deleted';
  exception when others then
    if sqlerrm not like '%append-only%' then raise; end if;
  end;

  ------------------------------------------------------------------
  -- 8. Top-ups: one open per policy; forward-only; issue carries its
  --    reference.
  ------------------------------------------------------------------
  insert into deedbox.matter_funds_policy (matter, minimum_threshold, target_amount, attach_to_next_bill, auto_issue)
    values (m1, 1000.00, 3000.00, false, false) returning id into fp;
  insert into deedbox.top_up_request (funds_policy, request_number, amount_requested, attach_to_next_bill, alerted_staff, state)
    values (fp, deedbox.allocate_number('top_up_request', null, current_date), 2000.00, false, s_law, 'pending_confirmation')
    returning id into tur;
  begin
    insert into deedbox.top_up_request (funds_policy, request_number, amount_requested, attach_to_next_bill, alerted_staff, state)
      values (fp, deedbox.allocate_number('top_up_request', null, current_date), 500.00, false, s_law, 'pending_confirmation');
    raise exception 'T1 two open top-up requests on one policy';
  exception when others then
    if sqlerrm not like '%duplicate key%' then raise; end if;
  end;
  begin
    update deedbox.top_up_request set state='issued' where id = tur;
    raise exception 'T2 issued without a payment reference';
  exception when others then
    if sqlerrm not like '%check%' then raise; end if;
  end;
  insert into deedbox.payment_reference (code, target_kind, target)
    values ('REF-tu-9x8c7v6b5n4m3k2j1h0g9f8d7s6a', 'top_up_request', tur) returning id into pref;
  update deedbox.top_up_request set state='issued', payment_reference=pref where id = tur;
  update deedbox.top_up_request set state='satisfied' where id = tur;
  begin
    update deedbox.top_up_request set state='cancelled' where id = tur;
    raise exception 'T3 satisfied request cancelled';
  exception when others then
    if sqlerrm not like '%immutable%' then raise; end if;
  end;

  ------------------------------------------------------------------
  -- 9. Application runs: the record layer's transitions; a completed
  --    item carries all three financial refs.
  ------------------------------------------------------------------
  insert into deedbox.bulk_operation (operation_kind, dry_run_summary, reversible_until)
    values ('funds_application', '{}', now() + interval '7 days') returning id into bo;
  insert into deedbox.application_run (run_by, scope, bulk_operation)
    values (s_admin, 'single_matter', bo) returning id into run1;
  insert into deedbox.funds_application (run, bill, amount)
    values (run1, b1, 100.00) returning id into fa;
  begin
    update deedbox.funds_application set item_state='completed' where id = fa;
    raise exception 'F1 completed without its financial writes';
  exception when others then
    if sqlerrm not like '%check%' then raise; end if;
  end;
  begin
    update deedbox.application_run set state='completed' where id = run1;
    raise exception 'F2 run completed without committing';
  exception when others then
    if sqlerrm not like '%illegal application-run transition%' then raise; end if;
  end;
  update deedbox.application_run set state='committing' where id = run1;
  update deedbox.application_run set state='completed_with_refusals' where id = run1;

  raise notice 'ALL 0011 POST-ISSUE RECEIVABLES TESTS PASSED';
end $$;

rollback;
