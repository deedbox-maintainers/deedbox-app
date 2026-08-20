-- Tests for 0013_money_documents. Run as deployment role AFTER 0001–0013.

begin;

insert into deedbox.country_pack (code, name) values ('AU-NSW','Australia (NSW)');
insert into deedbox.pack_version (pack, version) select id, '0.0.1' from deedbox.country_pack;
update deedbox.country_pack cp set active_version = pv.id from deedbox.pack_version pv where pv.pack = cp.id;
insert into deedbox.firm (name, operating_currency, timezone, country_pack)
  select 'Test Firm','AUD','Australia/Sydney', id from deedbox.country_pack;
insert into deedbox.office (name, code) values ('Sydney','SYD');

do $$
declare o bigint; r_admin bigint; r_lawyer bigint; s_admin bigint; s_law bigint;
        p1 bigint; pa bigint; m1 bigint; acct bigint; led1 bigint; led2 bigint; m2 bigint;
        em1 bigint; em2 bigint; auth bigint; txn bigint; rcpt bigint; rxn bigint;
        bg bigint; b1 bigint; ent bigint; pay bigint; ins bigint; ins2 bigint; num text;
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
    values (deedbox.allocate_number('matter', null, current_date), 'Docs host', p1, s_law, o, pa) returning id into m1;
  insert into deedbox.matter (matter_number, title, client_party, responsible_lawyer, office, practice_area)
    values (deedbox.allocate_number('matter', null, current_date), 'Docs host 2', p1, s_law, o, pa) returning id into m2;
  insert into deedbox.client_account (name, account_kind) values ('Trust A', 'pooled') returning id into acct;
  insert into deedbox.matter_ledger (account, matter) values (acct, m1) returning id into led1;
  insert into deedbox.matter_ledger (account, matter) values (acct, m2) returning id into led2;

  -- fund led1 with 1000.
  txn := deedbox.post_money_transaction('receipt', current_date, s_admin, 'money_receipt', 100,
    jsonb_build_array(
      jsonb_build_object('side','cash_book','account',acct,'signed_amount',1000.00),
      jsonb_build_object('side','matter_ledger','account',acct,'matter_ledger',led1,'signed_amount',1000.00)));

  ------------------------------------------------------------------
  -- 1. Earmarks: coverage at placement and at every movement;
  --    available is the one shared figure; the dishonour auto-release.
  ------------------------------------------------------------------
  insert into deedbox.earmark (matter_ledger, amount, purpose, placed_by)
    values (led1, 600.00, 'counsel fees', s_admin) returning id into em1;
  begin
    insert into deedbox.earmark (matter_ledger, amount, purpose, placed_by)
      values (led1, 500.00, 'over-reserving', s_admin);
    raise exception 'earmarks exceeded the balance';
  exception when others then
    if sqlerrm not like '%exceed the ledger balance%' then raise; end if;
  end;
  if deedbox.ledger_available(led1) <> 400.00 then
    raise exception 'available wrong: %', deedbox.ledger_available(led1);
  end if;

  -- placeholder subject far above any real payment id: the approval-counting
  -- guard reads (subject_type, subject) and must never find fixture rows.
  insert into deedbox.payment_authorisation (subject_type, subject, authoriser, decision)
    values ('money_payment', 901001, s_admin, 'approved') returning id into auth;
  begin
    perform deedbox.post_money_transaction('payment_out', current_date, s_admin, 'money_payment', 101,
      jsonb_build_array(
        jsonb_build_object('side','cash_book','account',acct,'signed_amount',-500.00),
        jsonb_build_object('side','matter_ledger','account',acct,'matter_ledger',led1,'signed_amount',-500.00)),
      'ignores the reservation', auth);
    raise exception 'movement left balance under the earmarks';
  exception when others then
    if sqlerrm not like '%earmark shortfall%' then raise; end if;
  end;

  -- the system dishonour path: balance drops under the earmarks, the excess
  -- releases newest-first in the same transaction.
  insert into deedbox.earmark (matter_ledger, amount, purpose, placed_by)
    values (led1, 300.00, 'settlement holdback', s_admin) returning id into em2;
  perform set_config('deedbox.principal_kind','system_job', true);
  rxn := deedbox.post_money_transaction('reversal', current_date, s_admin, 'instrument_event', 1,
    jsonb_build_array(
      jsonb_build_object('side','cash_book','account',acct,'signed_amount',-1000.00),
      jsonb_build_object('side','matter_ledger','account',acct,'matter_ledger',led1,'signed_amount',-1000.00)),
    'bank dishonour of the funding receipt', null, txn);
  perform set_config('deedbox.principal_kind','', true);
  if deedbox.ledger_balance(led1) <> 0 then
    raise exception 'dishonour mirror did not land';
  end if;
  if (select state from deedbox.earmark where id = em2) <> 'released'
     or (select state from deedbox.earmark where id = em1) <> 'released' then
    raise exception 'dishonour shortfall did not release the earmarks';
  end if;

  ------------------------------------------------------------------
  -- 2. Receipt documents: payer-or-description; one per transaction;
  --    cancellation is derived from the reversal, never a flag.
  ------------------------------------------------------------------
  begin
    insert into deedbox.money_receipt (matter_ledger, receipt_number, method, received_date, amount, transaction, printable_artefact)
      values (led1, 'R-000001', 'electronic_transfer', current_date, 1000.00, txn, 'artefact:r1');
    raise exception 'receipt accepted with neither payer nor description';
  exception when others then
    if sqlerrm not like '%check%' then raise; end if;
  end;
  insert into deedbox.money_receipt (matter_ledger, receipt_number, payer_party, method, received_date, amount, transaction, printable_artefact)
    values (led1, deedbox.allocate_number('money_receipt', null, current_date), p1,
            'electronic_transfer', current_date, 1000.00, txn, 'artefact:r1') returning id into rcpt;
  if not deedbox.receipt_cancelled(rcpt) then
    raise exception 'the dishonoured receipt does not read as cancelled';
  end if;
  begin
    update deedbox.money_receipt set amount = 1.00 where id = rcpt;
    raise exception 'receipt rewritten';
  exception when others then
    if sqlerrm not like '%append-only%' then raise; end if;
  end;

  ------------------------------------------------------------------
  -- 3. Entitlements: issued-bill basis; headroom; the firm transfer
  --    executes only on an actionable entitlement.
  ------------------------------------------------------------------
  insert into deedbox.bill_group (matter, matter_total, payer_share_snapshot) values (m1, 500.00, '[]') returning id into bg;
  insert into deedbox.bill (bill_group, matter, payer_party) values (bg, m1, p1) returning id into b1;
  begin
    insert into deedbox.entitlement (matter_ledger, basis_kind, bill, amount, notice_required)
      values (led1, 'rendered_bill', b1, 100.00, false);
    raise exception 'entitlement rested on a draft bill';
  exception when others then
    if sqlerrm not like '%ISSUED, rendered bill%' then raise; end if;
  end;
  update deedbox.bill
     set state='issued', bill_number=deedbox.allocate_number('bill', null, current_date),
         issue_date=current_date, terms_days_applied=14, due_date=current_date+14,
         rendered_artefact='artefact:b1'
   where id = b1;
  insert into deedbox.bill_journal_entry (bill, entry_kind, signed_amount, source_type, source, effective_date, entered_by)
    values (b1, 'issue_total', 500.00, 'bill', b1, current_date, s_admin);
  begin
    insert into deedbox.entitlement (matter_ledger, basis_kind, bill, amount, notice_required)
      values (led1, 'rendered_bill', b1, 600.00, false);
    raise exception 'entitlement exceeded the bill''s outstanding';
  exception when others then
    if sqlerrm not like '%never exceeds the bill%' then raise; end if;
  end;
  insert into deedbox.entitlement (matter_ledger, basis_kind, bill, amount, notice_required)
    values (led1, 'rendered_bill', b1, 400.00, false) returning id into ent;
  if deedbox.entitlement_status(ent) <> 'actionable' then
    raise exception 'no-notice entitlement not born actionable: %', deedbox.entitlement_status(ent);
  end if;

  ------------------------------------------------------------------
  -- 4. The payment machine: draft → pending (frozen approvals count)
  --    → authorised (counted approvals) → executed (number + posting);
  --    substance frozen after submission.
  ------------------------------------------------------------------
  -- refund the ledger so payments can execute.
  txn := deedbox.post_money_transaction('receipt', current_date, s_admin, 'money_receipt', 102,
    jsonb_build_array(
      jsonb_build_object('side','cash_book','account',acct,'signed_amount',800.00),
      jsonb_build_object('side','matter_ledger','account',acct,'matter_ledger',led1,'signed_amount',800.00)));

  insert into deedbox.money_payment (matter_ledger, payee_party, method, amount, reason, requested_by, purpose, entitlement)
    values (led1, p1, 'electronic_transfer', 300.00, 'transfer of billed costs', s_law, 'firm_transfer', ent)
    returning id into pay;
  begin
    update deedbox.money_payment set state='pending_authorisation' where id = pay;
    raise exception 'P1 submission without the frozen approvals count';
  exception when others then
    if sqlerrm not like '%freezes the required approvals%' then raise; end if;
  end;
  update deedbox.money_payment set state='pending_authorisation', required_authorisations=2 where id = pay;
  begin
    update deedbox.money_payment set amount = 999.00 where id = pay;
    raise exception 'P2 submitted payment substance edited';
  exception when others then
    if sqlerrm not like '%substance is frozen%' then raise; end if;
  end;
  insert into deedbox.payment_authorisation (subject_type, subject, authoriser, decision)
    values ('money_payment', pay, s_admin, 'approved');
  begin
    update deedbox.money_payment set state='authorised' where id = pay;
    raise exception 'P3 premature authorisation accepted';
  exception when others then
    if sqlerrm not like '%needs 2 approvals%' then raise; end if;
  end;
  insert into deedbox.payment_authorisation (subject_type, subject, authoriser, decision)
    values ('money_payment', pay, s_law, 'approved');
  update deedbox.money_payment set state='authorised' where id = pay;

  -- execution: the posting + the gapless number in one act.
  insert into deedbox.payment_authorisation (subject_type, subject, authoriser, decision)
    values ('money_payment', pay, s_admin, 'approved') returning id into auth;
  txn := deedbox.post_money_transaction('firm_transfer', current_date, s_admin, 'money_payment', pay,
    jsonb_build_array(
      jsonb_build_object('side','cash_book','account',acct,'signed_amount',-300.00),
      jsonb_build_object('side','matter_ledger','account',acct,'matter_ledger',led1,'signed_amount',-300.00)),
    'transfer of billed costs', auth);
  num := deedbox.allocate_number('money_payment', null, current_date);
  update deedbox.money_payment set state='executed', transaction=txn, payment_number=num where id = pay;
  if deedbox.entitlement_consumed(ent) <> 300.00 then
    raise exception 'consumption not derived from the executed payment';
  end if;

  -- headroom: a second firm transfer over the remainder is refused.
  insert into deedbox.money_payment (matter_ledger, payee_party, method, amount, reason, requested_by, purpose, entitlement)
    values (led1, p1, 'electronic_transfer', 200.00, 'over the remaining entitlement', s_law, 'firm_transfer', ent)
    returning id into pay;
  update deedbox.money_payment set state='pending_authorisation', required_authorisations=1 where id = pay;
  insert into deedbox.payment_authorisation (subject_type, subject, authoriser, decision)
    values ('money_payment', pay, s_admin, 'approved');
  update deedbox.money_payment set state='authorised' where id = pay;
  begin
    update deedbox.money_payment set state='executed', transaction=txn, payment_number='PX-1' where id = pay;
    raise exception 'firm transfer exceeded the entitlement headroom';
  exception when others then
    if sqlerrm not like '%remaining headroom%' then raise; end if;
  end;
  begin
    update deedbox.entitlement set cancelled_at=now(), cancelled_by=s_admin where id = ent;
    raise exception 'consumed entitlement cancelled';
  exception when others then
    if sqlerrm not like '%no longer be cancelled%' then raise; end if;
  end;

  ------------------------------------------------------------------
  -- 5. Transfer documents: one account for ledger transfers.
  ------------------------------------------------------------------
  insert into deedbox.payment_authorisation (subject_type, subject, authoriser, decision)
    values ('ledger_transfer', 1, s_admin, 'approved') returning id into auth;
  txn := deedbox.post_money_transaction('ledger_transfer', current_date, s_admin, 'ledger_transfer', 1,
    jsonb_build_array(
      jsonb_build_object('side','matter_ledger','account',acct,'matter_ledger',led1,'signed_amount',-100.00),
      jsonb_build_object('side','matter_ledger','account',acct,'matter_ledger',led2,'signed_amount',100.00)),
    'shared costs', auth);
  insert into deedbox.ledger_transfer (from_ledger, to_ledger, amount, reason, authorisation, transfer_number, transaction)
    values (led1, led2, 100.00, 'shared costs', auth,
            deedbox.allocate_number('ledger_transfer', null, current_date), txn);
  begin
    update deedbox.ledger_transfer set amount = 1.00 where transaction = txn;
    raise exception 'T1 transfer document rewritten';
  exception when others then
    if sqlerrm not like '%append-only%' then raise; end if;
  end;

  ------------------------------------------------------------------
  -- 6. Instruments: born states; the outbound and inbound machines;
  --    evidence links demanded by the transitions; terminal frozen.
  ------------------------------------------------------------------
  begin
    insert into deedbox.instrument (account, direction, instrument_kind, number, amount, state, stale_after, source_type, source, transaction)
      values (acct, 'outbound', 'cheque', '000101', 100.00, 'presented', current_date + 180, 'money_payment', pay, txn);
    raise exception 'outbound instrument born presented';
  exception when others then
    if sqlerrm not like '%born created%' then raise; end if;
  end;
  insert into deedbox.instrument (account, direction, instrument_kind, number, amount, state, stale_after, source_type, source, transaction)
    values (acct, 'outbound', 'cheque', '000101', 100.00, 'created', current_date + 180, 'money_payment', pay, txn)
    returning id into ins;
  begin
    update deedbox.instrument set state='cancelled' where id = ins;
    raise exception 'cancellation without its reversal';
  exception when others then
    if sqlerrm not like '%posts its reversal%' then raise; end if;
  end;
  update deedbox.instrument set state='stale' where id = ins;
  update deedbox.instrument set state='presented' where id = ins;   -- the late-honour return
  begin
    update deedbox.instrument set state='stale' where id = ins;
    raise exception 'terminal instrument moved';
  exception when others then
    if sqlerrm not like '%immutable%' and sqlerrm not like '%illegal outbound%' then raise; end if;
  end;
  insert into deedbox.instrument (account, direction, instrument_kind, number, amount, state, stale_after, source_type, source, transaction)
    values (acct, 'inbound', 'cheque', '000102', 50.00, 'received', current_date + 180, 'money_receipt', rcpt, txn)
    returning id into ins2;
  update deedbox.instrument set state='banked' where id = ins2;
  begin
    update deedbox.instrument set state='dishonoured' where id = ins2;
    raise exception 'dishonour without its reversal link';
  exception when others then
    if sqlerrm not like '%posts its system reversal%' then raise; end if;
  end;
  update deedbox.instrument set state='dishonoured', dishonour_reversal=rxn where id = ins2;

  -- (The close guard's active-earmark clause is defence-in-depth only:
  -- the coverage rule keeps balance >= active earmarks, so a zero-balance
  -- ledger can never hold one — the clause is untestable by construction.
  -- The instrument clause is exercised in the next block.)
