-- Tests for 0012_money_spine. Run as deployment role AFTER 0001–0012.

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
        acct bigint; sa_acct bigint; led1 bigint; led2 bigint; contra bigint; hold_led bigint;
        auth bigint; auth2 bigint; auth_rej bigint; txn bigint; rxn bigint; ref1 bigint; tfr bigint;
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
    values (deedbox.allocate_number('matter', null, current_date), 'Money host', p1, s_law, o, pa) returning id into m1;
  insert into deedbox.matter (matter_number, title, client_party, responsible_lawyer, office, practice_area)
    values (deedbox.allocate_number('matter', null, current_date), 'Second money host', p1, s_law, o, pa) returning id into m2;

  ------------------------------------------------------------------
  -- 1. Accounts and ledgers: kind discipline; auto-numbered ledgers;
  --    one client ledger per (account, matter).
  ------------------------------------------------------------------
  insert into deedbox.client_account (name, account_kind) values ('General Trust', 'pooled') returning id into acct;
  insert into deedbox.client_account (name, account_kind) values ('Statutory Deposit', 'statutory_set_aside') returning id into sa_acct;
  begin
    insert into deedbox.matter_ledger (account, matter, ledger_kind) values (acct, null, 'set_aside_holding');
    raise exception 'holding ledger accepted on a pooled account';
  exception when others then
    if sqlerrm not like '%statutory set-aside account%' then raise; end if;
  end;
  begin
    insert into deedbox.matter_ledger (account, ledger_kind) values (sa_acct, 'set_aside_contra');
    raise exception 'contra ledger accepted on a set-aside account';
  exception when others then
    if sqlerrm not like '%pooled account%' then raise; end if;
  end;
  insert into deedbox.matter_ledger (account, matter) values (acct, m1) returning id into led1;
  insert into deedbox.matter_ledger (account, matter) values (acct, m2) returning id into led2;
  insert into deedbox.matter_ledger (account, ledger_kind) values (acct, 'set_aside_contra') returning id into contra;
  insert into deedbox.matter_ledger (account, ledger_kind) values (sa_acct, 'set_aside_holding') returning id into hold_led;
  begin
    insert into deedbox.matter_ledger (account, matter) values (acct, m1);
    raise exception 'A3 second ledger for one matter in one account';
  exception when others then
    if sqlerrm not like '%duplicate key%' then raise; end if;
  end;
  if (select ledger_number from deedbox.matter_ledger where id = led1) is null then
    raise exception 'A4 ledger number not assigned';
  end if;

  ------------------------------------------------------------------
  -- 2. The posting protocol: a balanced receipt lands; the ledger
  --    can never go below zero; shapes bind at check time.
  ------------------------------------------------------------------
  txn := deedbox.post_money_transaction('receipt', current_date, s_admin, 'money_receipt', 1,
    jsonb_build_array(
      jsonb_build_object('side','cash_book','account',acct,'signed_amount',500.00),
      jsonb_build_object('side','matter_ledger','account',acct,'matter_ledger',led1,'signed_amount',500.00)));
  if deedbox.ledger_balance(led1) <> 500.00 then
    raise exception 'receipt did not land: balance %', deedbox.ledger_balance(led1);
  end if;

  insert into deedbox.payment_authorisation (subject_type, subject, authoriser, decision)
    values ('money_payment', 1, s_admin, 'approved') returning id into auth;
  begin
    perform deedbox.post_money_transaction('payment_out', current_date, s_admin, 'money_payment', 1,
      jsonb_build_array(
        jsonb_build_object('side','cash_book','account',acct,'signed_amount',-600.00),
        jsonb_build_object('side','matter_ledger','account',acct,'matter_ledger',led1,'signed_amount',-600.00)),
      'paying out more than held', auth);
    raise exception 'overdraw accepted';
  exception when others then
    if sqlerrm not like '%below zero%' then raise; end if;
  end;
  perform deedbox.post_money_transaction('payment_out', current_date, s_admin, 'money_payment', 1,
    jsonb_build_array(
      jsonb_build_object('side','cash_book','account',acct,'signed_amount',-200.00),
      jsonb_build_object('side','matter_ledger','account',acct,'matter_ledger',led1,'signed_amount',-200.00)),
    'partial payment', auth);
  if deedbox.ledger_balance(led1) <> 300.00 then
    raise exception 'balance wrong after payment: %', deedbox.ledger_balance(led1);
  end if;

  -- an unbalanced transaction cannot stand at check.
  begin
    perform deedbox.post_money_transaction('receipt', current_date, s_admin, 'money_receipt', 2,
      jsonb_build_array(
        jsonb_build_object('side','cash_book','account',acct,'signed_amount',100.00),
        jsonb_build_object('side','matter_ledger','account',acct,'matter_ledger',led1,'signed_amount',90.00)));
    set constraints deedbox.z_assert_txn_shape immediate;
    raise exception 'unbalanced transaction stood at check';
  exception when others then
    if sqlerrm not like '%does not balance%' then raise; end if;
  end;
  set constraints deedbox.z_assert_txn_shape deferred;

  -- a receipt with a negative cash line is not a receipt.
  begin
    perform deedbox.post_money_transaction('receipt', current_date, s_admin, 'money_receipt', 3,
      jsonb_build_array(
        jsonb_build_object('side','cash_book','account',acct,'signed_amount',-100.00),
        jsonb_build_object('side','matter_ledger','account',acct,'matter_ledger',led1,'signed_amount',-100.00)));
    set constraints deedbox.z_assert_txn_shape immediate;
    raise exception 'negative receipt stood at check';
  exception when others then
    if sqlerrm not like '%one positive cash line%' then raise; end if;
  end;
  set constraints deedbox.z_assert_txn_shape deferred;

  ------------------------------------------------------------------
  -- 3. Authorisation discipline: authorised kinds demand an approved
  --    row; rejected rows never carry a posting.
  ------------------------------------------------------------------
  begin
    perform deedbox.post_money_transaction('payment_out', current_date, s_admin, 'money_payment', 4,
      jsonb_build_array(
        jsonb_build_object('side','cash_book','account',acct,'signed_amount',-50.00),
        jsonb_build_object('side','matter_ledger','account',acct,'matter_ledger',led1,'signed_amount',-50.00)),
      'no authorisation');
    raise exception 'payment posted without authorisation';
  exception when others then
    if sqlerrm not like '%requires its authorisation%' then raise; end if;
  end;
  insert into deedbox.payment_authorisation (subject_type, subject, authoriser, decision)
    values ('money_payment', 9, s_admin, 'rejected') returning id into auth_rej;
  begin
    perform deedbox.post_money_transaction('payment_out', current_date, s_admin, 'money_payment', 9,
      jsonb_build_array(
        jsonb_build_object('side','cash_book','account',acct,'signed_amount',-50.00),
        jsonb_build_object('side','matter_ledger','account',acct,'matter_ledger',led1,'signed_amount',-50.00)),
      'rejected authorisation', auth_rej);
    raise exception 'payment posted on a rejected authorisation';
  exception when others then
    if sqlerrm not like '%approved authorisation%' then raise; end if;
  end;

  ------------------------------------------------------------------
  -- 4. Ledger transfers: two ledger lines, one account, netting zero.
  ------------------------------------------------------------------
  insert into deedbox.payment_authorisation (subject_type, subject, authoriser, decision)
    values ('ledger_transfer', 1, s_admin, 'approved') returning id into auth2;
  tfr := deedbox.post_money_transaction('ledger_transfer', current_date, s_admin, 'ledger_transfer', 1,
    jsonb_build_array(
      jsonb_build_object('side','matter_ledger','account',acct,'matter_ledger',led1,'signed_amount',-100.00),
      jsonb_build_object('side','matter_ledger','account',acct,'matter_ledger',led2,'signed_amount',100.00)),
    'costs shared between related matters', auth2);
  if deedbox.ledger_balance(led1) <> 200.00 or deedbox.ledger_balance(led2) <> 100.00 then
    raise exception 'transfer balances wrong: % / %', deedbox.ledger_balance(led1), deedbox.ledger_balance(led2);
  end if;

  ------------------------------------------------------------------
  -- 5. The set-aside pair and the contra guard: the pooled cash book
  --    never goes negative; the contra ledger never goes positive.
  ------------------------------------------------------------------
  insert into deedbox.payment_authorisation (subject_type, subject, authoriser, decision)
    values ('set_aside_move', 1, s_admin, 'approved') returning id into auth2;
  perform deedbox.post_money_transaction('set_aside_move', current_date, s_admin, 'set_aside_calculation', 1,
    jsonb_build_array(
      jsonb_build_object('side','cash_book','account',acct,'signed_amount',-150.00),
      jsonb_build_object('side','matter_ledger','account',acct,'matter_ledger',contra,'signed_amount',-150.00)),
    'statutory set-aside', auth2);
  perform deedbox.post_money_transaction('set_aside_move', current_date, s_admin, 'set_aside_calculation', 1,
    jsonb_build_array(
      jsonb_build_object('side','cash_book','account',sa_acct,'signed_amount',150.00),
      jsonb_build_object('side','matter_ledger','account',sa_acct,'matter_ledger',hold_led,'signed_amount',150.00)),
    'statutory set-aside', auth2);
  if deedbox.ledger_balance(contra) <> -150.00 or deedbox.ledger_balance(hold_led) <> 150.00 then
    raise exception 'set-aside pair wrong: % / %', deedbox.ledger_balance(contra), deedbox.ledger_balance(hold_led);
  end if;
  begin
    perform deedbox.post_money_transaction('set_aside_move', current_date, s_admin, 'set_aside_calculation', 2,
      jsonb_build_array(
        jsonb_build_object('side','cash_book','account',acct,'signed_amount',-500.00),
        jsonb_build_object('side','matter_ledger','account',acct,'matter_ledger',contra,'signed_amount',-500.00)),
      'over-reserving', auth2);
    set constraints deedbox.z_assert_txn_shape immediate;
    raise exception 'pooled cash book went negative';
  exception when others then
    if sqlerrm not like '%cash book would go negative%' then raise; end if;
  end;
  set constraints deedbox.z_assert_txn_shape deferred;
  begin
    perform deedbox.post_money_transaction('set_aside_move', current_date, s_admin, 'set_aside_calculation', 3,
      jsonb_build_array(
        jsonb_build_object('side','cash_book','account',acct,'signed_amount',200.00),
        jsonb_build_object('side','matter_ledger','account',acct,'matter_ledger',contra,'signed_amount',200.00)),
      'withdrawing more than reserved', auth2);
    raise exception 'contra ledger went above zero';
  exception when others then
    if sqlerrm not like '%never goes above zero%' then raise; end if;
  end;

  ------------------------------------------------------------------
  -- 6. Reversals: exact mirrors only (probed on the transfer, whose
  --    mirror stays above zero); then the drawn-down dishonour, which
  --    the below-zero rule must refuse — ending this block.
  ------------------------------------------------------------------
  insert into deedbox.payment_authorisation (subject_type, subject, authoriser, decision)
    values ('reversal', 1, s_admin, 'approved') returning id into auth2;
  begin
    perform deedbox.post_money_transaction('reversal', current_date, s_admin, 'ledger_transfer', 1,
      jsonb_build_array(
        jsonb_build_object('side','matter_ledger','account',acct,'matter_ledger',led1,'signed_amount',99.00),
        jsonb_build_object('side','matter_ledger','account',acct,'matter_ledger',led2,'signed_amount',-99.00)),
      'wrong mirror', auth2, tfr);
    set constraints deedbox.z_assert_txn_shape immediate;
    raise exception 'inexact reversal stood at check';
  exception when others then
    if sqlerrm not like '%mirrors the reversed transaction%' then raise; end if;
  end;
  set constraints deedbox.z_assert_txn_shape deferred;

  -- a staff reversal of an authorised kind demands its authorisation row.
  begin
    perform deedbox.post_money_transaction('reversal', current_date, s_admin, 'ledger_transfer', 1,
      jsonb_build_array(
        jsonb_build_object('side','matter_ledger','account',acct,'matter_ledger',led1,'signed_amount',100.00),
        jsonb_build_object('side','matter_ledger','account',acct,'matter_ledger',led2,'signed_amount',-100.00)),
      'unauthorised staff reversal', null, tfr);
    raise exception 'unauthorised reversal posted';
  exception when others then
    if sqlerrm not like '%requires its authorisation%' then raise; end if;
  end;

  -- the drawn-down dishonour: 500 received, 200 paid, 100 transferred away;
  -- reversing the 500 receipt would strand the ledger — refused, ending
  -- this block (its writes roll back; the next block re-fixtures).
  perform set_config('deedbox.principal_kind','system_job', true);
  rxn := deedbox.post_money_transaction('reversal', current_date, s_admin, 'instrument_event', 1,
    jsonb_build_array(
      jsonb_build_object('side','cash_book','account',acct,'signed_amount',-500.00),
      jsonb_build_object('side','matter_ledger','account',acct,'matter_ledger',led1,'signed_amount',-500.00)),
    'bank dishonour', null, txn);
  raise exception 'drawn-down dishonour stood';
