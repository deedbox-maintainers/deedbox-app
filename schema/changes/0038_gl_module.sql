-- 0038_gl_module — the GL module's home: the firm's own office
-- accounting. Chart of accounts (system purposes resolve postings — never
-- code literals), double-entry journals whose posting invariants live HERE
-- (balanced, non-zero, numbered, period-unlocked — proven by trigger no
-- matter what the app does), controlled reversal, month period locks,
-- office contacts and supplier bills, bank accounts with hash-deduped
-- statement imports, bank rules, and the reconciliation match evidence.
--
-- Posture: OPTIONAL AND DARK BY DEFAULT — the tables always install, but
-- everything refuses until the firm sets gl.enabled and
-- gl.conversion_date. One-way dependency: gl_* may read the practice
-- tables; NOTHING in the engine references gl_*. The gl_journal numbering
-- purpose was added by 0037 in its own change — an enum value cannot be
-- used in the transaction that adds it, and the applier runs each file as
-- one transaction.

begin;

------------------------------------------------------------------------------
-- Chart of accounts. System purposes make postings renumber-proof: the
-- bridge and the reconcile verbs resolve accounts through gl_purpose_account,
-- so a firm may recode its chart freely; purpose rows may never deactivate.
------------------------------------------------------------------------------
create table deedbox.gl_account (
    id bigint generated always as identity primary key,
    firm bigint not null references deedbox.firm(id),
    code text not null,
    name text not null,
    account_type text not null check (account_type in
      ('asset','liability','equity','income','expense')),
    system_purpose text check (system_purpose in
      ('operating_bank','accounts_receivable','accounts_payable','tax_collected',
       'tax_paid','revenue_default','bad_debts','opening_balance_equity',
       'retained_earnings','bank_clearing','rounding')),
    description text,
    is_bank boolean not null default false,
    active boolean not null default true,
    created_at timestamptz not null default now(),
    unique (firm, code)
);
create unique index gl_account_purpose_unique
  on deedbox.gl_account (firm, system_purpose) where system_purpose is not null;
grant select, insert, update on deedbox.gl_account to deedbox_app;

create or replace function deedbox.gl_account_guard() returns trigger
language plpgsql as $$
begin
  if old.system_purpose is not null then
    if new.system_purpose is distinct from old.system_purpose then
      raise exception 'a purpose-bearing account keeps its purpose';
    end if;
    if new.active = false then
      raise exception 'a purpose-bearing account can never be deactivated';
    end if;
  end if;
  if new.firm is distinct from old.firm then
    raise exception 'an account never changes firm';
  end if;
  if new.account_type is distinct from old.account_type
     and exists (select 1 from deedbox.gl_journal_line l where l.account = old.id) then
    raise exception 'an account with journal lines keeps its type';
  end if;
  return new;
end $$;
create trigger gl_account_guard before update on deedbox.gl_account
for each row execute function deedbox.gl_account_guard();

create function deedbox.gl_purpose_account(p_firm bigint, p_purpose text)
returns bigint language sql stable as $$
  select id from deedbox.gl_account
   where firm = p_firm and system_purpose = p_purpose and active;
$$;

create table deedbox.gl_tax_code (
    id bigint generated always as identity primary key,
    firm bigint not null references deedbox.firm(id),
    code text not null,
    name text not null,
    rate numeric(6,4) not null default 0 check (rate >= 0 and rate < 1),
    active boolean not null default true,
    created_at timestamptz not null default now(),
    unique (firm, code)
);
grant select, insert, update on deedbox.gl_tax_code to deedbox_app;

create table deedbox.gl_contact (
    id bigint generated always as identity primary key,
    firm bigint not null references deedbox.firm(id),
    name text not null,
    email text,
    phone text,
    tax_identifier text,
    notes text,
    active boolean not null default true,
    created_at timestamptz not null default now()
);
create index gl_contact_firm on deedbox.gl_contact (firm, name);
grant select, insert, update on deedbox.gl_contact to deedbox_app;

