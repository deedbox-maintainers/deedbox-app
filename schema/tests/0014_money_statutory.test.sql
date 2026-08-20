-- Tests for 0014_money_statutory. Run as deployment role AFTER 0001–0014.

begin;

insert into deedbox.country_pack (code, name) values ('AU-NSW','Australia (NSW)');
insert into deedbox.pack_version (pack, version) select id, '0.0.1' from deedbox.country_pack;
update deedbox.country_pack cp set active_version = pv.id from deedbox.pack_version pv where pv.pack = cp.id;
insert into deedbox.firm (name, operating_currency, timezone, country_pack)
  select 'Test Firm','AUD','Australia/Sydney', id from deedbox.country_pack;
insert into deedbox.office (name, code) values ('Sydney','SYD');

do $$
declare o bigint; r_admin bigint; r_lawyer bigint; s_admin bigint; s_law bigint;
        p1 bigint; pa bigint; m1 bigint; m2 bigint;
        acctA bigint; acctB bigint; acctC bigint; ledA bigint; ledB bigint; ledC bigint;
        txnA bigint; txnB bigint; slA bigint; slB bigint; slB2 bigint;
        recA bigint; recB bigint; recC bigint; grp bigint; exc bigint; exc2 bigint;
        ins bigint; pc bigint; auth bigint; dc bigint; inc bigint; ref1 bigint;
        stmt bigint; reg bigint; txn bigint;
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
    values (deedbox.allocate_number('matter', null, current_date), 'Statutory host', p1, s_law, o, pa) returning id into m1;
  insert into deedbox.matter (matter_number, title, client_party, responsible_lawyer, office, practice_area)
    values (deedbox.allocate_number('matter', null, current_date), 'Statutory host 2', p1, s_law, o, pa) returning id into m2;
  insert into deedbox.client_account (name, account_kind) values ('Trust R1', 'pooled') returning id into acctA;
  insert into deedbox.client_account (name, account_kind) values ('Trust R2', 'pooled') returning id into acctB;
  insert into deedbox.matter_ledger (account, matter) values (acctA, m1) returning id into ledA;
  insert into deedbox.matter_ledger (account, matter) values (acctB, m2) returning id into ledB;

  txnA := deedbox.post_money_transaction('receipt', current_date, s_admin, 'money_receipt', 300,
    jsonb_build_array(
      jsonb_build_object('side','cash_book','account',acctA,'signed_amount',500.00),
      jsonb_build_object('side','matter_ledger','account',acctA,'matter_ledger',ledA,'signed_amount',500.00)));
  txnB := deedbox.post_money_transaction('receipt', current_date, s_admin, 'money_receipt', 301,
    jsonb_build_array(
      jsonb_build_object('side','cash_book','account',acctB,'signed_amount',300.00),
      jsonb_build_object('side','matter_ledger','account',acctB,'matter_ledger',ledB,'signed_amount',300.00)));

  ------------------------------------------------------------------
  -- 1. Statement lines: feed idempotency, append-only.
  ------------------------------------------------------------------
  insert into deedbox.bank_statement_line (account, line_date, amount, description, source, feed_ref)
    values (acctA, current_date, 500.00, 'DEP CLI', 'bank_feed', 'feed-1') returning id into slA;
  begin
    insert into deedbox.bank_statement_line (account, line_date, amount, description, source, feed_ref)
      values (acctA, current_date, 500.00, 'DEP CLI replay', 'bank_feed', 'feed-1');
    raise exception 'replayed feed line accepted';
  exception when others then
    if sqlerrm not like '%duplicate key%' then raise; end if;
  end;
  begin
    update deedbox.bank_statement_line set amount = 1.00 where id = slA;
    raise exception 'statement line rewritten';
  exception when others then
    if sqlerrm not like '%append-only%' then raise; end if;
  end;

  ------------------------------------------------------------------
  -- 2. Reconciliation: one in-progress per account; unbalanced groups
  --    and uncovered lines refuse certification; the equation binds;
  --    a clean build certifies, transitions covered instruments, and
  --    locks its matches forever.
  ------------------------------------------------------------------
  insert into deedbox.reconciliation (account, statement_date, statement_balance)
    values (acctA, current_date, 500.00) returning id into recA;
  begin
    insert into deedbox.reconciliation (account, statement_date, statement_balance)
      values (acctA, current_date + 1, 0);
    raise exception 'two in-progress builds on one account';
  exception when others then
    if sqlerrm not like '%duplicate key%' then raise; end if;
  end;

  insert into deedbox.recon_match (reconciliation) values (recA) returning id into grp;
  insert into deedbox.recon_match_member (match_group, member_kind, statement_line) values (grp, 'statement_line', slA);
  begin
    update deedbox.reconciliation set status='certified', certified_by=s_admin where id = recA;
    raise exception 'unbalanced match group certified';
  exception when others then
    if sqlerrm not like '%does not balance%' then raise; end if;
  end;
  insert into deedbox.recon_match_member (match_group, member_kind, transaction) values (grp, 'transaction', txnA);

  -- an outbound instrument on the matched transaction transitions at
  -- certification.
  insert into deedbox.instrument (account, direction, instrument_kind, number, amount, state, stale_after, source_type, source, transaction)
    values (acctA, 'outbound', 'cheque', '000301', 500.00, 'created', current_date + 180, 'money_receipt', 300, txnA)
    returning id into ins;

  update deedbox.reconciliation set status='certified', certified_by=s_admin where id = recA;
  if (select status from deedbox.reconciliation where id = recA) <> 'certified'
     or (select equation_snapshot from deedbox.reconciliation where id = recA) is null then
    raise exception 'clean certification failed to stand';
  end if;
  if (select state from deedbox.instrument where id = ins) <> 'presented' then
    raise exception 'covered instrument not presented at certification';
  end if;
  begin
    insert into deedbox.recon_match (reconciliation) values (recA);
    raise exception 'certified build accepted a new match';
  exception when others then
    if sqlerrm not like '%locked forever%' then raise; end if;
  end;
  begin
    update deedbox.reconciliation set statement_balance = 1.00 where id = recA;
    raise exception 'certified build rewritten';
  exception when others then
    if sqlerrm not like '%locked forever%' then raise; end if;
  end;

  -- re-matching a line already in a certified build refuses certification.
  insert into deedbox.reconciliation (account, statement_date, statement_balance)
    values (acctA, current_date + 1, 500.00) returning id into recC;
  insert into deedbox.recon_match (reconciliation) values (recC) returning id into grp;
  insert into deedbox.recon_match_member (match_group, member_kind, statement_line) values (grp, 'statement_line', slA);
  insert into deedbox.recon_match_member (match_group, member_kind, transaction) values (grp, 'transaction', txnA);
  begin
    update deedbox.reconciliation set status='certified', certified_by=s_admin where id = recC;
    raise exception 'double-matched line certified';
  exception when others then
    if sqlerrm not like '%already matched in a certified reconciliation%' then raise; end if;
  end;
  delete from deedbox.recon_match_member where match_group = grp;
  delete from deedbox.recon_match where id = grp;

  ------------------------------------------------------------------
  -- 3. The equation with a signed bank error; certified exceptions
  --    keep exactly their two transitions.
  ------------------------------------------------------------------
  insert into deedbox.bank_statement_line (account, line_date, amount, description, source)
    values (acctB, current_date, 300.00, 'DEP CLI2', 'manual') returning id into slB;
  insert into deedbox.bank_statement_line (account, line_date, amount, description, source)
    values (acctB, current_date, 25.00, 'BANK ERROR CREDIT', 'manual') returning id into slB2;
  insert into deedbox.reconciliation (account, statement_date, statement_balance)
    values (acctB, current_date, 325.00) returning id into recB;
  insert into deedbox.recon_match (reconciliation) values (recB) returning id into grp;
  insert into deedbox.recon_match_member (match_group, member_kind, statement_line) values (grp, 'statement_line', slB);
  insert into deedbox.recon_match_member (match_group, member_kind, transaction) values (grp, 'transaction', txnB);
  begin
    update deedbox.reconciliation set status='certified', certified_by=s_admin where id = recB;
    raise exception 'uncovered stray line certified';
  exception when others then
    if sqlerrm not like '%neither matched nor excepted%' then raise; end if;
  end;
  insert into deedbox.recon_exception (first_reconciliation, reconciliation, exception_type, linked_type, linked, amount, arising_date)
    values (recB, recB, 'bank_error', 'statement_line', slB2, -25.00, current_date) returning id into exc;
  update deedbox.reconciliation set status='certified', certified_by=s_admin where id = recB;
  if (select status from deedbox.reconciliation where id = recB) <> 'certified' then
    raise exception 'signed-error equation failed: %',
      (select equation_snapshot from deedbox.reconciliation where id = recB);
  end if;

  -- the certified exception admits only resolution or carry-forward.
  begin
    update deedbox.recon_exception set amount = -20.00 where id = exc;
    raise exception 'certified exception rewritten';
  exception when others then
    if sqlerrm not like '%only its resolution or carry-forward%' then raise; end if;
  end;
  insert into deedbox.reconciliation (account, statement_date, statement_balance)
    values (acctB, current_date + 1, 325.00) returning id into recC;
  insert into deedbox.recon_exception (first_reconciliation, reconciliation, exception_type, linked_type, linked, amount, arising_date)
    values (recB, recC, 'bank_error', 'statement_line', slB2, -25.00, current_date) returning id into exc2;
  update deedbox.recon_exception set state='carried_forward', carried_to=exc2 where id = exc;
  if (select arising_date from deedbox.recon_exception where id = exc2) <> current_date then
    raise exception 'carried exception lost its arising date';
  end if;

  ------------------------------------------------------------------
  -- 4. Period close: the listing writes itself and totals the bank
  --    position; the certified period locks the posting path.
  ------------------------------------------------------------------
  insert into deedbox.period_close (scope, account, period_start, period_end, status)
    values ('account', acctA, current_date - 60, current_date - 30, 'in_progress') returning id into pc;
  update deedbox.period_close set status='certified', certified_by=s_admin, report_artefact='artefact:close-r1' where id = pc;
  if (select count(*) from deedbox.balance_listing_line where close = pc) <> 1 then
    raise exception 'listing did not cover every ledger';
  end if;
  if (select late from deedbox.period_close where id = pc) is not false then
    raise exception 'an on-demand close can never be late';
  end if;
  begin
    perform deedbox.post_money_transaction('receipt', current_date - 45, s_admin, 'money_receipt', 302,
      jsonb_build_array(
        jsonb_build_object('side','cash_book','account',acctA,'signed_amount',10.00),
        jsonb_build_object('side','matter_ledger','account',acctA,'matter_ledger',ledA,'signed_amount',10.00)));
    raise exception 'posting landed inside the certified period';
  exception when others then
    if sqlerrm not like '%period_locked%' then raise; end if;
  end;
  perform deedbox.post_money_transaction('receipt', current_date, s_admin, 'money_receipt', 302,
    jsonb_build_array(
      jsonb_build_object('side','cash_book','account',acctA,'signed_amount',10.00),
      jsonb_build_object('side','matter_ledger','account',acctA,'matter_ledger',ledA,'signed_amount',10.00)));
  begin
    update deedbox.period_close set status='in_progress' where id = pc;
    raise exception 'certified close reopened';
  exception when others then
    if sqlerrm not like '%never reopened%' then raise; end if;
  end;

  ------------------------------------------------------------------
  -- 5. Dormancy: one live case per ledger; the ledger cannot close
  --    around it; remittance is registered against its transaction.
  ------------------------------------------------------------------
  insert into deedbox.dormant_case (matter_ledger, balance_at_detection)
    values (ledB, 300.00) returning id into dc;
  begin
    insert into deedbox.dormant_case (matter_ledger, balance_at_detection) values (ledB, 300.00);
    raise exception 'two live cases on one ledger';
  exception when others then
    if sqlerrm not like '%duplicate key%' then raise; end if;
  end;
  insert into deedbox.contact_attempt ("case", channel, evidence)
    values (dc, 'letter', 'artefact:letter1');
  update deedbox.dormant_case set state='contact_in_progress' where id = dc;

  insert into deedbox.payment_authorisation (subject_type, subject, authoriser, decision)
    values ('remittance', 901002, s_admin, 'approved') returning id into auth;
  txn := deedbox.post_money_transaction('remittance', current_date, s_admin, 'remittance_case', dc,
    jsonb_build_array(
      jsonb_build_object('side','cash_book','account',acctB,'signed_amount',-300.00),
      jsonb_build_object('side','matter_ledger','account',acctB,'matter_ledger',ledB,'signed_amount',-300.00)),
    'unclaimed money remitted to the authority', auth);
  insert into deedbox.remittance_register ("case", authority, amount, remitted_date, transaction, documentation)
    values (dc, 'Revenue Office', 300.00, current_date, txn, 'artefact:remit1');
  update deedbox.dormant_case set state='remitted' where id = dc;
  begin
    update deedbox.dormant_case set state='resolved', resolved_reason='no' where id = dc;
    raise exception 'finished case mutated';
  exception when others then
    if sqlerrm not like '%immutable%' then raise; end if;
  end;

  -- an open case on another ledger blocks that ledger's close.
  insert into deedbox.matter_ledger (account, matter) values (acctA, m2) returning id into ledC;
  insert into deedbox.dormant_case (matter_ledger, balance_at_detection) values (ledC, 0.00) returning id into dc;
  begin
    update deedbox.matter_ledger set status='closed', closing_copy='artefact:lc' where id = ledC;
    raise exception 'ledger closed around an open dormant case';
  exception when others then
    if sqlerrm not like '%open dormant case%' then raise; end if;
  end;
  update deedbox.dormant_case set state='resolved', resolved_reason='client located and paid out' where id = dc;
  update deedbox.matter_ledger set status='closed', closing_copy='artefact:lc' where id = ledC;

  ------------------------------------------------------------------
  -- 6. Incidents and the refusal promotion.
  ------------------------------------------------------------------
  insert into deedbox.deficiency_incident (account, incident_date, amount, cause, narrative, origin)
    values (acctA, current_date, 100.00, 'reconciliation difference', 'Found at build.', 'reconciliation')
    returning id into inc;
  begin
    update deedbox.deficiency_incident set state='rectified' where id = inc;
    raise exception 'rectified without a correcting transaction';
  exception when others then
    if sqlerrm not like '%correcting transaction%' then raise; end if;
  end;
  update deedbox.deficiency_incident
     set state='rectified', rectification = jsonb_build_object('transactions', jsonb_build_array(txnA)) where id = inc;
  update deedbox.deficiency_incident
     set state='reported', notification_artefact='artefact:notice1' where id = inc;
  insert into deedbox.refused_operation (account, attempted_operation, refusal_reason, attempted_by)
    values (acctA, '{"op":"x"}', 'integrity_refusal', s_admin) returning id into ref1;
  update deedbox.refused_operation set promoted_incident = inc where id = ref1;

  ------------------------------------------------------------------
  -- 7. Statements, statutory registers, exports.
  ------------------------------------------------------------------
  insert into deedbox.client_money_statement (matter_ledger, trigger_kind, statement_number, period_start, period_end, artefact)
    values (ledA, 'on_request', deedbox.allocate_number('statement', null, current_date),
            current_date - 30, current_date, 'artefact:cms1') returning id into stmt;
  begin
    update deedbox.client_money_statement set artefact='swapped' where id = stmt;
    raise exception 'T1 statement content swapped';
  exception when others then
    if sqlerrm not like '%exactly one mutation%' then raise; end if;
  end;
  update deedbox.client_money_statement set issued_at=now(), issue_channel='email' where id = stmt;
  begin
    update deedbox.client_money_statement set issue_channel='print' where id = stmt;
    raise exception 'T2 issued statement mutated';
  exception when others then
    if sqlerrm not like '%immutable%' then raise; end if;
  end;

  insert into deedbox.statutory_register (pack_version, register_key, name)
    select cp.active_version, 'controlled_money', 'Controlled money register' from deedbox.country_pack cp limit 1;
  select max(id) into reg from deedbox.statutory_register;
  insert into deedbox.statutory_register_entry (register) values (reg);
  insert into deedbox.statutory_register_entry (register) values (reg);
  if (select array_agg(e.entry_no order by e.entry_no) from deedbox.statutory_register_entry e where e.register = reg)
     <> array[1,2] then
    raise exception 'T3 register entries not densely numbered';
  end if;

  insert into deedbox.examination_pack_export (period, exported_by_kind, exported_by, artefact)
    values ('{"start":"2026-01-01","end":"2026-06-30"}', 'staff', s_admin, 'artefact:exam1');

  ------------------------------------------------------------------
  -- 8. Account deactivation: an open ledger refuses; a virgin account
  --    deactivates cleanly.
  ------------------------------------------------------------------
  begin
    update deedbox.client_account set active=false, deactivated_by=s_admin where id = acctA;
    raise exception 'account deactivated around an open ledger';
  exception when others then
    if sqlerrm not like '%every ledger closed%' and sqlerrm not like '%zero cash-book balance%' then raise; end if;
  end;
  insert into deedbox.client_account (name, account_kind) values ('Never Used', 'pooled') returning id into acctC;
  update deedbox.client_account set active=false, deactivated_by=s_admin where id = acctC;
  if (select deactivated_at from deedbox.client_account where id = acctC) is null then
    raise exception 'clean deactivation did not stamp';
  end if;
  begin
    update deedbox.client_account set name='Renamed After Death' where id = acctC;
    raise exception 'deactivated account mutated';
  exception when others then
    if sqlerrm not like '%immutable%' then raise; end if;
  end;

  raise notice 'ALL 0014 MONEY-STATUTORY TESTS PASSED';
end $$;

rollback;