end $$;

do $$
declare o bigint; r_admin bigint; s_admin bigint; p1 bigint; pa bigint; m1 bigint;
        acct bigint; led1 bigint; txn bigint; r_lawyer bigint; s_law bigint;
begin
  select id into o from deedbox.office limit 1;
  select id into r_admin from deedbox.role where system_key='administrator';
  select id into r_lawyer from deedbox.role where system_key='lawyer';
  insert into deedbox.staff_member (person_name, login, role, office, email)
    values ('{"display":"Cal Admin"}','cal', r_admin, o, 'cal@x.test') returning id into s_admin;
  insert into deedbox.staff_member (person_name, login, role, office, email)
    values ('{"display":"Dee Lawyer"}','dee', r_lawyer, o, 'dee@x.test') returning id into s_law;
  insert into deedbox.party (kind, display_name) values ('person','Cli3') returning id into p1;
  insert into deedbox.party_name (party, name_kind, full_name) values (p1,'current','Cli3');
  insert into deedbox.practice_area (name) values ('Estates Work') returning id into pa;
  insert into deedbox.matter (matter_number, title, client_party, responsible_lawyer, office, practice_area)
    values (deedbox.allocate_number('matter', null, current_date), 'Close host', p1, s_law, o, pa) returning id into m1;
  insert into deedbox.client_account (name, account_kind) values ('Trust B', 'pooled') returning id into acct;
  insert into deedbox.matter_ledger (account, matter) values (acct, m1) returning id into led1;

  -- an outstanding inbound instrument holds the ledger open even at zero.
  txn := deedbox.post_money_transaction('receipt', current_date, s_admin, 'money_receipt', 200,
    jsonb_build_array(
      jsonb_build_object('side','cash_book','account',acct,'signed_amount',75.00),
      jsonb_build_object('side','matter_ledger','account',acct,'matter_ledger',led1,'signed_amount',75.00)));
  insert into deedbox.instrument (account, direction, instrument_kind, number, amount, state, stale_after, source_type, source, transaction)
    values (acct, 'inbound', 'cheque', '000201', 75.00, 'received', current_date + 180, 'money_receipt', 1, txn);
  perform set_config('deedbox.principal_kind','system_job', true);
  perform deedbox.post_money_transaction('reversal', current_date, s_admin, 'instrument_event', 1,
    jsonb_build_array(
      jsonb_build_object('side','cash_book','account',acct,'signed_amount',-75.00),
      jsonb_build_object('side','matter_ledger','account',acct,'matter_ledger',led1,'signed_amount',-75.00)),
    'test drain', null, txn);
  perform set_config('deedbox.principal_kind','', true);
  begin
    update deedbox.matter_ledger set status='closed', closing_copy='artefact:c' where id = led1;
    raise exception 'ledger closed around an outstanding instrument';
  exception when others then
    if sqlerrm not like '%terminal-good states%' then raise; end if;
  end;
  update deedbox.instrument set state='banked' where account=acct and number='000201';
  update deedbox.instrument set state='cleared' where account=acct and number='000201';
  update deedbox.matter_ledger set status='closed', closing_copy='artefact:c' where id = led1;
  if (select status from deedbox.matter_ledger where id = led1) <> 'closed' then
    raise exception 'clean close refused';
  end if;

  raise notice 'ALL 0013 MONEY-DOCUMENTS TESTS PASSED';
end $$;

rollback;