------------------------------------------------------------------------------
-- Periods: month locks. Locking is one-way — a locked month never reopens
-- (the money domain's period discipline).
------------------------------------------------------------------------------
create table deedbox.gl_period (
    id bigint generated always as identity primary key,
    firm bigint not null references deedbox.firm(id),
    period_start date not null,
    period_end date not null check (period_end >= period_start),
    status text not null default 'open' check (status in ('open','locked')),
    locked_by bigint references deedbox.staff_member(id),
    locked_at timestamptz,
    created_at timestamptz not null default now(),
    unique (firm, period_start)
);
grant select, insert, update on deedbox.gl_period to deedbox_app;

create or replace function deedbox.gl_period_guard() returns trigger
language plpgsql as $$
begin
  if old.status = 'locked' then
    raise exception 'a locked period never changes';
  end if;
  if new.firm is distinct from old.firm
     or new.period_start is distinct from old.period_start
     or new.period_end is distinct from old.period_end then
    raise exception 'a period''s dates are immutable';
  end if;
  if new.status = 'locked' and (new.locked_by is null or new.locked_at is null) then
    raise exception 'locking records who and when';
  end if;
  return new;
end $$;
create trigger gl_period_guard before update on deedbox.gl_period
for each row execute function deedbox.gl_period_guard();

create function deedbox.gl_period_is_locked(p_firm bigint, p_date date)
returns boolean language sql stable as $$
  select exists (
    select 1 from deedbox.gl_period
     where firm = p_firm and status = 'locked'
       and p_date between period_start and period_end);
$$;

------------------------------------------------------------------------------
-- The journal spine. Drafts are freely editable; POSTING is proven here:
-- the draft→posted transition demands a gapless number, balanced non-zero
-- lines on active accounts, and an unlocked period. Posted journals are
-- immutable except the controlled transition to reversed; reversed rows
-- are frozen; only drafts delete.
------------------------------------------------------------------------------
create table deedbox.gl_journal (
    id bigint generated always as identity primary key,
    firm bigint not null references deedbox.firm(id),
    journal_no text,
    journal_date date not null,
    description text not null,
    source_type text not null default 'manual' check (source_type in
      ('manual','bridge_bill','bridge_payment','bridge_credit','bridge_writeoff',
       'bank_receive','bank_spend','bank_transfer','bill_ap','bill_payment',
       'opening_balance','reversal')),
    source_ref text,
    status text not null default 'draft' check (status in ('draft','posted','reversed')),
    created_by bigint references deedbox.staff_member(id),
    posted_by bigint references deedbox.staff_member(id),
    posted_at timestamptz,
    reversed_by bigint references deedbox.staff_member(id),
    reversed_at timestamptz,
    reversal_of bigint references deedbox.gl_journal(id),
    created_at timestamptz not null default now()
);
create unique index gl_journal_no_unique on deedbox.gl_journal (firm, journal_no)
  where journal_no is not null;
-- one live (unreversed) posting per bridged source: the bridge's idempotency
create unique index gl_journal_source_unique
  on deedbox.gl_journal (firm, source_type, source_ref)
  where source_ref is not null and status <> 'reversed';
create index gl_journal_date on deedbox.gl_journal (firm, journal_date);
grant select, insert, update, delete on deedbox.gl_journal to deedbox_app;

create table deedbox.gl_journal_line (
    id bigint generated always as identity primary key,
    journal bigint not null references deedbox.gl_journal(id) on delete cascade,
    line_no integer not null default 1,
    account bigint not null references deedbox.gl_account(id),
    tax_code bigint references deedbox.gl_tax_code(id),
    debit numeric(18,2) not null default 0 check (debit >= 0),
    credit numeric(18,2) not null default 0 check (credit >= 0),
    description text,
    matter bigint references deedbox.matter(id),
    contact bigint references deedbox.gl_contact(id),
    check (not (debit > 0 and credit > 0)),
    check (debit > 0 or credit > 0)
);
create index gl_journal_line_journal on deedbox.gl_journal_line (journal);
create index gl_journal_line_account on deedbox.gl_journal_line (account);
grant select, insert, update, delete on deedbox.gl_journal_line to deedbox_app;

create or replace function deedbox.gl_journal_guard() returns trigger
language plpgsql as $$
declare v_debit numeric(18,2); v_credit numeric(18,2); v_lines integer; v_bad integer;
begin
  if tg_op = 'DELETE' then
    if old.status <> 'draft' then
      raise exception 'only draft journals delete — posted entries are permanent';
    end if;
    return old;
  end if;

  if old.status = 'reversed' then
    raise exception 'reversed journals are immutable';
  end if;

  if old.status = 'posted' then
    if new.status = 'reversed'
       and new.reversed_at is not null
       and new.reversal_of is not distinct from old.reversal_of
       and new.journal_no = old.journal_no
       and new.journal_date = old.journal_date
       and new.description = old.description
       and new.source_type = old.source_type
       and new.source_ref is not distinct from old.source_ref
       and new.firm = old.firm
       and new.posted_by is not distinct from old.posted_by
       and new.posted_at is not distinct from old.posted_at then
      return new;
    end if;
    raise exception 'posted journals are immutable except the controlled reversal';
  end if;

  -- old.status = 'draft'
  if new.firm is distinct from old.firm then
    raise exception 'a journal never changes firm';
  end if;
  if new.status = 'reversed' then
    raise exception 'a draft is deleted, never reversed';
  end if;
  if new.status = 'posted' then
    -- posted_by stays null for system postings (the bridge); the register
    -- carries the acting principal either way
    if new.journal_no is null or new.posted_at is null then
      raise exception 'posting assigns the number and records when';
    end if;
    if deedbox.gl_period_is_locked(new.firm, new.journal_date) then
      raise exception 'the period containing % is locked', new.journal_date;
    end if;
    select coalesce(sum(debit),0), coalesce(sum(credit),0), count(*)
      into v_debit, v_credit, v_lines
      from deedbox.gl_journal_line where journal = new.id;
    if v_lines = 0 then
      raise exception 'a journal posts with lines or not at all';
    end if;
    if v_debit <> v_credit then
      raise exception 'unbalanced: debits % <> credits %', v_debit, v_credit;
    end if;
    if v_debit = 0 then
      raise exception 'a zero-value journal never posts';
    end if;
    select count(*) into v_bad
      from deedbox.gl_journal_line l
      join deedbox.gl_account a on a.id = l.account
     where l.journal = new.id and (not a.active or a.firm <> new.firm);
    if v_bad > 0 then
      raise exception 'every line posts to an active account of this firm';
    end if;
  elsif new.journal_no is distinct from old.journal_no and old.journal_no is not null then
    raise exception 'a journal number, once assigned, never changes';
  end if;
  return new;
end $$;
create trigger gl_journal_guard before update or delete on deedbox.gl_journal
for each row execute function deedbox.gl_journal_guard();

create or replace function deedbox.gl_journal_line_guard() returns trigger
language plpgsql as $$
declare v_status text;
begin
  if tg_op = 'DELETE' then
    select status into v_status from deedbox.gl_journal where id = old.journal;
    if v_status is null then return old; end if; -- parent draft cascade-deleting
    if v_status <> 'draft' then
      raise exception 'lines of a % journal are fixed', v_status;
    end if;
    return old;
  end if;
  select status into v_status from deedbox.gl_journal
   where id = coalesce(new.journal, old.journal);
  if v_status is distinct from 'draft' then
    raise exception 'lines of a % journal are fixed', coalesce(v_status, 'missing');
  end if;
  return new;
end $$;
create trigger gl_journal_line_guard
before insert or update or delete on deedbox.gl_journal_line
for each row execute function deedbox.gl_journal_line_guard();

------------------------------------------------------------------------------
-- Supplier bills (accounts payable). Draft edits only; approval posts the
-- AP journal (done by the operation — the pointer lands here); paid arrives
-- through reconciliation as payments accumulate; void only untouched.
------------------------------------------------------------------------------
create table deedbox.gl_bill (
    id bigint generated always as identity primary key,
    firm bigint not null references deedbox.firm(id),
    contact bigint not null references deedbox.gl_contact(id),
    bill_number text,
    bill_date date not null,
    due_date date,
    description text,
    matter bigint references deedbox.matter(id),
    net_amount numeric(18,2) not null default 0 check (net_amount >= 0),
    tax_amount numeric(18,2) not null default 0 check (tax_amount >= 0),
    total numeric(18,2) not null default 0 check (total >= 0),
    amount_paid numeric(18,2) not null default 0 check (amount_paid >= 0),
    status text not null default 'draft' check (status in ('draft','approved','paid','void')),
    journal bigint references deedbox.gl_journal(id),
    created_by bigint references deedbox.staff_member(id),
    created_at timestamptz not null default now(),
    check (amount_paid <= total)
);
create index gl_bill_firm on deedbox.gl_bill (firm, status, bill_date desc);
grant select, insert, update on deedbox.gl_bill to deedbox_app;

create table deedbox.gl_bill_line (
    id bigint generated always as identity primary key,
    bill bigint not null references deedbox.gl_bill(id) on delete cascade,
    line_no integer not null default 1,
    account bigint not null references deedbox.gl_account(id),
    tax_code bigint references deedbox.gl_tax_code(id),
    description text,
    net_amount numeric(18,2) not null check (net_amount >= 0),
    tax_amount numeric(18,2) not null default 0 check (tax_amount >= 0)
);
grant select, insert, update, delete on deedbox.gl_bill_line to deedbox_app;

create or replace function deedbox.gl_bill_guard() returns trigger
language plpgsql as $$
begin
  if new.firm is distinct from old.firm then
    raise exception 'a bill never changes firm';
  end if;
  if old.status in ('paid','void') then
    raise exception 'a % bill is terminal', old.status;
  end if;
  if old.status = 'approved' then
    if new.contact is distinct from old.contact
       or new.bill_number is distinct from old.bill_number
       or new.bill_date is distinct from old.bill_date
       or new.net_amount is distinct from old.net_amount
       or new.tax_amount is distinct from old.tax_amount
       or new.total is distinct from old.total then
      raise exception 'an approved bill''s substance is frozen';
    end if;
    if new.status = 'void' and old.amount_paid > 0 then
      raise exception 'a part-paid bill cannot be voided';
    end if;
    if new.status = 'paid' and new.amount_paid <> new.total then
      raise exception 'paid means paid in full';
    end if;
    if new.status = 'draft' then
      raise exception 'an approved bill never returns to draft';
    end if;
  end if;
  if old.status = 'draft' and new.status = 'approved' then
    if new.journal is null then
      raise exception 'approval posts the accounts-payable journal';
    end if;
    if new.total <> new.net_amount + new.tax_amount then
      raise exception 'total = net + tax, to the cent';
    end if;
    if new.total = 0 then
      raise exception 'a zero bill cannot be approved';
    end if;
  end if;
  if old.status = 'draft' and new.status = 'paid' then
    raise exception 'a bill is approved before it is paid';
  end if;
  return new;
end $$;
create trigger gl_bill_guard before update on deedbox.gl_bill
for each row execute function deedbox.gl_bill_guard();

create or replace function deedbox.gl_bill_line_guard() returns trigger
language plpgsql as $$
declare v_status text;
begin
  if tg_op = 'DELETE' then
    select status into v_status from deedbox.gl_bill where id = old.bill;
    if v_status is null then return old; end if;
    if v_status <> 'draft' then
      raise exception 'lines of a % bill are fixed', v_status;
    end if;
    return old;
  end if;
  select status into v_status from deedbox.gl_bill
   where id = coalesce(new.bill, old.bill);
  if v_status is distinct from 'draft' then
    raise exception 'lines of a % bill are fixed', coalesce(v_status, 'missing');
  end if;
  return new;
end $$;
create trigger gl_bill_line_guard
before insert or update or delete on deedbox.gl_bill_line
for each row execute function deedbox.gl_bill_line_guard();

------------------------------------------------------------------------------
-- Banking: accounts, hash-deduped statement imports, rules, and the match
-- evidence. A statement line's identity is immutable; its only life is
-- unmatched → matched (with the journal recorded) or unmatched → ignored.
------------------------------------------------------------------------------
create table deedbox.gl_bank_account (
    id bigint generated always as identity primary key,
    firm bigint not null references deedbox.firm(id),
    account bigint not null references deedbox.gl_account(id),
    name text not null,
    kind text not null default 'bank' check (kind in ('bank','credit_card')),
    bank_identifier text,
    account_number text,
    csv_profile jsonb not null default '{}',
    active boolean not null default true,
    last_imported_at timestamptz,
    created_at timestamptz not null default now(),
    unique (firm, account)
);
grant select, insert, update on deedbox.gl_bank_account to deedbox_app;

create table deedbox.gl_import_batch (
    id bigint generated always as identity primary key,
    firm bigint not null references deedbox.firm(id),
    bank_account bigint not null references deedbox.gl_bank_account(id),
    imported_by bigint references deedbox.staff_member(id),
    filename text,
    row_count integer not null default 0,
    inserted_count integer not null default 0,
    duplicate_count integer not null default 0,
    created_at timestamptz not null default now()
);
grant select, insert on deedbox.gl_import_batch to deedbox_app;
-- the import writes its outcome counts back onto its own batch row and
-- nothing else: the batch's identity stays immutable at the grant level
grant update (inserted_count, duplicate_count) on deedbox.gl_import_batch to deedbox_app;

create table deedbox.gl_statement_line (
    id bigint generated always as identity primary key,
    firm bigint not null references deedbox.firm(id),
    bank_account bigint not null references deedbox.gl_bank_account(id),
    import_batch bigint references deedbox.gl_import_batch(id),
    transaction_date date not null,
    amount numeric(18,2) not null check (amount <> 0),
    direction text generated always as
      (case when amount >= 0 then 'in' else 'out' end) stored,
    description text,
    reference text,
    balance_after numeric(18,2),
    source_hash text not null,
    status text not null default 'unmatched' check (status in ('unmatched','matched','ignored')),
    matched_journal bigint references deedbox.gl_journal(id),
    reconciled_at timestamptz,
    reconciled_by bigint references deedbox.staff_member(id),
    created_at timestamptz not null default now(),
    unique (bank_account, source_hash)
);
create index gl_statement_line_status on deedbox.gl_statement_line (bank_account, status, transaction_date);
grant select, insert, update on deedbox.gl_statement_line to deedbox_app;

create or replace function deedbox.gl_statement_line_guard() returns trigger
language plpgsql as $$
begin
  if new.firm is distinct from old.firm
     or new.bank_account is distinct from old.bank_account
     or new.import_batch is distinct from old.import_batch
     or new.transaction_date is distinct from old.transaction_date
     or new.amount is distinct from old.amount
     or new.description is distinct from old.description
     or new.reference is distinct from old.reference
     or new.balance_after is distinct from old.balance_after
     or new.source_hash is distinct from old.source_hash then
    raise exception 'a statement line''s substance is what the bank said — immutable';
  end if;
  if old.status <> 'unmatched' then
    raise exception 'a % line is settled', old.status;
  end if;
  if new.status = 'matched' and new.matched_journal is null then
    raise exception 'matching records the journal';
  end if;
  if new.status in ('matched','ignored')
     and (new.reconciled_at is null or new.reconciled_by is null) then
    raise exception 'reconciling records who and when';
  end if;
  return new;
end $$;
create trigger gl_statement_line_guard before update on deedbox.gl_statement_line
for each row execute function deedbox.gl_statement_line_guard();

create table deedbox.gl_bank_rule (
    id bigint generated always as identity primary key,
    firm bigint not null references deedbox.firm(id),
    name text not null,
    bank_account bigint references deedbox.gl_bank_account(id),
    active boolean not null default true,
    priority integer not null default 100,
    match_desc_op text check (match_desc_op in ('contains','equals')),
    match_desc text,
    match_ref text,
    amount_min numeric(18,2),
    amount_max numeric(18,2),
    match_direction text not null default 'any' check (match_direction in ('in','out','any')),
    action text not null default 'suggest_only' check (action in
      ('receive_money','spend_money','suggest_only')),
    account bigint references deedbox.gl_account(id),
    tax_code bigint references deedbox.gl_tax_code(id),
    contact bigint references deedbox.gl_contact(id),
    auto_post boolean not null default false,
    created_by bigint references deedbox.staff_member(id),
    created_at timestamptz not null default now()
);
grant select, insert, update on deedbox.gl_bank_rule to deedbox_app;

create table deedbox.gl_match (
    id bigint generated always as identity primary key,
    firm bigint not null references deedbox.firm(id),
    statement_line bigint not null references deedbox.gl_statement_line(id),
    match_type text not null check (match_type in
      ('receive','spend','bill','transfer','ignore')),
    journal bigint references deedbox.gl_journal(id),
    bill bigint references deedbox.gl_bill(id),
    amount numeric(18,2),
    method text not null default 'manual' check (method in ('manual','rule','auto')),
    created_by bigint references deedbox.staff_member(id),
    created_at timestamptz not null default now()
);
create index gl_match_line on deedbox.gl_match (statement_line);
grant select, insert on deedbox.gl_match to deedbox_app;

------------------------------------------------------------------------------
-- Catalogue extensions: the gapless journal number series, the two settings
-- that light the module, the capability, the deletion policies.
------------------------------------------------------------------------------
insert into deedbox.number_format (purpose, scope, pattern, allocation_mode, reset) values
('gl_journal', null, 'GJ-{SEQ:6}', 'gapless', 'never');

insert into deedbox.setting_definition (key, value_type, neutral_default, allowed_values, description) values
('gl.enabled','boolean','false',null,
 'Whether the built-in office-accounting module is switched on. Off, every accounting door refuses and the navigation stays dark; the default books answer remains an external ledger.'),
('gl.conversion_date','text','""',null,
 'The date the firm''s office books begin here (ISO date). The practice bridge posts issued bills and payments from this date forward; blank means not yet configured.');

insert into deedbox.capability (key, description, grantable_to_firm_roles) values
  ('gl.manage',
   'Operate the firm''s office accounting: chart, journals, supplier bills, bank reconciliation, period locks, reports.',
   true);
insert into deedbox.role_capability (role, capability)
  select id, 'gl.manage' from deedbox.role where system_key = 'administrator';

insert into deedbox.deletion_policy (entity_type, mode) values
  ('gl_account', 'hard_delete_allowed'),
  ('gl_tax_code', 'hard_delete_allowed'),
  ('gl_contact', 'hard_delete_allowed'),
  ('gl_journal', 'hard_delete_allowed'),
  ('gl_journal_line', 'hard_delete_allowed'),
  ('gl_period', 'never_deletable'),
  ('gl_bill', 'hard_delete_allowed'),
  ('gl_bill_line', 'hard_delete_allowed'),
  ('gl_bank_account', 'hard_delete_allowed'),
  ('gl_import_batch', 'never_deletable'),
  ('gl_statement_line', 'never_deletable'),
  ('gl_bank_rule', 'hard_delete_allowed'),
  ('gl_match', 'never_deletable');

commit;
