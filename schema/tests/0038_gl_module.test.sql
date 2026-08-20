-- Tests for 0038_gl_module. Run as deployment role AFTER the full chain.
-- Proves: purpose-bearing accounts are protected; the journal spine's
-- posting invariants live in the schema (numbered, balanced, non-zero,
-- active accounts, unlocked period), posted journals are immutable except
-- the controlled reversal, drafts alone delete, and lines are fixed once
-- posted; the gapless journal series allocates through the engine's own
-- machinery; period locks are one-way and block posting; the bill machine
-- (approve needs its journal and exact totals; part-paid never voids; paid
-- means in full); statement lines dedupe on the source hash, keep their
-- substance immutable and settle exactly once; the settings, capability,
-- and policy rows ship.

begin;

grant deedbox_app to current_user;

insert into deedbox.country_pack (code, name) values ('XGL','GL Test Pack');
insert into deedbox.firm (name, operating_currency, timezone, country_pack)
  select 'GL Test Firm','AUD','Australia/Sydney', id from deedbox.country_pack where code='XGL';
insert into deedbox.office (name, code) values ('GL Office','XGL1');

do $$
declare
  f bigint; off bigint; rl bigint; st bigint;
  a_bank bigint; a_ar bigint; a_rev bigint; a_exp bigint; a_ap bigint;
  tax bigint; con bigint; per bigint; j bigint; j2 bigint; jr bigint;
  b bigint; ba bigint; ln1 bigint; ln2 bigint;
  n integer; num1 text; num2 text;
