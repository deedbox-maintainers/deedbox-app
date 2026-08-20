-- Tests for 0021_interest_charge_proposal. Run as deployment role AFTER
-- 0001–0021. Proves the parking discipline as the app role: born pending,
-- one pending per bill, frozen computation, exactly-once resolution,
-- terminal immutability, never deleted.

begin;

grant deedbox_app to current_user;

insert into deedbox.country_pack (code, name) values ('XP1','Proposal Test Pack');
insert into deedbox.firm (name, operating_currency, timezone, country_pack)
  select 'Proposal Test Firm','AUD','Australia/Sydney', id from deedbox.country_pack where code='XP1';
insert into deedbox.office (name, code) values ('Proposals','PRP');

do $$
declare o bigint; r_admin bigint; s1 bigint; p1 bigint; pa bigint; m1 bigint;
        bg bigint; b1 bigint; b2 bigint; prop bigint; prop2 bigint; chg bigint;
begin
  select id into o from deedbox.office where code='PRP';
  select id into r_admin from deedbox.role where system_key='administrator';
  insert into deedbox.staff_member (person_name, login, role, office, email)
    values ('{"display":"Pru Approver"}','pru', r_admin, o, 'pru@x.test') returning id into s1;
  insert into deedbox.party (kind, display_name) values ('person','Prop Client') returning id into p1;
  insert into deedbox.party_name (party, name_kind, full_name) values (p1,'current','Prop Client');
  insert into deedbox.practice_area (name) values ('Proposals') returning id into pa;
  insert into deedbox.matter (matter_number, title, client_party, responsible_lawyer, office, practice_area)
    values ('PRP-000001', 'Proposal host', p1, s1, o, pa) returning id into m1;
  insert into deedbox.bill_group (matter, matter_total, payer_share_snapshot)
    values (m1, 500.00, '[]') returning id into bg;
  insert into deedbox.bill (bill_group, matter, payer_party) values (bg, m1, p1) returning id into b1;
  update deedbox.bill
     set state='issued', bill_number='PB-000001', issue_date=current_date - 60,
         terms_days_applied=14, due_date=current_date - 46,
         interest_statement='{"annual_rate_pct": 10, "grace_days": 0}',
         rendered_artefact='artefact:prop'
   where id = b1;
  insert into deedbox.bill_journal_entry (bill, entry_kind, signed_amount, source_type, source, effective_date, entered_by)
    values (b1, 'issue_total', 500.00, 'bill', b1, current_date - 60, s1);
  insert into deedbox.bill (bill_group, matter, payer_party) values (bg, m1, p1) returning id into b2;
  update deedbox.bill
     set state='issued', bill_number='PB-000002', issue_date=current_date - 60,
         terms_days_applied=14, due_date=current_date - 46,
         interest_statement='{"annual_rate_pct": 10, "grace_days": 0}',
         rendered_artefact='artefact:prop2'
   where id = b2;
  insert into deedbox.bill_journal_entry (bill, entry_kind, signed_amount, source_type, source, effective_date, entered_by)
    values (b2, 'issue_total', 500.00, 'bill', b2, current_date - 60, s1);

  set local role deedbox_app;
  perform set_config('deedbox.principal_kind','staff', true);
  perform set_config('deedbox.principal_id', s1::text, true);

  -- T1: born pending only.
  begin
    insert into deedbox.interest_charge_proposal
      (bill, period_from, period_to, rate_pct_applied, amount, state, resolved_at, reason)
      values (b1, current_date - 46, current_date - 1, 10, 6.16, 'dismissed', now(), 'no');
    raise exception 'T1-FAILED: proposal born resolved';
  exception when others then
    if sqlerrm like '%T1-FAILED%' then raise; end if;
  end;

  insert into deedbox.interest_charge_proposal
    (bill, period_from, period_to, rate_pct_applied, amount)
    values (b1, current_date - 46, current_date - 1, 10, 6.16) returning id into prop;

  -- T2: one pending proposal per bill.
  begin
    insert into deedbox.interest_charge_proposal
      (bill, period_from, period_to, rate_pct_applied, amount)
      values (b1, current_date - 46, current_date, 10, 6.30);
    raise exception 'T2-FAILED: second pending proposal accepted';
  exception when others then
    if sqlerrm like '%T2-FAILED%' then raise; end if;
  end;

  -- T3: the computation is frozen while pending.
  begin
    update deedbox.interest_charge_proposal set amount = 99.99 where id = prop;
    raise exception 'T3-FAILED: pending computation rewritten';
  exception when others then
    if sqlerrm like '%T3-FAILED%' then raise; end if;
  end;

  -- T4: approval demands the posted charge's id.
  begin
    update deedbox.interest_charge_proposal
       set state='approved', resolved_by=s1 where id = prop;
    raise exception 'T4-FAILED: approved without a posted charge';
  exception when others then
    if sqlerrm like '%T4-FAILED%' then raise; end if;
  end;

  -- T5: dismissal demands its reason.
  begin
    update deedbox.interest_charge_proposal
       set state='dismissed', resolved_by=s1 where id = prop;
    raise exception 'T5-FAILED: dismissed without a reason';
  exception when others then
    if sqlerrm like '%T5-FAILED%' then raise; end if;
  end;

  -- T6: a real approval resolves it — charge posted, then the proposal
  -- points at it; resolved_at stamps itself.
  insert into deedbox.interest_charge
    (bill, period_from, period_to, rate_pct_applied, amount, computed_by, approved_by, approved_at, supplementary_rendering)
    values (b1, current_date - 46, current_date - 1, 10, 6.16, 'system', s1, now(), 'artefact:ic1')
    returning id into chg;
  update deedbox.interest_charge_proposal
     set state='approved', resolved_by=s1, interest_charge=chg where id = prop;
  if (select resolved_at from deedbox.interest_charge_proposal where id = prop) is null then
    raise exception 'T6-FAILED: resolution did not stamp resolved_at';
  end if;

  -- T7: a resolved proposal is immutable.
  begin
    update deedbox.interest_charge_proposal set reason='afterthought' where id = prop;
    raise exception 'T7-FAILED: resolved proposal mutated';
  exception when others then
    if sqlerrm like '%T7-FAILED%' then raise; end if;
  end;

  -- T8: never deleted.
  begin
    delete from deedbox.interest_charge_proposal where id = prop;
    raise exception 'T8-FAILED: proposal deleted';
  exception when others then
    if sqlerrm like '%T8-FAILED%' then raise; end if;
  end;

  -- T9: a fresh pending proposal is legal once the prior one resolved;
  -- supersession is the refresh path and needs no charge or reason.
  insert into deedbox.interest_charge_proposal
    (bill, period_from, period_to, rate_pct_applied, amount)
    values (b1, current_date - 46, current_date, 10, 6.30) returning id into prop2;
  update deedbox.interest_charge_proposal
     set state='superseded', resolved_by=s1 where id = prop2;

  -- T10: dismissal with a reason lands on the second bill's proposal.
  insert into deedbox.interest_charge_proposal
    (bill, period_from, period_to, rate_pct_applied, amount)
    values (b2, current_date - 46, current_date - 1, 10, 6.16) returning id into prop2;
  update deedbox.interest_charge_proposal
     set state='dismissed', resolved_by=s1, reason='Client relationship — waive' where id = prop2;

  reset role;
end $$;

rollback;
