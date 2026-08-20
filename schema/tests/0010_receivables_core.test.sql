-- Tests for 0010_receivables_core. Run as deployment role AFTER 0001–0010.

begin;

insert into deedbox.country_pack (code, name) values ('AU-NSW','Australia (NSW)');
insert into deedbox.pack_version (pack, version) select id, '0.0.1' from deedbox.country_pack;
update deedbox.country_pack cp set active_version = pv.id from deedbox.pack_version pv where pv.pack = cp.id;
insert into deedbox.firm (name, operating_currency, timezone, country_pack)
  select 'Test Firm','AUD','Australia/Sydney', id from deedbox.country_pack;
insert into deedbox.office (name, code) values ('Sydney','SYD');

do $$
declare o bigint; r_admin bigint; r_lawyer bigint; s_admin bigint; s_law bigint;
        p1 bigint; p2 bigint; pa bigint; m1 bigint;
        run1 bigint; bg1 bigint; bg2 bigint; b1 bigint; b2 bigint; b3 bigint;
        l1 bigint; alloc bigint; pd1 bigint; pd2 bigint; pd3 bigint; g deedbox.payment_details;
        num text; cnt int;
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
  insert into deedbox.party (kind, display_name) values ('organisation','Payer Co') returning id into p2;
  insert into deedbox.party_name (party, name_kind, full_name, org_name) values (p2,'current','Payer Co','Payer Co');
  insert into deedbox.practice_area (name) values ('Litigation') returning id into pa;
  insert into deedbox.matter (matter_number, title, client_party, responsible_lawyer, office, practice_area)
    values (deedbox.allocate_number('matter', null, current_date), 'Receivables host', p1, s_law, o, pa) returning id into m1;

  ------------------------------------------------------------------
  -- 1. Payer sets: sum-to-100 enforced on the whole set at check time.
  ------------------------------------------------------------------
  insert into deedbox.matter_payer (matter, payer_party, share_pct) values (m1, p1, 60.00);
  insert into deedbox.matter_payer (matter, payer_party, share_pct) values (m1, p2, 40.00);
  set constraints deedbox.z_assert_payer_sum immediate;   -- the good set passes
  begin
    update deedbox.matter_payer set share_pct = 30.00 where matter = m1 and payer_party = p2;
    raise exception 'P1 a partial edit broke the sum and committed';
  exception when others then
    if sqlerrm not like '%sum to exactly 100.00%' then raise; end if;
  end;
  update deedbox.matter_payer set active = false where matter = m1;   -- whole set retired: empty is legal

  ------------------------------------------------------------------
  -- 2. Billing runs: forward-only machine.
  ------------------------------------------------------------------
  insert into deedbox.billing_run (run_by, filter_snapshot) values (s_admin, '{}') returning id into run1;
  begin
    update deedbox.billing_run set state='issued' where id = run1;
    raise exception 'building run jumped to issued';
  exception when others then
    if sqlerrm not like '%illegal billing-run transition%' then raise; end if;
  end;
  update deedbox.billing_run set state='in_review' where id = run1;
  update deedbox.billing_run set state='abandoned' where id = run1;
  begin
    update deedbox.billing_run set filter_snapshot='{"late":true}' where id = run1;
    raise exception 'finished run rewritten';
  exception when others then
    if sqlerrm not like '%immutable%' then raise; end if;
  end;

  ------------------------------------------------------------------
  -- 3. Bills: born draft on their group's matter; issue-time
  --    completeness is physical; issued bills are immutable and
  --    undeletable; the group mirrors its members.
  ------------------------------------------------------------------
  insert into deedbox.bill_group (matter, matter_total, payer_share_snapshot)
    values (m1, 1000.00, '[]') returning id into bg1;
  begin
    insert into deedbox.bill (bill_group, matter, payer_party, state)
      values (bg1, m1, p1, 'issued');
    raise exception 'bill born issued';
  exception when others then
    if sqlerrm not like '%born draft%' then raise; end if;
  end;
  insert into deedbox.bill (bill_group, matter, payer_party) values (bg1, m1, p1) returning id into b1;
  begin
    update deedbox.bill set state='issued' where id = b1;   -- nothing issue-complete
    raise exception 'issued without number, dates and rendering';
  exception when others then
    if sqlerrm not like '%check%' then raise; end if;
  end;
  num := deedbox.allocate_number('bill', null, current_date);
  update deedbox.bill
     set state='issued', bill_number=num, issue_date=current_date,
         terms_days_applied=14, due_date=current_date + 14, rendered_artefact='artefact:test'
   where id = b1;
  if (select state from deedbox.bill_group where id = bg1) <> 'issued' then
    raise exception 'group mirror did not follow its issued member';
  end if;
  begin
    update deedbox.bill set due_date=current_date + 30 where id = b1;
    raise exception 'issued bill edited';
  exception when others then
    if sqlerrm not like '%immutable%' then raise; end if;
  end;
  begin
    delete from deedbox.bill where id = b1;
    raise exception 'issued bill deleted';
  exception when others then
    if sqlerrm not like '%never deleted%' then raise; end if;
  end;
  begin
    update deedbox.bill_group set matter_total=2000.00 where id = bg1;
    raise exception 'issued group total rewritten';
  exception when others then
    if sqlerrm not like '%immutable%' then raise; end if;
  end;

  -- siblings issue as one unit; a part-issued group cannot stand at check.
  insert into deedbox.bill_group (matter, matter_total, payer_share_snapshot)
    values (m1, 500.00, '[]') returning id into bg2;
  insert into deedbox.bill (bill_group, matter, payer_party, share_pct) values (bg2, m1, p1, 50) returning id into b2;
  insert into deedbox.bill (bill_group, matter, payer_party, share_pct) values (bg2, m1, p2, 50) returning id into b3;
  begin
    update deedbox.bill
       set state='issued', bill_number=deedbox.allocate_number('bill', null, current_date),
           issue_date=current_date, terms_days_applied=14, due_date=current_date+14,
           rendered_artefact='artefact:test2'
     where id = b2;
    set constraints deedbox.z_assert_sibling_issue immediate;
    raise exception 'part-issued sibling group stood at check';
  exception when others then
    if sqlerrm not like '%siblings issue as one unit%' then raise; end if;
  end;
  -- a draft delete abandons the group when the last draft goes.
  delete from deedbox.bill where id = b2;
  delete from deedbox.bill where id = b3;
  if (select state from deedbox.bill_group where id = bg2) <> 'abandoned' then
    raise exception 'emptied group not abandoned';
  end if;

  ------------------------------------------------------------------
  -- 4. Lines: drafted onto draft bills only; write-down discipline;
  --    issued lines immutable.
  ------------------------------------------------------------------
  begin
    insert into deedbox.bill_line (bill, position, kind, description, original_value, amount, tax_treatment, tax_amount, category_key)
      values (b1, 1, 'manual', 'late line', 100, 100, 'standard', 0, 'chargeable');
    raise exception 'line drafted onto an issued bill';
  exception when others then
    if sqlerrm not like '%draft bills only%' then raise; end if;
  end;
  insert into deedbox.bill_group (matter, matter_total, payer_share_snapshot)
    values (m1, 300.00, '[]') returning id into bg2;
  insert into deedbox.bill (bill_group, matter, payer_party) values (bg2, m1, p1) returning id into b2;
  begin
    insert into deedbox.bill_line (bill, position, kind, description, original_value, written_down_to, amount, tax_treatment, tax_amount, category_key)
      values (b2, 1, 'time', 'written down, no reason', 300, 200, 200, 'standard', 0, 'chargeable');
    raise exception 'write-down accepted without a reason';
  exception when others then
    if sqlerrm not like '%check%' then raise; end if;
  end;
  begin
    insert into deedbox.bill_line (bill, position, kind, description, original_value, written_down_to, write_down_reason, amount, tax_treatment, tax_amount, category_key)
      values (b2, 1, 'time', 'amount off', 300, 200, 'client hardship', 300, 'standard', 0, 'chargeable');
    raise exception 'amount disagreeing with the write-down accepted';
  exception when others then
    if sqlerrm not like '%check%' then raise; end if;
  end;
  insert into deedbox.bill_line (bill, position, kind, description, original_value, written_down_to, write_down_reason, amount, tax_treatment, tax_amount, category_key)
    values (b2, 1, 'time', 'good line', 300, 200, 'client hardship', 200, 'standard', 0, 'chargeable') returning id into l1;
  update deedbox.bill
     set state='issued', bill_number=deedbox.allocate_number('bill', null, current_date),
         issue_date=current_date, terms_days_applied=14, due_date=current_date+14,
         rendered_artefact='artefact:test3'
   where id = b2;
  begin
    update deedbox.bill_line set description='revised after issue' where id = l1;
    raise exception 'issued line edited';
  exception when others then
    if sqlerrm not like '%immutable%' then raise; end if;
  end;

  ------------------------------------------------------------------
  -- 5. The bill journal: issued bills only; append-only; one issue
  --    total; signs by kind; dense numbering; reversals mirror their
  --    target once; outstanding never below zero.
  ------------------------------------------------------------------
  insert into deedbox.bill_group (matter, matter_total, payer_share_snapshot)
    values (m1, 100.00, '[]') returning id into bg2;
  insert into deedbox.bill (bill_group, matter, payer_party) values (bg2, m1, p1) returning id into b3;
  begin
    insert into deedbox.bill_journal_entry (bill, entry_kind, signed_amount, source_type, source, effective_date, entered_by)
      values (b3, 'issue_total', 100.00, 'bill', b3, current_date, s_admin);
    raise exception 'journal entry on a draft bill';
  exception when others then
    if sqlerrm not like '%ISSUED bills%' then raise; end if;
  end;
  update deedbox.bill
     set state='issued', bill_number=deedbox.allocate_number('bill', null, current_date),
         issue_date=current_date, terms_days_applied=14, due_date=current_date+14,
         rendered_artefact='artefact:test4'
   where id = b3;
  insert into deedbox.bill_journal_entry (bill, entry_kind, signed_amount, source_type, source, effective_date, entered_by)
    values (b3, 'issue_total', 1000.00, 'bill', b3, current_date, s_admin);
  begin
    insert into deedbox.bill_journal_entry (bill, entry_kind, signed_amount, source_type, source, effective_date, entered_by)
      values (b3, 'issue_total', 500.00, 'bill', b3, current_date, s_admin);
    raise exception 'second issue total accepted';
  exception when others then
    if sqlerrm not like '%duplicate key%' then raise; end if;
  end;
  begin
    insert into deedbox.bill_journal_entry (bill, entry_kind, signed_amount, source_type, source, effective_date, entered_by)
      values (b3, 'payment_allocation', 400.00, 'payment', 1, current_date, s_admin);
    raise exception 'positive allocation accepted';
  exception when others then
    if sqlerrm not like '%check%' then raise; end if;
  end;
  insert into deedbox.bill_journal_entry (bill, entry_kind, signed_amount, source_type, source, effective_date, entered_by)
    values (b3, 'payment_allocation', -400.00, 'payment', 1, current_date, s_admin) returning id into alloc;
  begin
    insert into deedbox.bill_journal_entry (bill, entry_kind, signed_amount, source_type, source, effective_date, entered_by, reason)
      values (b3, 'write_off', -700.00, 'write_off', 1, current_date, s_admin, 'too generous');
    raise exception 'outstanding driven below zero';
  exception when others then
    if sqlerrm not like '%below zero%' then raise; end if;
  end;
  begin
    insert into deedbox.bill_journal_entry (bill, entry_kind, signed_amount, source_type, source, effective_date, entered_by)
      values (b3, 'write_off', -100.00, 'write_off', 1, current_date, s_admin);
    raise exception 'write-off accepted without a reason';
  exception when others then
    if sqlerrm not like '%check%' then raise; end if;
  end;
  begin
    insert into deedbox.bill_journal_entry (bill, entry_kind, signed_amount, source_type, source, effective_date, entered_by, reverses, reason)
      values (b3, 'reversal', 500.00, 'journal', alloc, current_date, s_admin, alloc, 'wrong amount');
    raise exception 'reversal not mirroring its target accepted';
  exception when others then
    if sqlerrm not like '%mirrors its target exactly%' then raise; end if;
  end;
  insert into deedbox.bill_journal_entry (bill, entry_kind, signed_amount, source_type, source, effective_date, entered_by, reverses, reason)
    values (b3, 'reversal', 400.00, 'journal', alloc, current_date, s_admin, alloc, 'allocated to the wrong bill');
  begin
    insert into deedbox.bill_journal_entry (bill, entry_kind, signed_amount, source_type, source, effective_date, entered_by, reverses, reason)
      values (b3, 'reversal', 400.00, 'journal', alloc, current_date, s_admin, alloc, 'again');
    raise exception 'second reversal of one entry accepted';
  exception when others then
    if sqlerrm not like '%duplicate key%' then raise; end if;
  end;
  begin
    update deedbox.bill_journal_entry set signed_amount = -1.00 where id = alloc;
    raise exception 'journal entry rewritten';
  exception when others then
    if sqlerrm not like '%append-only%' then raise; end if;
  end;
  if (select array_agg(j.entry_no order by j.entry_no)
        from deedbox.bill_journal_entry j where j.bill = b3) <> array[1,2,3] then
    raise exception 'journal numbering not dense';
  end if;
  if deedbox.bill_outstanding(b3) <> 1000.00 then
    raise exception 'outstanding wrong after allocation + reversal: %', deedbox.bill_outstanding(b3);
  end if;

  ------------------------------------------------------------------
  -- 6. Payment details: versioned, one pending, approver separation,
  --    the governing version supersedes its predecessor.
  ------------------------------------------------------------------
  insert into deedbox.payment_details (account_holder_name, bank_name, identifier_values, state, created_by, approved_by, approved_at)
    values ('Test Firm Trading Pty Ltd', 'Big Bank', '{"bsb":"012-345","account":"123456789"}', 'approved', s_admin, s_admin, now())
    returning id into pd1;
  g := deedbox.governing_payment_details();
  if g.id <> pd1 then
    raise exception 'born-approved version not governing';
  end if;
  insert into deedbox.payment_details (account_holder_name, bank_name, identifier_values, state, created_by)
    values ('Test Firm Trading Pty Ltd', 'New Bank', '{"bsb":"999-000","account":"555"}', 'pending', s_law)
    returning id into pd2;
  g := deedbox.governing_payment_details();
  if g.id <> pd1 then
    raise exception 'a pending version governed before approval';
  end if;
  begin
    insert into deedbox.payment_details (account_holder_name, bank_name, identifier_values, state, created_by)
      values ('X', 'Y', '{}', 'pending', s_law);
    raise exception 'two pending versions at once';
  exception when others then
    if sqlerrm not like '%duplicate key%' then raise; end if;
  end;
  begin
    update deedbox.payment_details set state='approved', approved_by=s_law, approved_at=now() where id = pd2;
    raise exception 'author approved their own payment details';
  exception when others then
    if sqlerrm not like '%different approver%' then raise; end if;
  end;
  update deedbox.payment_details set state='approved', approved_by=s_admin, approved_at=now() where id = pd2;
  g := deedbox.governing_payment_details();
  if g.id <> pd2 then
    raise exception 'approved version did not take over';
  end if;
  if (select superseded_at from deedbox.payment_details where id = pd1) is null then
    raise exception 'predecessor not stamped superseded';
  end if;
  begin
    update deedbox.payment_details set bank_name='Rewritten Bank' where id = pd1;
    raise exception 'superseded version rewritten';
  exception when others then
    if sqlerrm not like '%immutable%' then raise; end if;
  end;
  begin
    delete from deedbox.payment_details where id = pd1;
    raise exception 'payment-details version deleted';
  exception when others then
    if sqlerrm not like '%never deleted%' then raise; end if;
  end;
  insert into deedbox.payment_details (account_holder_name, bank_name, identifier_values, state, created_by, approved_by, approved_at)
    values ('Test Firm Trading Pty Ltd', 'Third Bank', '{}', 'approved', s_admin, s_admin, now())
    returning id into pd3;
  if (select version_no from deedbox.payment_details where id = pd3) <> 3 then
    raise exception 'version numbering not dense';
  end if;
  g := deedbox.governing_payment_details();
  if g.id <> pd3 then
    raise exception 'latest approval not governing';
  end if;

  raise notice 'ALL 0010 RECEIVABLES-CORE TESTS PASSED';
end $$;

rollback;
