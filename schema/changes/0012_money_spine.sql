-- 0012_money_spine — stage 5 (client money) opens with the heart of the
-- domain: client accounts, matter ledgers with the running-balance
-- discipline, authorisation decision rows (pulled forward so the
-- transaction header's FK is real), the balanced money transaction with
-- zero mutable fields, ledger lines with the never-below-zero rule enforced
-- at the database level, the posting protocol as one function, and the
-- permanent typed refusal register. The below-zero and balance guards bind
-- at the row level, and the posting protocol lands here except for two
-- steps deferred to later files (the period-lock check joins in 0014 when
-- period_close lands; gapless draws are the documents' duty in 0013).
--
-- Implementation notes:
--   * Ledger close/account deactivation guards land STAGED: balance and
--     closing-copy clauses now; earmark/instrument clauses extend the same
--     functions in 0013; dormancy and reconciliation clauses in 0014 —
--     the catalogue-hardening pattern from 0003.
--   * entry_no and running_balance are ASSIGNED by the line guard under
--     the ledger lock, never supplied by callers — the balance cannot be
--     forged because it is never accepted.
--   * The dishonour exemption from reversal authorisation keys on the
--     system-job principal (dishonour reversals are system-posted on the
--     bank's authority); staff-requested reversals of authorised
--     kinds still demand their authorisation row.
--   * Transaction shapes and per-account equality are DEFERRED constraint
--     triggers — the posting function writes header then lines; the
--     invariant binds at commit (tests force with SET CONSTRAINTS).
--   * refused_operation's separate-committed-transaction write is the
--     refusal capture protocol at the operations layer; the register lands
--     here with its insert-only discipline and single promotion transition
--     (promoted_incident's FK arrives with deficiency_incident in 0014).

begin;

------------------------------------------------------------------------------
-- client_account — firm money never enters.
------------------------------------------------------------------------------
create table deedbox.client_account (
    id bigint generated always as identity primary key,
    name text not null,
    account_kind text not null check (account_kind in ('pooled','separate_per_matter','statutory_set_aside')),
    linked_matter bigint references deedbox.matter(id),
    active boolean not null default true,
    deactivated_at timestamptz,
    deactivated_by bigint references deedbox.staff_member(id),
    created_at timestamptz not null default now(),
    check ((account_kind = 'separate_per_matter') = (linked_matter is not null))
);
create unique index client_account_name_unique on deedbox.client_account (name) where active;
create unique index client_account_linked_matter_unique
  on deedbox.client_account (linked_matter) where linked_matter is not null;
grant select, insert, update on deedbox.client_account to deedbox_app;

------------------------------------------------------------------------------
-- matter_ledger — the unit of the below-zero rule.
------------------------------------------------------------------------------
create table deedbox.matter_ledger (
    id bigint generated always as identity primary key,
    account bigint not null references deedbox.client_account(id),
    matter bigint references deedbox.matter(id),
    ledger_kind text not null default 'client_matter'
      check (ledger_kind in ('client_matter','set_aside_holding','set_aside_contra')),
    status text not null default 'open' check (status in ('open','closed')),
    closed_at timestamptz,
    closing_copy text,
    ledger_number text not null unique,
    reopened_count int not null default 0,
    created_at timestamptz not null default now(),
    check ((ledger_kind = 'client_matter') = (matter is not null)),
    check (status <> 'closed' or (closed_at is not null and closing_copy is not null))
);
create unique index matter_ledger_client_unique
  on deedbox.matter_ledger (account, matter) where ledger_kind = 'client_matter';
create unique index matter_ledger_special_unique
  on deedbox.matter_ledger (account, ledger_kind) where ledger_kind <> 'client_matter';
create index matter_ledger_matter_idx on deedbox.matter_ledger (matter);
create index matter_ledger_account_status_idx on deedbox.matter_ledger (account, status);
grant select, insert, update on deedbox.matter_ledger to deedbox_app;

-- (deedbox.ledger_balance is defined after ledger_line below — SQL-language
-- functions validate their references at creation; the plpgsql guards that
-- call it bind late, and no row exists before the whole file applies.)

create or replace function deedbox.matter_ledger_guard() returns trigger
language plpgsql as $$
declare acct deedbox.client_account%rowtype;
begin
  if tg_op = 'DELETE' then
    raise exception 'ledgers are never deleted';
  end if;
  if tg_op = 'INSERT' then
    select * into acct from deedbox.client_account ca where ca.id = new.account;
    if new.ledger_kind = 'set_aside_holding' and acct.account_kind <> 'statutory_set_aside' then
      raise exception 'a set-aside holding ledger lives only on a statutory set-aside account';
    end if;
    if new.ledger_kind = 'set_aside_contra' and acct.account_kind <> 'pooled' then
      raise exception 'a set-aside contra ledger lives only on a pooled account';
    end if;
    if acct.account_kind = 'separate_per_matter'
       and (new.ledger_kind <> 'client_matter' or new.matter is distinct from acct.linked_matter) then
      raise exception 'a separate-per-matter account holds exactly its linked matter''s ledger';
    end if;
    if acct.account_kind = 'statutory_set_aside' and new.ledger_kind <> 'set_aside_holding' then
      raise exception 'a statutory set-aside account holds exactly its holding ledger';
    end if;
    new.ledger_number := coalesce(new.ledger_number,
      'L' || new.account::text || '-' || lpad(nextval('deedbox.ledger_number_seq')::text, 6, '0'));
    return new;
  end if;
  -- UPDATE
  if new.account is distinct from old.account
     or new.matter is distinct from old.matter
     or new.ledger_kind is distinct from old.ledger_kind
     or new.ledger_number is distinct from old.ledger_number then
    raise exception 'a ledger''s identity is immutable';
  end if;
  if new.status = 'closed' and old.status = 'open' then
    if deedbox.ledger_balance(new.id) <> 0 then
      raise exception 'a ledger closes only at a zero balance';
    end if;
    -- 0013 extends this guard with earmark and instrument clauses; 0014 with dormancy.
    if new.closing_copy is null then
      raise exception 'the permanent closing copy is stored before the status flips';
    end if;
    new.closed_at := coalesce(new.closed_at, now());
  end if;
  if new.status = 'open' and old.status = 'closed' then
    -- the privileged reopen; reason + register are the operation's duty.
    new.reopened_count := old.reopened_count + 1;
    new.closed_at := null;
  end if;
  return new;
end $$;
create sequence if not exists deedbox.ledger_number_seq;
grant usage on deedbox.ledger_number_seq to deedbox_app;
create trigger matter_ledger_guard before insert or update or delete on deedbox.matter_ledger
for each row execute function deedbox.matter_ledger_guard();

------------------------------------------------------------------------------
-- payment_authorisation — insert-only decision rows (pulled forward).
------------------------------------------------------------------------------
create table deedbox.payment_authorisation (
    id bigint generated always as identity primary key,
    subject_type text not null check (subject_type in
      ('money_payment','ledger_transfer','firm_transfer','remittance','set_aside_move','reversal')),
    subject bigint not null,
    authoriser bigint not null references deedbox.staff_member(id),
    at timestamptz not null default now(),
    decision text not null check (decision in ('approved','rejected')),
    note text
);
create index payment_authorisation_subject_idx on deedbox.payment_authorisation (subject_type, subject);
grant select, insert on deedbox.payment_authorisation to deedbox_app;
create trigger payment_authorisation_append_only before update or delete on deedbox.payment_authorisation
for each row execute function deedbox.append_only_guard();

------------------------------------------------------------------------------
-- money_transaction — the balanced header; zero mutable fields.
------------------------------------------------------------------------------
create table deedbox.money_transaction (
    id bigint generated always as identity primary key,
    txn_kind text not null check (txn_kind in
      ('receipt','payment_out','ledger_transfer','firm_transfer','interest_posting',
       'bank_fee','set_aside_move','opening_balance','remittance','reversal')),
    effective_date date not null,
    entered_at timestamptz not null default now(),
    source_entered_at timestamptz,
    entered_by bigint not null references deedbox.staff_member(id),
    reason text,
    reverses bigint unique references deedbox.money_transaction(id),
    authorisation bigint references deedbox.payment_authorisation(id),
    source_type text not null,
    source bigint not null,
    check ((txn_kind = 'reversal') = (reverses is not null)),
    check (txn_kind not in ('ledger_transfer','firm_transfer','remittance','reversal')
           or (reason is not null and reason <> ''))
);
create index money_transaction_source_idx on deedbox.money_transaction (source_type, source);
create index money_transaction_date_idx on deedbox.money_transaction (effective_date);
grant select, insert on deedbox.money_transaction to deedbox_app;

create or replace function deedbox.money_transaction_guard() returns trigger
language plpgsql as $$
declare reversed_kind text; needs_auth boolean;
begin
  if tg_op in ('UPDATE','DELETE') then
    raise exception 'money transactions are immutable; corrections are reversal transactions';
  end if;
  needs_auth := new.txn_kind in ('payment_out','firm_transfer','ledger_transfer','remittance','set_aside_move');
  if new.txn_kind = 'reversal' then
    select t.txn_kind into reversed_kind from deedbox.money_transaction t where t.id = new.reverses;
    if reversed_kind = 'reversal' then
      raise exception 'a reversal is never itself reversed';
    end if;
    if reversed_kind in ('payment_out','firm_transfer','ledger_transfer','remittance','set_aside_move')
       and coalesce(current_setting('deedbox.principal_kind', true), '') <> 'system_job' then
      needs_auth := true;   -- staff-requested reversal of an authorised kind
    end if;
  end if;
  if needs_auth and new.authorisation is null then
    raise exception 'transaction kind % requires its authorisation row', new.txn_kind;
  end if;
  if new.authorisation is not null then
    if (select a.decision from deedbox.payment_authorisation a where a.id = new.authorisation) <> 'approved' then
      raise exception 'a transaction posts only on an approved authorisation';
    end if;
  end if;
  return new;
end $$;
create trigger money_transaction_guard before insert or update or delete on deedbox.money_transaction
for each row execute function deedbox.money_transaction_guard();

------------------------------------------------------------------------------
-- ledger_line — the never-below-zero rule lives here.
------------------------------------------------------------------------------
create table deedbox.ledger_line (
    id bigint generated always as identity primary key,
    transaction bigint not null references deedbox.money_transaction(id),
    side text not null check (side in ('cash_book','matter_ledger')),
    account bigint not null references deedbox.client_account(id),
    matter_ledger bigint references deedbox.matter_ledger(id),
    signed_amount numeric(14,2) not null check (signed_amount <> 0),
    entry_no int,
    running_balance numeric(14,2),
    check ((side = 'matter_ledger') = (matter_ledger is not null)),
    check ((side = 'matter_ledger') = (entry_no is not null)),
    check ((side = 'matter_ledger') = (running_balance is not null))
);
create unique index ledger_line_entry_unique
  on deedbox.ledger_line (matter_ledger, entry_no) where matter_ledger is not null;
create index ledger_line_txn_idx on deedbox.ledger_line (transaction);
create index ledger_line_account_idx on deedbox.ledger_line (account, side);
grant select, insert on deedbox.ledger_line to deedbox_app;

-- balance = the running balance of the highest entry_no line, zero when none.
create or replace function deedbox.ledger_balance(p_ledger bigint) returns numeric
language sql stable as $$
  select coalesce((select l.running_balance from deedbox.ledger_line l
                    where l.matter_ledger = p_ledger
                    order by l.entry_no desc limit 1), 0);
$$;

create or replace function deedbox.ledger_line_guard() returns trigger
language plpgsql as $$
declare led deedbox.matter_ledger%rowtype; prior numeric; prior_no int;
begin
  if tg_op in ('UPDATE','DELETE') then
    raise exception 'ledger lines are immutable; corrections are reversal transactions';
  end if;
  if new.side = 'matter_ledger' then
    select * into led from deedbox.matter_ledger ml where ml.id = new.matter_ledger;
    if led.account <> new.account then
      raise exception 'a ledger line''s account must equal its ledger''s account';
    end if;
    if led.status <> 'open' then
      raise exception 'postings land on open ledgers only (reopen first)';
    end if;
    -- assigned under the ledger lock, never accepted from the caller.
    select l.entry_no, l.running_balance into prior_no, prior
      from deedbox.ledger_line l where l.matter_ledger = new.matter_ledger
     order by l.entry_no desc limit 1;
    new.entry_no := coalesce(prior_no, 0) + 1;
    new.running_balance := coalesce(prior, 0) + new.signed_amount;
    if led.ledger_kind in ('client_matter','set_aside_holding') and new.running_balance < 0 then
      raise exception 'refused: ledger % would go below zero (%)', led.ledger_number, new.running_balance;
    end if;
    if led.ledger_kind = 'set_aside_contra' and new.running_balance > 0 then
      raise exception 'refused: a set-aside contra ledger never goes above zero';
    end if;
  end if;
  return new;
end $$;
create trigger ledger_line_guard before insert or update or delete on deedbox.ledger_line
for each row execute function deedbox.ledger_line_guard();

-- Shape + balance verification at commit: per account touched by a
-- transaction, cash-book and matter-ledger sums agree; the line set matches
-- the transaction kind's fixed shape; a contra-carrying account's cash book
-- stays at or above zero.
create or replace function deedbox.z_assert_txn_shape() returns trigger
language plpgsql as $$
declare t deedbox.money_transaction%rowtype;
        n_cash int; n_led int; sum_cash numeric; sum_led numeric; bad bigint;
begin
  select * into t from deedbox.money_transaction mt where mt.id = new.transaction;
  select count(*) filter (where l.side = 'cash_book'),
         count(*) filter (where l.side = 'matter_ledger'),
         coalesce(sum(l.signed_amount) filter (where l.side = 'cash_book'), 0),
         coalesce(sum(l.signed_amount) filter (where l.side = 'matter_ledger'), 0)
    into n_cash, n_led, sum_cash, sum_led
    from deedbox.ledger_line l where l.transaction = t.id;

  -- per-account equality across the transaction's lines.
  select l.account into bad
    from deedbox.ledger_line l where l.transaction = t.id
   group by l.account
  having coalesce(sum(l.signed_amount) filter (where l.side = 'cash_book'), 0)
      <> coalesce(sum(l.signed_amount) filter (where l.side = 'matter_ledger'), 0)
   limit 1;
  if bad is not null then
    raise exception 'transaction % does not balance on account %', t.id, bad;
  end if;

  if t.txn_kind in ('receipt','opening_balance') then
    if n_cash <> 1 or n_led <> 1 or sum_cash <= 0 or sum_cash <> sum_led then
      raise exception 'a % posts one positive cash line and one equal ledger line', t.txn_kind;
    end if;
  elsif t.txn_kind in ('payment_out','firm_transfer','remittance') then
    if n_cash <> 1 or n_led <> 1 or sum_cash >= 0 or sum_cash <> sum_led then
      raise exception 'a % posts one negative cash line and one equal ledger line', t.txn_kind;
    end if;
  elsif t.txn_kind = 'ledger_transfer' then
    if n_cash <> 0 or n_led <> 2 or sum_led <> 0
       or (select count(distinct l.account) from deedbox.ledger_line l where l.transaction = t.id) <> 1 then
      raise exception 'a ledger transfer is two ledger lines in one account netting to zero';
    end if;
  elsif t.txn_kind in ('interest_posting','bank_fee','set_aside_move') then
    if n_cash <> 1 or n_led <> 1 or sum_cash <> sum_led then
      raise exception 'a % posts one cash line and one equal ledger line', t.txn_kind;
    end if;
    if t.txn_kind = 'interest_posting' and sum_cash <= 0 then
      raise exception 'interest posts positive';
    end if;
    if t.txn_kind = 'bank_fee' and sum_cash >= 0 then
      raise exception 'a bank fee posts negative';
    end if;
  elsif t.txn_kind = 'reversal' then
    if exists (
      select coalesce(o.matter_ledger, -1), o.side, o.account, -o.signed_amount
        from deedbox.ledger_line o where o.transaction = t.reverses
      except
      select coalesce(r.matter_ledger, -1), r.side, r.account, r.signed_amount
        from deedbox.ledger_line r where r.transaction = t.id)
    or (select count(*) from deedbox.ledger_line o where o.transaction = t.reverses)
       <> (select count(*) from deedbox.ledger_line r where r.transaction = t.id) then
      raise exception 'a reversal mirrors the reversed transaction''s lines exactly';
    end if;
  end if;

  -- contra-carrying accounts: the cash book never goes negative.
  select l.account into bad
    from deedbox.ledger_line l
   where l.transaction = t.id
     and exists (select 1 from deedbox.matter_ledger c
                  where c.account = l.account and c.ledger_kind = 'set_aside_contra')
   group by l.account
  having (select coalesce(sum(x.signed_amount), 0) from deedbox.ledger_line x
           where x.account = l.account and x.side = 'cash_book') < 0
   limit 1;
  if bad is not null then
    raise exception 'account % cash book would go negative', bad;
  end if;
  return null;
end $$;
create constraint trigger z_assert_txn_shape
after insert on deedbox.ledger_line
deferrable initially deferred
for each row execute function deedbox.z_assert_txn_shape();

------------------------------------------------------------------------------
-- The posting protocol: one function every posting operation calls.
-- Lines arrive as jsonb: [{side, account, matter_ledger, signed_amount}].
------------------------------------------------------------------------------
create or replace function deedbox.post_money_transaction(
    p_kind text, p_effective_date date, p_entered_by bigint,
    p_source_type text, p_source bigint,
    p_lines jsonb,
    p_reason text default null,
    p_authorisation bigint default null,
    p_reverses bigint default null,
    p_source_entered_at timestamptz default null)
returns bigint language plpgsql as $$
declare txn bigint; ln jsonb; l_ids bigint[];
begin
  -- step 1: serialise on every touched ledger, ascending id order; then any
  -- contra ledger of a touched account.
  select array_agg(distinct (x->>'matter_ledger')::bigint order by (x->>'matter_ledger')::bigint)
    into l_ids
    from jsonb_array_elements(p_lines) x
   where x->>'matter_ledger' is not null;
  if l_ids is not null then
    perform 1 from deedbox.matter_ledger ml where ml.id = any(l_ids) order by ml.id for update;
    perform 1 from deedbox.matter_ledger c
      where c.ledger_kind = 'set_aside_contra'
        and c.account in (select distinct (x->>'account')::bigint from jsonb_array_elements(p_lines) x)
      order by c.id for update;
  end if;
  -- step 6: write header + lines (guards assign balances and refuse
  -- violations; the deferred shape assertion binds the whole at commit).
  insert into deedbox.money_transaction
      (txn_kind, effective_date, entered_by, reason, reverses, authorisation,
       source_type, source, source_entered_at)
  values (p_kind, p_effective_date, p_entered_by, p_reason, p_reverses, p_authorisation,
          p_source_type, p_source, p_source_entered_at)
  returning id into txn;
  for ln in select * from jsonb_array_elements(p_lines) loop
    insert into deedbox.ledger_line (transaction, side, account, matter_ledger, signed_amount)
    values (txn, ln->>'side', (ln->>'account')::bigint,
            (ln->>'matter_ledger')::bigint, (ln->>'signed_amount')::numeric);
  end loop;
  return txn;
end $$;

------------------------------------------------------------------------------
-- refused_operation — the permanent typed exception register.
------------------------------------------------------------------------------
create table deedbox.refused_operation (
    id bigint generated always as identity primary key,
    account bigint not null references deedbox.client_account(id),
    matter_ledger bigint references deedbox.matter_ledger(id),
    attempted_operation jsonb not null,
    refusal_reason text not null check (refusal_reason in
      ('would_go_below_zero','period_locked','earmark_shortfall','entitlement_missing',
       'notice_not_elapsed','method_unavailable','authorisation_missing','integrity_refusal')),
    attempted_by_kind text not null default 'staff',
    attempted_by bigint not null,
    at timestamptz not null default now(),
    promoted_incident bigint     -- FK lands with deficiency_incident in 0014
);
create index refused_operation_account_idx on deedbox.refused_operation (account, at);
create index refused_operation_untriaged_idx on deedbox.refused_operation (id) where promoted_incident is null;
grant select, insert, update on deedbox.refused_operation to deedbox_app;

create or replace function deedbox.refused_operation_guard() returns trigger
language plpgsql as $$
begin
  if tg_op = 'DELETE' then
    raise exception 'the refusal register is permanent';
  end if;
  if tg_op = 'UPDATE' then
    if old.promoted_incident is not null
       or new.promoted_incident is null
       or new.account is distinct from old.account
       or new.matter_ledger is distinct from old.matter_ledger
       or new.attempted_operation is distinct from old.attempted_operation
       or new.refusal_reason is distinct from old.refusal_reason
       or new.attempted_by is distinct from old.attempted_by
       or new.at is distinct from old.at then
      raise exception 'a refusal admits exactly one mutation: its promotion to an incident';
    end if;
  end if;
  return new;
end $$;
create trigger refused_operation_guard before update or delete on deedbox.refused_operation
for each row execute function deedbox.refused_operation_guard();

commit;
