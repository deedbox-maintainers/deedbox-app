-- Tests for 0060_trust_aware_arrears. Run as deployment role AFTER the full
-- chain. The netting rule to the cent, and the parked state's lawful
-- transitions. Where the scheduler applies the rule is pinned in the
-- application suite (trust-aware reminder scheduling).

begin;

insert into deedbox.country_pack (code, name) values ('T60','Sixty');
insert into deedbox.firm (name, operating_currency, timezone, country_pack)
  select 'T60 Firm','AUD','Australia/Sydney', id from deedbox.country_pack where code = 'T60';
insert into deedbox.office (name, code) values ('T60','T60');

do $$
declare
  o bigint; r_admin bigint; r_lawyer bigint; s_admin bigint; s_law bigint;
  p1 bigint; pa bigint; m1 bigint; bg bigint; b1 bigint;
  acct bigint; led bigint; seq bigint; tmpl bigint; brs bigint;
  d numeric; refused boolean;
begin
  select id into o from deedbox.office where code = 'T60';
  select id into r_admin from deedbox.role where system_key = 'administrator';
  select id into r_lawyer from deedbox.role where system_key = 'lawyer';
  insert into deedbox.staff_member (person_name, login, role, office, email)
    values ('{"display":"Ada Sixty"}','ada60', r_admin, o, 'ada60@x.test') returning id into s_admin;
  insert into deedbox.staff_member (person_name, login, role, office, email)
    values ('{"display":"Lee Sixty"}','lee60', r_lawyer, o, 'lee60@x.test') returning id into s_law;
  insert into deedbox.party (kind, display_name) values ('person','Cli Sixty') returning id into p1;
  insert into deedbox.party_name (party, name_kind, full_name) values (p1,'current','Cli Sixty');
  insert into deedbox.practice_area (name) values ('T60 Litigation') returning id into pa;
  insert into deedbox.matter (matter_number, title, client_party, responsible_lawyer, office, practice_area)
    values (deedbox.allocate_number('matter', null, current_date), 'T60 host', p1, s_law, o, pa) returning id into m1;

  -- T1: a matter with no bills and no money has no uncovered arrears
  d := deedbox.matter_uncovered_arrears(m1);
  if d <> 0 then
    raise exception 'T1 FAILED: empty matter reads %, wanted 0', d;
  end if;

  -- one issued bill of 1000
  insert into deedbox.bill_group (matter, matter_total, payer_share_snapshot)
    values (m1, 1000.00, '[]') returning id into bg;
  insert into deedbox.bill (bill_group, matter, payer_party) values (bg, m1, p1) returning id into b1;
  update deedbox.bill
     set state='issued', bill_number=deedbox.allocate_number('bill', null, current_date),
         issue_date=current_date, terms_days_applied=14, due_date=current_date+14,
         rendered_artefact='artefact:t60'
   where id = b1;
  insert into deedbox.bill_journal_entry (bill, entry_kind, signed_amount, source_type, source, effective_date, entered_by)
    values (b1, 'issue_total', 1000.00, 'bill', b1, current_date, s_admin);

  -- T2: with no client money held, the whole outstanding is uncovered
  d := deedbox.matter_uncovered_arrears(m1);
  if d <> 1000.00 then
    raise exception 'T2 FAILED: uncovered bill reads %, wanted 1000.00', d;
  end if;

  -- client money arrives: 400 held
  insert into deedbox.client_account (name, account_kind) values ('T60 Trust', 'pooled') returning id into acct;
  insert into deedbox.matter_ledger (account, matter) values (acct, m1) returning id into led;
  perform deedbox.post_money_transaction('receipt', current_date, s_admin, 'test_fixture', 601,
    jsonb_build_array(
      jsonb_build_object('side','cash_book','account',acct,'signed_amount',400.00),
      jsonb_build_object('side','matter_ledger','account',acct,'matter_ledger',led,'signed_amount',400.00)));

  -- T3: free money nets off — 1000 owed less 400 held free
  d := deedbox.matter_uncovered_arrears(m1);
  if d <> 600.00 then
    raise exception 'T3 FAILED: 1000 owed less 400 held read %, wanted 600.00', d;
  end if;

  -- 300 of the held money is set aside for a purpose
  insert into deedbox.earmark (matter_ledger, amount, purpose, placed_by)
    values (led, 300.00, 'counsel fees', s_admin);

  -- T4: set-aside money never counts as cover — only 100 stays free
  d := deedbox.matter_uncovered_arrears(m1);
  if d <> 900.00 then
    raise exception 'T4 FAILED: with 300 set aside read %, wanted 900.00', d;
  end if;

  -- full cover: another 900 arrives (1300 held, 1000 free of the set-aside)
  perform deedbox.post_money_transaction('receipt', current_date, s_admin, 'test_fixture', 602,
    jsonb_build_array(
      jsonb_build_object('side','cash_book','account',acct,'signed_amount',900.00),
      jsonb_build_object('side','matter_ledger','account',acct,'matter_ledger',led,'signed_amount',900.00)));

  -- T5: cover caps at zero, never negative
  d := deedbox.matter_uncovered_arrears(m1);
  if d <> 0 then
    raise exception 'T5 FAILED: fully covered matter reads %, wanted 0', d;
  end if;

  -- the parked state's transitions
  insert into deedbox.message_template (name, channel, purpose, subject, body, tokens_used, active)
    values ('T60 reminder', 'email', 'bill_reminder', 'r', 'r', '[]', true) returning id into tmpl;
  insert into deedbox.reminder_sequence (name) values ('T60 seq') returning id into seq;
  insert into deedbox.reminder_step (sequence, step_no, days_after_previous, channel, template)
    values (seq, 1, 0, 'email', tmpl);
  insert into deedbox.bill_reminder_state (bill, sequence, next_step_at)
    values (b1, seq, now()) returning id into brs;

  -- T6: running → held_trust_cover → running are lawful
  update deedbox.bill_reminder_state set status = 'held_trust_cover' where id = brs;
  update deedbox.bill_reminder_state set status = 'running' where id = brs;

  -- T7: parked → stopped_paid is lawful
  update deedbox.bill_reminder_state set status = 'held_trust_cover' where id = brs;
  update deedbox.bill_reminder_state set status = 'stopped_paid' where id = brs;

  -- T8: parked → exhausted is NOT lawful
  update deedbox.bill_reminder_state set status = 'running' where id = brs;
  update deedbox.bill_reminder_state set status = 'held_trust_cover' where id = brs;
  refused := false;
  begin
    update deedbox.bill_reminder_state set status = 'exhausted' where id = brs;
  exception when others then
    refused := true;
    if position('illegal reminder transition' in sqlerrm) = 0 then
      raise exception 'T8 FAILED: wrong refusal: %', sqlerrm;
    end if;
  end;
  if not refused then
    raise exception 'T8 FAILED: held_trust_cover -> exhausted was accepted';
  end if;
end $$;

rollback;
