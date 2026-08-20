-- Tests for 0025_examiner_read_scoping. Run as deployment role AFTER the
-- full chain. Proves, as the app role under examiner context: in-period
-- money records visible; out-of-period absent; the reference frame (accounts,
-- ledgers) open while the grant is live; matter and party structurally
-- closed; the header pinhole serving exactly the trio (and nothing to staff);
-- every write refused except the register's two sanctioned kinds; the
-- master-data journal confined to its kind and period; revoked and absent
-- contexts fully closed; and the four runtime kinds' behaviour unchanged.
-- (money_payment's policy rides the same transaction-date helper the
-- ledger_transfer test proves; the payment-execution guard forbids conjuring
-- an executed payment by direct insert, so the payment table is not fixtured
-- here.)

begin;

grant deedbox_app to current_user;

insert into deedbox.country_pack (code, name) values ('X25','Examiner Scoping Pack');
insert into deedbox.firm (name, operating_currency, timezone, country_pack)
  select 'Examiner Scoping Firm','AUD','Australia/Sydney', id from deedbox.country_pack where code='X25';
insert into deedbox.office (name, code) values ('Examiner Scoping','X25');

do $$
declare
  f bigint; o bigint; r_admin bigint; s1 bigint; p1 bigint; pa bigint;
  m1 bigint; m2 bigint; acct bigint; acct2 bigint; led bigint; led2 bigint;
  g_ok bigint; g_rev bigint; auth1 bigint;
  txn_in bigint; txn_out bigint; txn_remit bigint; txn_xfer bigint;
  recon_in bigint; recon_out bigint; match_in bigint;
  line_in bigint; line_ctx bigint; line_out bigint;
  close_in bigint; close_out bigint; case1 bigint;
  n int; hdr record;