exception when others then
  if sqlerrm not like '%below zero%' then raise; end if;
end $$;

-- Continue after the deliberate below-zero refusal above (the do-block's
-- writes rolled back with it; re-fixture the minimum needed).
do $$
declare o bigint; r_admin bigint; s_admin bigint; p1 bigint; pa bigint; m1 bigint;
        acct bigint; led1 bigint; txn bigint; rxn bigint; ref1 bigint; r_lawyer bigint; s_law bigint;
begin
  select id into o from deedbox.office limit 1;
  select id into r_admin from deedbox.role where system_key='administrator';
  select id into r_lawyer from deedbox.role where system_key='lawyer';
  insert into deedbox.staff_member (person_name, login, role, office, email)
    values ('{"display":"Bea Admin"}','bea', r_admin, o, 'bea@x.test') returning id into s_admin;
  insert into deedbox.staff_member (person_name, login, role, office, email)
    values ('{"display":"Kim Lawyer"}','kim', r_lawyer, o, 'kim@x.test') returning id into s_law;
  insert into deedbox.party (kind, display_name) values ('person','Cli2') returning id into p1;
  insert into deedbox.party_name (party, name_kind, full_name) values (p1,'current','Cli2');
  insert into deedbox.practice_area (name) values ('Property Work') returning id into pa;
  insert into deedbox.matter (matter_number, title, client_party, responsible_lawyer, office, practice_area)
    values (deedbox.allocate_number('matter', null, current_date), 'Money host 2', p1, s_law, o, pa) returning id into m1;
  insert into deedbox.client_account (name, account_kind) values ('General Trust 2', 'pooled') returning id into acct;
  insert into deedbox.matter_ledger (account, matter) values (acct, m1) returning id into led1;

  txn := deedbox.post_money_transaction('receipt', current_date, s_admin, 'money_receipt', 10,
    jsonb_build_array(
      jsonb_build_object('side','cash_book','account',acct,'signed_amount',500.00),
      jsonb_build_object('side','matter_ledger','account',acct,'matter_ledger',led1,'signed_amount',500.00)));

  -- full-balance dishonour: the mirror lands, balance returns to zero.
  perform set_config('deedbox.principal_kind','system_job', true);
  rxn := deedbox.post_money_transaction('reversal', current_date, s_admin, 'instrument_event', 1,
    jsonb_build_array(
      jsonb_build_object('side','cash_book','account',acct,'signed_amount',-500.00),
      jsonb_build_object('side','matter_ledger','account',acct,'matter_ledger',led1,'signed_amount',-500.00)),
    'bank dishonour', null, txn);
  perform set_config('deedbox.principal_kind','', true);
  if deedbox.ledger_balance(led1) <> 0 then
    raise exception 'dishonour mirror did not land: %', deedbox.ledger_balance(led1);
  end if;
  begin
    perform deedbox.post_money_transaction('reversal', current_date, s_admin, 'money_receipt', 11,
      jsonb_build_array(
        jsonb_build_object('side','cash_book','account',acct,'signed_amount',500.00),
        jsonb_build_object('side','matter_ledger','account',acct,'matter_ledger',led1,'signed_amount',500.00)),
      'reversing a reversal', null, rxn);
    raise exception 'a reversal was reversed';
  exception when others then
    if sqlerrm not like '%never itself reversed%' then raise; end if;
  end;
  begin
    update deedbox.money_transaction set reason='rewritten' where id = txn;
    raise exception 'transaction mutated';
  exception when others then
    if sqlerrm not like '%immutable%' then raise; end if;
  end;
  begin
    delete from deedbox.ledger_line where transaction = txn;
    raise exception 'ledger lines deleted';
  exception when others then
    if sqlerrm not like '%immutable%' then raise; end if;
  end;

  ------------------------------------------------------------------
  -- 7. Ledger close discipline: zero balance + closing copy; closed
  --    ledgers take no postings; the privileged reopen counts.
  ------------------------------------------------------------------
  begin
    update deedbox.matter_ledger set status='closed', closing_copy='artefact:close' where id = led1;
    -- balance is zero after the dishonour, so this close SUCCEEDS.
    if (select status from deedbox.matter_ledger where id = led1) <> 'closed' then
      raise exception 'H1 zero-balance close refused';
    end if;
  end;
  begin
    perform deedbox.post_money_transaction('receipt', current_date, s_admin, 'money_receipt', 12,
      jsonb_build_array(
        jsonb_build_object('side','cash_book','account',acct,'signed_amount',50.00),
        jsonb_build_object('side','matter_ledger','account',acct,'matter_ledger',led1,'signed_amount',50.00)));
    raise exception 'H2 posting landed on a closed ledger';
  exception when others then
    if sqlerrm not like '%open ledgers only%' then raise; end if;
  end;
  update deedbox.matter_ledger set status='open' where id = led1;
  if (select reopened_count from deedbox.matter_ledger where id = led1) <> 1 then
    raise exception 'H3 reopen not counted';
  end if;
  perform deedbox.post_money_transaction('receipt', current_date, s_admin, 'money_receipt', 12,
    jsonb_build_array(
      jsonb_build_object('side','cash_book','account',acct,'signed_amount',50.00),
      jsonb_build_object('side','matter_ledger','account',acct,'matter_ledger',led1,'signed_amount',50.00)));
  if deedbox.ledger_balance(led1) <> 50.00 then
    raise exception 'post-reopen receipt wrong: %', deedbox.ledger_balance(led1);
  end if;
  begin
    update deedbox.matter_ledger set status='closed', closing_copy='artefact:close2' where id = led1;
    raise exception 'nonzero-balance ledger closed';
  exception when others then
    if sqlerrm not like '%zero balance%' then raise; end if;
  end;

  ------------------------------------------------------------------
  -- 8. The refusal register: permanent, one promotion transition.
  ------------------------------------------------------------------
  insert into deedbox.refused_operation (account, matter_ledger, attempted_operation, refusal_reason, attempted_by)
    values (acct, led1, '{"op":"payment_out","amount":600}', 'would_go_below_zero', s_admin)
    returning id into ref1;
  begin
    update deedbox.refused_operation set refusal_reason='period_locked' where id = ref1;
    raise exception 'refusal rewritten';
  exception when others then
    if sqlerrm not like '%exactly one mutation%' then raise; end if;
  end;
  -- promotion targets a real incident (the FK binds once 0014 applies).
  insert into deedbox.deficiency_incident (account, matter_ledger, incident_date, amount, cause, narrative, origin)
    values (acct, led1, current_date, 600.00, 'attempted overdraw', 'Promoted from the refusal register.', 'promoted_refusal');
  update deedbox.refused_operation
     set promoted_incident = (select max(i.id) from deedbox.deficiency_incident i) where id = ref1;
  begin
    update deedbox.refused_operation set promoted_incident = 2 where id = ref1;
    raise exception 'promotion re-aimed';
  exception when others then
    if sqlerrm not like '%exactly one mutation%' then raise; end if;
  end;
  begin
    delete from deedbox.refused_operation where id = ref1;
    raise exception 'refusal deleted';
  exception when others then
    if sqlerrm not like '%permanent%' then raise; end if;
  end;

  -- flush-verify every posting this block made against the shape assertion.
  set constraints deedbox.z_assert_txn_shape immediate;

  raise notice 'ALL 0012 MONEY-SPINE TESTS PASSED';
end $$;

rollback;