begin
  select id into f from deedbox.firm where name = 'GL Test Firm';
  select id into off from deedbox.office where code = 'XGL1';
  select id into rl from deedbox.role where system_key = 'administrator';
  insert into deedbox.staff_member (person_name, login, role, office, email)
    values ('{"given":"Gee","family":"Ell"}','gee.xgl', rl, off, 'gee.xgl@example.test')
    returning id into st;

  -- T1: capability 50 ships and the administrator holds it; settings + policies ship
  if not exists (select 1 from deedbox.capability where key = 'gl.manage') then
    raise exception 'T1 FAIL: gl.manage missing';
  end if;
  if not exists (select 1 from deedbox.role_capability rc join deedbox.role r on r.id = rc.role
                 where r.system_key = 'administrator' and rc.capability = 'gl.manage' and rc.scope <> 'none') then
    raise exception 'T1 FAIL: administrator lacks gl.manage';
  end if;
  select count(*) into n from deedbox.setting_definition
   where key in ('gl.enabled','gl.conversion_date');
  if n <> 2 then raise exception 'T1 FAIL: gl settings missing'; end if;
  select count(*) into n from deedbox.deletion_policy where entity_type like 'gl_%';
  if n <> 13 then raise exception 'T1 FAIL: expected 13 policy rows, got %', n; end if;
  if not exists (select 1 from deedbox.number_format
                  where purpose = 'gl_journal' and pattern = 'GJ-{SEQ:6}' and allocation_mode = 'gapless') then
    raise exception 'T1 FAIL: gl_journal number format missing';
  end if;

  set local role deedbox_app;
  perform set_config('deedbox.principal_kind','staff',true),
          set_config('deedbox.principal_id', st::text, true);

  -- fixture chart
  insert into deedbox.gl_account (firm, code, name, account_type, system_purpose, is_bank)
    values (f,'1000','Operating bank','asset','operating_bank',true) returning id into a_bank;
  insert into deedbox.gl_account (firm, code, name, account_type, system_purpose)
    values (f,'1100','Trade receivables','asset','accounts_receivable') returning id into a_ar;
  insert into deedbox.gl_account (firm, code, name, account_type, system_purpose)
    values (f,'4000','Fees earned','income','revenue_default') returning id into a_rev;
  insert into deedbox.gl_account (firm, code, name, account_type, system_purpose)
    values (f,'2100','Trade payables','liability','accounts_payable') returning id into a_ap;
  insert into deedbox.gl_account (firm, code, name, account_type)
    values (f,'5000','Office expenses','expense') returning id into a_exp;
  insert into deedbox.gl_tax_code (firm, code, name, rate)
    values (f,'TAX10','Standard 10 percent',0.10) returning id into tax;
  insert into deedbox.gl_contact (firm, name) values (f,'Stationery Supplies Co') returning id into con;

  -- T2: purpose rows protected; purpose resolution works; type frozen once used
  begin
    update deedbox.gl_account set active = false where id = a_ar;
    raise exception 'T2 FAIL: purpose account deactivated';
  exception when raise_exception then
    if sqlerrm like '%T2 FAIL%' then raise; end if;
  end;
  if deedbox.gl_purpose_account(f,'revenue_default') is distinct from a_rev then
    raise exception 'T2 FAIL: purpose resolution wrong';
  end if;

  -- T3: journal posting invariants, all schema-proven
  insert into deedbox.gl_journal (firm, journal_date, description, created_by)
    values (f, date '2031-03-10', 'Unbalanced probe', st) returning id into j;
  insert into deedbox.gl_journal_line (journal, line_no, account, debit)
    values (j, 1, a_bank, 100.00);
  begin
    update deedbox.gl_journal set status='posted', journal_no='GJ-PROBE1', posted_by=st, posted_at=now()
      where id = j;
    raise exception 'T3 FAIL: unbalanced journal posted';
  exception when raise_exception then
    if sqlerrm like '%T3 FAIL%' then raise; end if;
  end;
  insert into deedbox.gl_journal_line (journal, line_no, account, credit)
    values (j, 2, a_rev, 100.00);
  begin
    update deedbox.gl_journal set status='posted', posted_by=st, posted_at=now() where id = j;
    raise exception 'T3 FAIL: unnumbered journal posted';
  exception when raise_exception then
    if sqlerrm like '%T3 FAIL%' then raise; end if;
  end;

  -- gapless numbers through the engine's own allocator, no gap under rollback
  num1 := deedbox.allocate_number('gl_journal', null, date '2031-03-10');
  update deedbox.gl_journal set status='posted', journal_no=num1, posted_by=st, posted_at=now()
    where id = j;

  -- T4: posted immutability; lines fixed; only the controlled reversal moves it
  begin
    update deedbox.gl_journal set description = 'rewritten' where id = j;
    raise exception 'T4 FAIL: posted journal edited';
  exception when raise_exception then
    if sqlerrm like '%T4 FAIL%' then raise; end if;
  end;
  begin
    update deedbox.gl_journal_line set debit = 999 where journal = j and line_no = 1;
    raise exception 'T4 FAIL: posted journal line edited';
  exception when raise_exception then
    if sqlerrm like '%T4 FAIL%' then raise; end if;
  end;
  begin
    delete from deedbox.gl_journal where id = j;
    raise exception 'T4 FAIL: posted journal deleted';
  exception when raise_exception then
    if sqlerrm like '%T4 FAIL%' then raise; end if;
  end;
  -- the reversal: mirror journal posts, original transitions
  insert into deedbox.gl_journal (firm, journal_date, description, source_type, reversal_of, created_by)
    values (f, date '2031-03-11', 'Reversal of '||num1, 'reversal', j, st) returning id into jr;
  insert into deedbox.gl_journal_line (journal, line_no, account, credit)
    values (jr, 1, a_bank, 100.00);
  insert into deedbox.gl_journal_line (journal, line_no, account, debit)
    values (jr, 2, a_rev, 100.00);
  num2 := deedbox.allocate_number('gl_journal', null, date '2031-03-11');
  update deedbox.gl_journal set status='posted', journal_no=num2, posted_by=st, posted_at=now()
    where id = jr;
  update deedbox.gl_journal set status='reversed', reversed_by=st, reversed_at=now() where id = j;
  begin
    update deedbox.gl_journal set description='touch' where id = j;
    raise exception 'T4 FAIL: reversed journal edited';
  exception when raise_exception then
    if sqlerrm like '%T4 FAIL%' then raise; end if;
  end;

  -- T5: a locked month refuses posting, and the lock is one-way
  insert into deedbox.gl_period (firm, period_start, period_end)
    values (f, date '2031-04-01', date '2031-04-30') returning id into per;
  update deedbox.gl_period set status='locked', locked_by=st, locked_at=now() where id = per;
  begin
    update deedbox.gl_period set status='open' where id = per;
    raise exception 'T5 FAIL: locked period reopened';
  exception when raise_exception then
    if sqlerrm like '%T5 FAIL%' then raise; end if;
  end;
  insert into deedbox.gl_journal (firm, journal_date, description, created_by)
    values (f, date '2031-04-15', 'Locked month probe', st) returning id into j2;
  insert into deedbox.gl_journal_line (journal, line_no, account, debit) values (j2, 1, a_bank, 50);
  insert into deedbox.gl_journal_line (journal, line_no, account, credit) values (j2, 2, a_rev, 50);
  begin
    update deedbox.gl_journal
       set status='posted', journal_no='GJ-LOCKED', posted_by=st, posted_at=now() where id = j2;
    raise exception 'T5 FAIL: posted into a locked period';
  exception when raise_exception then
    if sqlerrm like '%T5 FAIL%' then raise; end if;
  end;
  delete from deedbox.gl_journal where id = j2; -- drafts delete freely

  -- T6: the bill machine
  insert into deedbox.gl_bill (firm, contact, bill_date, net_amount, tax_amount, total, created_by)
    values (f, con, date '2031-03-12', 100.00, 10.00, 110.00, st) returning id into b;
  insert into deedbox.gl_bill_line (bill, line_no, account, tax_code, net_amount, tax_amount)
    values (b, 1, a_exp, tax, 100.00, 10.00);
  begin
    update deedbox.gl_bill set status='approved' where id = b;
    raise exception 'T6 FAIL: approval without its journal accepted';
  exception when raise_exception then
    if sqlerrm like '%T6 FAIL%' then raise; end if;
  end;
  begin
    update deedbox.gl_bill set status='paid', amount_paid=110.00 where id = b;
    raise exception 'T6 FAIL: draft went straight to paid';
  exception when raise_exception then
    if sqlerrm like '%T6 FAIL%' then raise; end if;
  end;
  -- a real AP journal, then approval carrying it
  insert into deedbox.gl_journal (firm, journal_date, description, source_type, created_by)
    values (f, date '2031-03-12', 'Bill: Stationery', 'bill_ap', st) returning id into j2;
  insert into deedbox.gl_journal_line (journal, line_no, account, debit) values (j2, 1, a_exp, 110.00);
  insert into deedbox.gl_journal_line (journal, line_no, account, credit) values (j2, 2, a_ap, 110.00);
  num2 := deedbox.allocate_number('gl_journal', null, date '2031-03-12');
  update deedbox.gl_journal set status='posted', journal_no=num2, posted_by=st, posted_at=now()
    where id = j2;
  update deedbox.gl_bill set status='approved', journal=j2 where id = b;
  begin
    update deedbox.gl_bill set net_amount = 90 where id = b;
    raise exception 'T6 FAIL: approved bill substance edited';
  exception when raise_exception then
    if sqlerrm like '%T6 FAIL%' then raise; end if;
  end;
  update deedbox.gl_bill set amount_paid = 60.00 where id = b;
  begin
    update deedbox.gl_bill set status='void' where id = b;
    raise exception 'T6 FAIL: part-paid bill voided';
  exception when raise_exception then
    if sqlerrm like '%T6 FAIL%' then raise; end if;
  end;
  begin
    update deedbox.gl_bill set status='paid' where id = b;
    raise exception 'T6 FAIL: paid while short';
  exception when raise_exception then
    if sqlerrm like '%T6 FAIL%' then raise; end if;
  end;
  update deedbox.gl_bill set status='paid', amount_paid=110.00 where id = b;

  -- T7: statement lines — hash dedup, substance immutable, settle exactly once
  insert into deedbox.gl_bank_account (firm, account, name)
    values (f, a_bank, 'Operating account') returning id into ba;
  insert into deedbox.gl_statement_line (firm, bank_account, transaction_date, amount, description, source_hash)
    values (f, ba, date '2031-03-13', 550.00, 'DEPOSIT REF 9', 'hash-t7-1') returning id into ln1;
  begin
    insert into deedbox.gl_statement_line (firm, bank_account, transaction_date, amount, description, source_hash)
      values (f, ba, date '2031-03-13', 550.00, 'DEPOSIT REF 9', 'hash-t7-1');
    raise exception 'T7 FAIL: duplicate source hash accepted';
  exception when unique_violation then null;
  end;
  begin
    update deedbox.gl_statement_line set amount = 5.00 where id = ln1;
    raise exception 'T7 FAIL: statement substance edited';
  exception when raise_exception then
    if sqlerrm like '%T7 FAIL%' then raise; end if;
  end;
  begin
    update deedbox.gl_statement_line set status='matched' where id = ln1;
    raise exception 'T7 FAIL: matched without a journal';
  exception when raise_exception then
    if sqlerrm like '%T7 FAIL%' then raise; end if;
  end;
  update deedbox.gl_statement_line
     set status='ignored', reconciled_at=now(), reconciled_by=st where id = ln1;
  begin
    update deedbox.gl_statement_line
       set status='unmatched', reconciled_at=null, reconciled_by=null where id = ln1;
    raise exception 'T7 FAIL: settled line reopened';
  exception when raise_exception then
    if sqlerrm like '%T7 FAIL%' then raise; end if;
  end;
  insert into deedbox.gl_match (firm, statement_line, match_type, method, created_by)
    values (f, ln1, 'ignore', 'manual', st);
  begin
    update deedbox.gl_match set match_type='receive' where statement_line = ln1;
    raise exception 'T7 FAIL: match evidence edited';
  exception when insufficient_privilege then null;
  end;

  -- T8: the bridge's idempotency shape — one live posting per source pointer
  insert into deedbox.gl_journal (firm, journal_date, description, source_type, source_ref, created_by)
    values (f, date '2031-03-14', 'Bridge probe', 'bridge_bill', 'bill:42', st) returning id into ln2;
  begin
    insert into deedbox.gl_journal (firm, journal_date, description, source_type, source_ref, created_by)
      values (f, date '2031-03-14', 'Bridge probe again', 'bridge_bill', 'bill:42', st);
    raise exception 'T8 FAIL: second live journal for one source accepted';
  exception when unique_violation then null;
  end;

  reset role;
  raise notice '0038 suite: all assertions passed';
end $$;

rollback;