begin
  select id into f from deedbox.firm where name = 'Examiner Scoping Firm';
  select id into o from deedbox.office where code = 'X25';
  select id into r_admin from deedbox.role where system_key = 'administrator';
  insert into deedbox.staff_member (person_name, login, role, office, email)
    values ('{"display":"Erin Examplestaff"}','erin.x25', r_admin, o, 'erin.x25@x.test')
    returning id into s1;
  insert into deedbox.party (kind, display_name) values ('person','Exam Scoping Client')
    returning id into p1;
  insert into deedbox.party_name (party, name_kind, full_name) values (p1,'current','Exam Scoping Client');
  insert into deedbox.practice_area (name) values ('Examiner Scoping') returning id into pa;
  insert into deedbox.matter (matter_number, title, client_party, responsible_lawyer, office, practice_area)
    values ('X25-000001','Exam scoping host', p1, s1, o, pa) returning id into m1;
  insert into deedbox.matter (matter_number, title, client_party, responsible_lawyer, office, practice_area)
    values ('X25-000002','Exam scoping second', p1, s1, o, pa) returning id into m2;
  insert into deedbox.client_account (name, account_kind) values ('Exam Scoping Trust','pooled')
    returning id into acct;
  -- a second account hosts the out-of-period reconciliation: the schema
  -- allows one in-progress reconciliation per account, and certifying the
  -- decoy would drag the whole equation machinery into this suite
  insert into deedbox.client_account (name, account_kind) values ('Exam Scoping Trust B','pooled')
    returning id into acct2;
  insert into deedbox.matter_ledger (account, matter) values (acct, m1) returning id into led;
  insert into deedbox.matter_ledger (account, matter) values (acct, m2) returning id into led2;

  -- movements: 2020-06-15 sits INSIDE the examined period (2020-01-01 to
  -- 2020-12-31); 2021-02-01 sits after it.
  txn_in := deedbox.post_money_transaction('receipt','2020-06-15', s1,'test_fixture', 1,
    jsonb_build_array(
      jsonb_build_object('side','cash_book','account',acct,'signed_amount',100.00),
      jsonb_build_object('side','matter_ledger','account',acct,'matter_ledger',led,'signed_amount',100.00)));
  txn_out := deedbox.post_money_transaction('receipt','2021-02-01', s1,'test_fixture', 2,
    jsonb_build_array(
      jsonb_build_object('side','cash_book','account',acct,'signed_amount',55.00),
      jsonb_build_object('side','matter_ledger','account',acct,'matter_ledger',led,'signed_amount',55.00)));
  insert into deedbox.money_receipt
      (matter_ledger, receipt_number, payer_description, method, received_date, amount, transaction, printable_artefact)
    values (led,'X25R-0001','Payer in period','eft','2020-06-15',100.00, txn_in,'artefact:x25r1');
  insert into deedbox.money_receipt
      (matter_ledger, receipt_number, payer_description, method, received_date, amount, transaction, printable_artefact)
    values (led,'X25R-0002','Payer out of period','eft','2021-02-01',55.00, txn_out,'artefact:x25r2');

  -- a same-account transfer inside the period, under an authorisation
  insert into deedbox.payment_authorisation (subject_type, subject, authoriser, decision)
    values ('ledger_transfer', 900101, s1, 'approved') returning id into auth1;
  txn_xfer := deedbox.post_money_transaction('ledger_transfer','2020-07-01', s1,'test_fixture', 3,
    jsonb_build_array(
      jsonb_build_object('side','matter_ledger','account',acct,'matter_ledger',led,'signed_amount',-5.00),
      jsonb_build_object('side','matter_ledger','account',acct,'matter_ledger',led2,'signed_amount',5.00)),
    'between related matters', auth1);
  insert into deedbox.ledger_transfer
      (from_ledger, to_ledger, amount, reason, authorisation, transfer_number, transaction)
    values (led, led2, 5.00,'between related matters', auth1,'X25T-0001', txn_xfer);

  -- instruments: born by the period end visible; born after it, not
  insert into deedbox.instrument
      (account, direction, instrument_kind, number, amount, state, stale_after, source_type, source, transaction)
    values (acct,'inbound','cheque','X25-CHQ-1',100.00,'received','2020-12-31','test_fixture',1, txn_in);
  insert into deedbox.instrument
      (account, direction, instrument_kind, number, amount, state, stale_after, source_type, source, transaction)
    values (acct,'inbound','cheque','X25-CHQ-2',55.00,'received','2021-08-01','test_fixture',2, txn_out);

  -- bank truth: statement lines at 2019-12-31 and 2020-06-20 render as
  -- period context (on or before the period end); 2021-02-10 never
  insert into deedbox.bank_statement_line (account, line_date, amount, description, source)
    values (acct,'2019-12-31',20.00,'carried context line','manual') returning id into line_ctx;
  insert into deedbox.bank_statement_line (account, line_date, amount, description, source)
    values (acct,'2020-06-20',100.00,'in-period line','manual') returning id into line_in;
  insert into deedbox.bank_statement_line (account, line_date, amount, description, source)
    values (acct,'2021-02-10',55.00,'after-period line','manual') returning id into line_out;

  -- reconciliations: one inside the period with a match, a member and an
  -- exception; one after it
  insert into deedbox.reconciliation (account, statement_date, statement_balance)
    values (acct,'2020-06-30',100.00) returning id into recon_in;
  insert into deedbox.reconciliation (account, statement_date, statement_balance)
    values (acct2,'2021-02-28',150.00) returning id into recon_out;
  insert into deedbox.recon_match (reconciliation) values (recon_in) returning id into match_in;
  insert into deedbox.recon_match_member (match_group, member_kind, statement_line)
    values (match_in,'statement_line', line_in);
  insert into deedbox.recon_exception
      (first_reconciliation, reconciliation, exception_type, linked_type, linked, amount, arising_date)
    values (recon_in, recon_in,'unbanked_receipt','money_transaction', txn_in, 100.00,'2020-06-15');

  -- closes: one whose period overlaps the examined period (with its listing
  -- line), one after it; statements likewise
  insert into deedbox.period_close (scope, account, period_start, period_end, status)
    values ('account', acct,'2020-06-01','2020-06-30','in_progress') returning id into close_in;
  insert into deedbox.period_close (scope, account, period_start, period_end, status)
    values ('account', acct,'2021-01-01','2021-01-31','due') returning id into close_out;
  insert into deedbox.balance_listing_line (close, matter_ledger, balance)
    values (close_in, led, 100.00);
  insert into deedbox.client_money_statement
      (matter_ledger, trigger_kind, statement_number, period_start, period_end, artefact)
    values (led,'on_request','X25-CMS-1','2020-01-01','2020-06-30','artefact:x25s1');
  insert into deedbox.client_money_statement
      (matter_ledger, trigger_kind, statement_number, period_start, period_end, artefact)
    values (led,'on_request','X25-CMS-2','2021-01-01','2021-06-30','artefact:x25s2');

  -- evidence of failure: refusals at explicit times; incidents by date
  insert into deedbox.refused_operation
      (account, matter_ledger, attempted_operation, refusal_reason, attempted_by, at)
    values (acct, led,'{"op":"payment"}','would_go_below_zero', s1,'2020-06-10T00:00:00+00');
  insert into deedbox.refused_operation
      (account, matter_ledger, attempted_operation, refusal_reason, attempted_by, at)
    values (acct, led,'{"op":"payment"}','would_go_below_zero', s1,'2021-02-05T00:00:00+00');
  insert into deedbox.deficiency_incident
      (account, matter_ledger, incident_date, amount, cause, narrative, origin)
    values (acct, led,'2020-03-01',10.00,'test cause','older unrectified deficiency','manual');
  insert into deedbox.deficiency_incident
      (account, matter_ledger, incident_date, amount, cause, narrative, origin)
    values (acct, led,'2021-03-01',10.00,'test cause','later deficiency','manual');

  -- dormancy remittance inside the period
  insert into deedbox.dormant_case (matter_ledger, balance_at_detection)
    values (led, 100.00) returning id into case1;
  txn_remit := deedbox.post_money_transaction('remittance','2020-09-01', s1,'test_fixture', 4,
    jsonb_build_array(
      jsonb_build_object('side','cash_book','account',acct,'signed_amount',-10.00),
      jsonb_build_object('side','matter_ledger','account',acct,'matter_ledger',led,'signed_amount',-10.00)),
    'remitted under authority', auth1);
  insert into deedbox.remittance_register ("case", authority, amount, remitted_date, transaction, documentation)
    values (case1,'Test Authority Act',10.00,'2020-09-01', txn_remit,'artefact:x25rm1');

  -- the master-data journal: one in-period entry, one after, plus a
  -- different kind in-period that must never surface
  insert into deedbox.register_entry
      (firm, occurred_at, actor_kind, actor, event_kind, subject_type, subject, matter, detail)
    values (f,'2020-06-15T00:00:00+00','staff', s1,'master_data.changed','matter_ledger', led, m1,
            '{"change":"client display name"}');
  insert into deedbox.register_entry
      (firm, occurred_at, actor_kind, actor, event_kind, subject_type, subject, matter, detail)
    values (f,'2021-02-15T00:00:00+00','staff', s1,'master_data.changed','matter_ledger', led, m1,
            '{"change":"later change"}');
  insert into deedbox.register_entry
      (firm, occurred_at, actor_kind, actor, event_kind, subject_type, subject, matter, detail)
    values (f,'2020-06-16T00:00:00+00','staff', s1,'record.changed','matter', m1, m1,
            '{"note":"not for examiners"}');

  -- the grants: one live and in-window; one revoked
  insert into deedbox.examiner_grant
      (examiner_name, login, secret_hash, period_start, period_end, starts_at, expires_at, granted_by)
    values ('Iris Inspector','iris.x25','h','2020-01-01','2020-12-31',
            now() - interval '1 hour', now() + interval '1 hour', s1)
    returning id into g_ok;
  insert into deedbox.examiner_grant
      (examiner_name, login, secret_hash, period_start, period_end, starts_at, expires_at, granted_by, revoked_at, revoked_by)
    values ('Rex Revoked','rex.x25','h','2020-01-01','2020-12-31',
            now() - interval '1 hour', now() + interval '1 hour', s1, now(), s1)
    returning id into g_rev;

  ------------------------------------------------------------------------
  -- Step down: the app role under the LIVE grant's examiner context.
  ------------------------------------------------------------------------
  set local role deedbox_app;
  perform set_config('deedbox.principal_kind','examiner', true);
  perform set_config('deedbox.principal_id', g_ok::text, true);

  -- T1: the spine — the in-period transaction alone.
  select count(*) into n from deedbox.money_transaction where id in (txn_in, txn_out);
  if n <> 1 then raise exception 'T1-FAILED: expected 1 visible transaction of the pair, saw %', n; end if;
  select count(*) into n from deedbox.money_transaction where id = txn_in;
  if n <> 1 then raise exception 'T1-FAILED: the in-period transaction is not the visible one'; end if;

  -- T2: lines follow their transaction's effective date.
  select count(*) into n from deedbox.ledger_line where transaction = txn_in;
  if n <> 2 then raise exception 'T2-FAILED: in-period lines hidden (%)', n; end if;
  select count(*) into n from deedbox.ledger_line where transaction = txn_out;
  if n <> 0 then raise exception 'T2-FAILED: out-of-period lines leaked (%)', n; end if;

  -- T3: receipts by received date; the transfer by its transaction's date.
  select count(*) into n from deedbox.money_receipt where receipt_number in ('X25R-0001','X25R-0002');
  if n <> 1 then raise exception 'T3-FAILED: expected 1 visible receipt, saw %', n; end if;
  select count(*) into n from deedbox.ledger_transfer where transfer_number = 'X25T-0001';
  if n <> 1 then raise exception 'T3-FAILED: in-period transfer hidden'; end if;

  -- T4: the reference frame is open while the grant is live.
  select count(*) into n from deedbox.client_account where id = acct;
  if n <> 1 then raise exception 'T4-FAILED: account hidden from a live examiner'; end if;
  select count(*) into n from deedbox.matter_ledger where id in (led, led2);
  if n <> 2 then raise exception 'T4-FAILED: ledgers hidden from a live examiner (%)', n; end if;

  -- T5: matter and party stay structurally closed.
  select count(*) into n from deedbox.matter where id in (m1, m2);
  if n <> 0 then raise exception 'T5-FAILED: matter rows served to an examiner (%)', n; end if;
  select count(*) into n from deedbox.party where id = p1;
  if n <> 0 then raise exception 'T5-FAILED: party rows served to an examiner'; end if;

  -- T6: the pinhole serves exactly the trio.
  select * into hdr from deedbox.examiner_ledger_header(led);
  if hdr.ledger_number is null
     or hdr.client_display_name is distinct from 'Exam Scoping Client'
     or hdr.matter_reference is distinct from 'X25-000001'
     or hdr.restricted then
    raise exception 'T6-FAILED: header trio wrong: % / % / %',
      hdr.ledger_number, hdr.client_display_name, hdr.matter_reference;
  end if;

  -- T7: writes are refused — an insert violates row security; an update
  -- can target no rows at all.
  begin
    insert into deedbox.money_transaction (txn_kind, effective_date, entered_by, source_type, source)
      values ('receipt','2020-06-20', s1,'test_fixture', 9);
    raise exception 'T7-FAILED: examiner context inserted a money transaction';
  exception when others then
    if sqlerrm like '%T7-FAILED%' then raise; end if;
  end;
  update deedbox.matter_ledger set status = status where id = led;
  get diagnostics n = row_count;
  if n <> 0 then raise exception 'T7-FAILED: examiner context updated % ledger row(s)', n; end if;

  -- T8: the register admits exactly the two sanctioned kinds from examiner
  -- context, and serves back only the in-period master-data journal.
  insert into deedbox.register_entry (firm, actor_kind, actor, event_kind, subject_type, subject, detail)
    values (f,'examiner', g_ok,'examiner.read','examiner_grant', g_ok,'{"surface":"examiner_ledger"}');
  begin
    insert into deedbox.register_entry (firm, actor_kind, actor, event_kind, subject_type, subject, detail)
      values (f,'examiner', g_ok,'record.changed','matter_ledger', led,'{"x":1}');
    raise exception 'T8-FAILED: examiner context wrote a non-sanctioned register kind';
  exception when others then
    if sqlerrm like '%T8-FAILED%' then raise; end if;
  end;
  select count(*) into n from deedbox.register_entry
    where subject_type = 'matter_ledger' and subject = led and event_kind = 'master_data.changed';
  if n <> 1 then raise exception 'T8-FAILED: master-data journal wrong (% rows; want the one in-period entry)', n; end if;
  select count(*) into n from deedbox.register_entry where event_kind = 'record.changed';
  if n <> 0 then raise exception 'T8-FAILED: a non-journal register kind leaked to the examiner (%)', n; end if;
  select count(*) into n from deedbox.register_entry
    where event_kind = 'examiner.read' and actor = g_ok;
  if n <> 1 then raise exception 'T8-FAILED: the examiner cannot see their own read receipt (%)', n; end if;

  -- T9: the reconciliation family scopes by statement date.
  select count(*) into n from deedbox.reconciliation where id in (recon_in, recon_out);
  if n <> 1 then raise exception 'T9-FAILED: expected 1 visible reconciliation, saw %', n; end if;
  select count(*) into n from deedbox.recon_match where reconciliation = recon_in;
  if n <> 1 then raise exception 'T9-FAILED: in-period match hidden'; end if;
  select count(*) into n from deedbox.recon_match_member where match_group = match_in;
  if n <> 1 then raise exception 'T9-FAILED: in-period match member hidden'; end if;
  select count(*) into n from deedbox.recon_exception where reconciliation = recon_in;
  if n <> 1 then raise exception 'T9-FAILED: in-period exception hidden'; end if;

  -- T10: instruments exist by the period end; statement lines render as
  -- context up to the period end and never after.
  select count(*) into n from deedbox.instrument where number in ('X25-CHQ-1','X25-CHQ-2');
  if n <> 1 then raise exception 'T10-FAILED: expected 1 visible instrument, saw %', n; end if;
  select count(*) into n from deedbox.bank_statement_line where id in (line_ctx, line_in, line_out);
  if n <> 2 then raise exception 'T10-FAILED: expected the 2 lines on or before the period end, saw %', n; end if;
  select count(*) into n from deedbox.bank_statement_line where id = line_out;
  if n <> 0 then raise exception 'T10-FAILED: an after-period statement line leaked'; end if;

  -- T11: closes and statements by period overlap; the listing rides its close.
  select count(*) into n from deedbox.period_close where id in (close_in, close_out);
  if n <> 1 then raise exception 'T11-FAILED: expected 1 visible close, saw %', n; end if;
  select count(*) into n from deedbox.balance_listing_line where close = close_in;
  if n <> 1 then raise exception 'T11-FAILED: the in-period close''s listing is hidden'; end if;
  select count(*) into n from deedbox.client_money_statement
    where statement_number in ('X25-CMS-1','X25-CMS-2');
  if n <> 1 then raise exception 'T11-FAILED: expected 1 visible client statement, saw %', n; end if;

  -- T12: refusals and remittances within the period; incidents by date up
  -- to the period end.
  select count(*) into n from deedbox.refused_operation where account = acct;
  if n <> 1 then raise exception 'T12-FAILED: expected 1 visible refusal, saw %', n; end if;
  select count(*) into n from deedbox.deficiency_incident where account = acct;
  if n <> 1 then raise exception 'T12-FAILED: expected 1 visible incident, saw %', n; end if;
  select count(*) into n from deedbox.remittance_register where "case" = case1;
  if n <> 1 then raise exception 'T12-FAILED: the in-period remittance is hidden'; end if;

  -- T13: a revoked grant's context sees nothing and the pinhole is dark.
  perform set_config('deedbox.principal_id', g_rev::text, true);
  select count(*) into n from deedbox.money_transaction where id in (txn_in, txn_out);
  if n <> 0 then raise exception 'T13-FAILED: a revoked grant read money (%)', n; end if;
  select count(*) into n from deedbox.client_account where id = acct;
  if n <> 0 then raise exception 'T13-FAILED: a revoked grant saw the account'; end if;
  select count(*) into n from deedbox.examiner_ledger_header(led);
  if n <> 0 then raise exception 'T13-FAILED: the pinhole served a revoked grant'; end if;

  -- T14: absent context fails closed everywhere.
  perform set_config('deedbox.principal_kind','', true);
  select count(*) into n from deedbox.money_transaction where id in (txn_in, txn_out);
  if n <> 0 then raise exception 'T14-FAILED: absent context read money'; end if;
  select count(*) into n from deedbox.party where id = p1;
  if n <> 0 then raise exception 'T14-FAILED: absent context read a party'; end if;

  -- T15: the four runtime kinds keep today's behaviour; the pinhole never
  -- serves staff.
  perform set_config('deedbox.principal_kind','staff', true);
  perform set_config('deedbox.principal_id', s1::text, true);
  select count(*) into n from deedbox.money_transaction where id in (txn_in, txn_out);
  if n <> 2 then raise exception 'T15-FAILED: staff no longer see the books (%)', n; end if;
  select count(*) into n from deedbox.party where id = p1;
  if n <> 1 then raise exception 'T15-FAILED: staff no longer see the party'; end if;
  select count(*) into n from deedbox.examiner_ledger_header(led);
  if n <> 0 then raise exception 'T15-FAILED: the pinhole served a staff principal'; end if;

  reset role;
end $$;

rollback;
