-- 0014_money_statutory — the proving layer of client money: incidents and
-- regulator approvals, bank statement lines, reconciliation with matches,
-- typed exceptions and the CERTIFICATION EQUATION enforced in the database,
-- period close with the every-ledger balance listing and the PERIOD LOCK
-- joining the posting path, set-aside requirements and calculations,
-- dormancy with contact evidence and the remittance register that survives
-- matter closure, client money statements, statutory registers and
-- examination pack exports. The refusal register's promotion FK and the
-- payment's dormant-case FK bind; the ledger-close and account-deactivation
-- guards take their final clauses. The jobs (feed ingest, close
-- materialiser, dormancy detection, set-aside recalculation) and artefact
-- generation are app-layer.
--
-- Implementation notes:
--   * The certification equation compares against the account's cash-book
--     total over transactions effective-dated on or before the statement
--     date (date-consistent both sides); bank-error exception amounts are
--     signed as recorded; unbanked receipts add, unpresented payments
--     subtract.
--   * Certification transitions covered instruments mechanically in the
--     same transaction (created/stale -> presented outbound; banked ->
--     cleared inbound), exactly as the instrument lifecycle directs.
--   * The account-deactivation guard demands: zero cash book, every ledger
--     closed, and a certified reconciliation at the final position (dated
--     on or after the account's last posting, statement balance equal to
--     the zero cash book).
--   * Register entry values live in the custom-field engine (owner_type
--     statutory_register_entry); the entry row carries the dense number.

begin;

------------------------------------------------------------------------------
-- Incidents and regulator approvals.
------------------------------------------------------------------------------
create table deedbox.deficiency_incident (
    id bigint generated always as identity primary key,
    account bigint not null references deedbox.client_account(id),
    matter_ledger bigint references deedbox.matter_ledger(id),
    incident_date date not null,
    amount numeric(14,2) not null,
    cause text not null check (cause <> ''),
    rectification jsonb,
    narrative text not null check (narrative <> ''),
    state text not null default 'open' check (state in ('open','rectified','reported')),
    notification_artefact text,
    origin text not null check (origin in ('promoted_refusal','reconciliation','manual')),
    created_at timestamptz not null default now(),
    check (state <> 'reported' or notification_artefact is not null)
);
create index deficiency_incident_state_idx on deedbox.deficiency_incident (state);
grant select, insert, update on deedbox.deficiency_incident to deedbox_app;

create or replace function deedbox.deficiency_incident_guard() returns trigger
language plpgsql as $$
begin
  if tg_op = 'DELETE' then
    raise exception 'incidents are never deleted';
  end if;
  if new.state is distinct from old.state then
    if not ( (old.state = 'open' and new.state in ('rectified','reported'))
          or (old.state = 'rectified' and new.state = 'reported') ) then
      raise exception 'illegal incident transition % -> %', old.state, new.state;
    end if;
    if new.state = 'rectified'
       and (new.rectification is null or jsonb_array_length(coalesce(new.rectification->'transactions','[]')) = 0) then
      raise exception 'rectification names at least one correcting transaction';
    end if;
  elsif old.state = 'reported'
        and new.rectification is not distinct from old.rectification then
    raise exception 'a reported incident admits only appended rectification evidence';
  end if;
  return new;
end $$;
create trigger deficiency_incident_guard before update or delete on deedbox.deficiency_incident
for each row execute function deedbox.deficiency_incident_guard();

alter table deedbox.refused_operation
  add constraint refused_operation_incident_fk
  foreign key (promoted_incident) references deedbox.deficiency_incident(id);

create table deedbox.regulator_approval (
    id bigint generated always as identity primary key,
    approval_kind text not null,
    approval_number text not null,
    valid_from date not null,
    valid_to date,
    evidence text,
    created_at timestamptz not null default now(),
    unique (approval_kind, approval_number)
);
grant select, insert, update on deedbox.regulator_approval to deedbox_app;

------------------------------------------------------------------------------
-- Bank statement lines — the account's own record.
------------------------------------------------------------------------------
create table deedbox.bank_statement_line (
    id bigint generated always as identity primary key,
    account bigint not null references deedbox.client_account(id),
    line_date date not null,
    amount numeric(14,2) not null check (amount <> 0),
    description text not null,
    bank_ref text,
    source text not null check (source in ('bank_feed','manual','import')),
    feed_ref text,
    created_at timestamptz not null default now()
);
create unique index bank_statement_line_feed_unique
  on deedbox.bank_statement_line (account, feed_ref) where feed_ref is not null;
create index bank_statement_line_date_idx on deedbox.bank_statement_line (account, line_date);
grant select, insert on deedbox.bank_statement_line to deedbox_app;
create trigger bank_statement_line_append_only before update or delete on deedbox.bank_statement_line
for each row execute function deedbox.append_only_guard();

------------------------------------------------------------------------------
-- Reconciliation — an editable workspace until the certification locks it
-- forever.
------------------------------------------------------------------------------
create table deedbox.reconciliation (
    id bigint generated always as identity primary key,
    account bigint not null references deedbox.client_account(id),
    statement_date date not null,
    statement_balance numeric(14,2) not null,
    status text not null default 'in_progress' check (status in ('in_progress','certified')),
    certified_by bigint references deedbox.staff_member(id),
    certified_at timestamptz,
    equation_snapshot jsonb,
    created_at timestamptz not null default now(),
    unique (account, statement_date),
    check (status <> 'certified' or (certified_by is not null and certified_at is not null and equation_snapshot is not null))
);
create unique index reconciliation_one_in_progress
  on deedbox.reconciliation (account) where status = 'in_progress';
grant select, insert, update on deedbox.reconciliation to deedbox_app;

create table deedbox.recon_match (
    id bigint generated always as identity primary key,
    reconciliation bigint not null references deedbox.reconciliation(id)
);
create index recon_match_recon_idx on deedbox.recon_match (reconciliation);
grant select, insert, delete on deedbox.recon_match to deedbox_app;

create table deedbox.recon_match_member (
    id bigint generated always as identity primary key,
    match_group bigint not null references deedbox.recon_match(id),
    member_kind text not null check (member_kind in ('statement_line','transaction')),
    statement_line bigint references deedbox.bank_statement_line(id),
    transaction bigint references deedbox.money_transaction(id),
    check ((member_kind = 'statement_line') = (statement_line is not null)),
    check ((member_kind = 'transaction') = (transaction is not null))
);
create index recon_match_member_group_idx on deedbox.recon_match_member (match_group);
create index recon_match_member_line_idx on deedbox.recon_match_member (statement_line);
create index recon_match_member_txn_idx on deedbox.recon_match_member (transaction);
grant select, insert, delete on deedbox.recon_match_member to deedbox_app;

create table deedbox.recon_exception (
    id bigint generated always as identity primary key,
    first_reconciliation bigint not null references deedbox.reconciliation(id),
    reconciliation bigint not null references deedbox.reconciliation(id),
    exception_type text not null check (exception_type in ('unpresented_payment','unbanked_receipt','bank_error')),
    linked_type text not null,
    linked bigint not null,
    amount numeric(14,2) not null,
    arising_date date not null,
    state text not null default 'open' check (state in ('open','resolved','carried_forward')),
    resolved_in bigint references deedbox.reconciliation(id),
    resolution_note text,
    carried_to bigint references deedbox.recon_exception(id),
    created_at timestamptz not null default now(),
    unique (reconciliation, linked_type, linked),
    check ((state = 'resolved') = (resolved_in is not null)),
    check ((state = 'carried_forward') = (carried_to is not null))
);
create index recon_exception_recon_state_idx on deedbox.recon_exception (reconciliation, state);
create index recon_exception_linked_idx on deedbox.recon_exception (linked_type, linked);
grant select, insert, update on deedbox.recon_exception to deedbox_app;

-- workspace verbs live while in_progress; certification locks matches and
-- members forever. Exceptions keep exactly their two lifecycle transitions
-- after certification — a later build resolves them (resolved_in names it)
-- or carries them forward (carried_to names the successor row) — and
-- nothing else about them ever moves.
create or replace function deedbox.recon_child_guard() returns trigger
language plpgsql as $$
declare rec bigint; st text;
begin
  if tg_table_name = 'recon_match' then
    rec := coalesce(new.reconciliation, old.reconciliation);
  elsif tg_table_name = 'recon_match_member' then
    select m.reconciliation into rec from deedbox.recon_match m
     where m.id = coalesce(new.match_group, old.match_group);
  else
    rec := coalesce(new.reconciliation, old.reconciliation);
  end if;
  select r.status into st from deedbox.reconciliation r where r.id = rec;
  if tg_table_name = 'recon_exception' then
    if tg_op = 'DELETE' then
      raise exception 'exceptions are resolved or carried forward, never deleted';
    end if;
    if tg_op = 'INSERT' then
      if st <> 'in_progress' then
        raise exception 'exceptions are raised on the in-progress build';
      end if;
      return new;
    end if;
    -- UPDATE: free while in_progress; a certified row admits only its
    -- open -> resolved / carried_forward transition, everything else frozen.
    if st = 'in_progress' then
      return new;
    end if;
    if old.state <> 'open'
       or new.state not in ('resolved','carried_forward')
       or new.first_reconciliation is distinct from old.first_reconciliation
       or new.reconciliation is distinct from old.reconciliation
       or new.exception_type is distinct from old.exception_type
       or new.linked_type is distinct from old.linked_type
       or new.linked is distinct from old.linked
       or new.amount is distinct from old.amount
       or new.arising_date is distinct from old.arising_date then
      raise exception 'a certified exception admits only its resolution or carry-forward';
    end if;
    return new;
  end if;
  if st <> 'in_progress' then
    raise exception 'a certified reconciliation''s matches are locked forever';
  end if;
  return coalesce(new, old);
end $$;
create trigger recon_match_guard before insert or update or delete on deedbox.recon_match
for each row execute function deedbox.recon_child_guard();
create trigger recon_match_member_guard before insert or update or delete on deedbox.recon_match_member
for each row execute function deedbox.recon_child_guard();
create trigger recon_exception_guard before insert or update or delete on deedbox.recon_exception
for each row execute function deedbox.recon_child_guard();

-- The certification: the equation holds to the cent; everything dated in
-- scope is matched or excepted; prior opens are resolved or carried; match
-- members are unique across the account's certified history; covered
-- instruments transition. No adjusting mechanism exists.
create or replace function deedbox.reconciliation_guard() returns trigger
language plpgsql as $$
declare unbanked numeric; unpresented numeric; bank_err numeric; book numeric;
        lhs numeric; bad bigint; grp record;
begin
  if tg_op = 'DELETE' then
    raise exception 'reconciliations are never deleted';
  end if;
  if old.status = 'certified' then
    raise exception 'a certified reconciliation is locked forever';
  end if;
  if new.status = 'certified' then
    -- each match group balances.
    for grp in
      select m.id,
             coalesce(sum(sl.amount), 0) line_sum,
             coalesce((select sum(l.signed_amount) from deedbox.ledger_line l
                        where l.side = 'cash_book'
                          and l.transaction in (select mm2.transaction from deedbox.recon_match_member mm2
                                                 where mm2.match_group = m.id and mm2.member_kind = 'transaction')), 0) txn_sum
        from deedbox.recon_match m
        left join deedbox.recon_match_member mm on mm.match_group = m.id and mm.member_kind = 'statement_line'
        left join deedbox.bank_statement_line sl on sl.id = mm.statement_line
       where m.reconciliation = new.id
       group by m.id
    loop
      if grp.line_sum <> grp.txn_sum then
        raise exception 'match group % does not balance (% vs %)', grp.id, grp.line_sum, grp.txn_sum;
      end if;
    end loop;
    -- member uniqueness across the account's certified matches.
    select mm.statement_line into bad
      from deedbox.recon_match_member mm
      join deedbox.recon_match m on m.id = mm.match_group
     where m.reconciliation = new.id and mm.member_kind = 'statement_line'
       and exists (select 1 from deedbox.recon_match_member x
                    join deedbox.recon_match xm on xm.id = x.match_group
                    join deedbox.reconciliation xr on xr.id = xm.reconciliation
                   where x.statement_line = mm.statement_line and xr.status = 'certified'
                     and xr.account = new.account)
     limit 1;
    if bad is not null then
      raise exception 'statement line % is already matched in a certified reconciliation', bad;
    end if;
    -- every statement line in scope is matched or excepted.
    select sl.id into bad from deedbox.bank_statement_line sl
     where sl.account = new.account and sl.line_date <= new.statement_date
       and not exists (select 1 from deedbox.recon_match_member mm
                        join deedbox.recon_match m on m.id = mm.match_group
                        join deedbox.reconciliation r on r.id = m.reconciliation
                       where mm.statement_line = sl.id
                         and (r.id = new.id or r.status = 'certified'))
       and not exists (select 1 from deedbox.recon_exception e
                        where e.reconciliation = new.id
                          and e.linked_type = 'statement_line' and e.linked = sl.id)
     limit 1;
    if bad is not null then
      raise exception 'statement line % is neither matched nor excepted', bad;
    end if;
    -- every unmatched transaction in scope is excepted (instrument-backed
    -- unpresented payments link their instrument; others their transaction).
    select t.id into bad
      from deedbox.money_transaction t
     where t.effective_date <= new.statement_date
       and exists (select 1 from deedbox.ledger_line l
                    where l.transaction = t.id and l.account = new.account and l.side = 'cash_book')
       and not exists (select 1 from deedbox.recon_match_member mm
                        join deedbox.recon_match m on m.id = mm.match_group
                        join deedbox.reconciliation r on r.id = m.reconciliation
                       where mm.transaction = t.id
                         and (r.id = new.id or (r.status = 'certified' and r.account = new.account)))
       and not exists (select 1 from deedbox.recon_exception e
                        where e.reconciliation = new.id and e.state <> 'resolved'
                          and ((e.linked_type = 'transaction' and e.linked = t.id)
                            or (e.linked_type = 'instrument' and e.linked in
                                (select i.id from deedbox.instrument i where i.transaction = t.id))))
     limit 1;
    if bad is not null then
      raise exception 'transaction % is neither matched nor excepted', bad;
    end if;
    -- prior open exceptions are resolved or carried forward into this build.
    select e.id into bad
      from deedbox.recon_exception e
      join deedbox.reconciliation r on r.id = e.reconciliation
     where r.account = new.account and r.status = 'certified' and e.state = 'open'
     limit 1;
    if bad is not null then
      raise exception 'prior exception % is neither resolved nor carried forward', bad;
    end if;
    -- the equation, to the cent.
    select coalesce(sum(e.amount) filter (where e.exception_type = 'unbanked_receipt'), 0),
           coalesce(sum(e.amount) filter (where e.exception_type = 'unpresented_payment'), 0),
           coalesce(sum(e.amount) filter (where e.exception_type = 'bank_error'), 0)
      into unbanked, unpresented, bank_err
      from deedbox.recon_exception e
     where e.reconciliation = new.id and e.state = 'open';
    select coalesce(sum(l.signed_amount), 0) into book
      from deedbox.ledger_line l
      join deedbox.money_transaction t on t.id = l.transaction
     where l.account = new.account and l.side = 'cash_book'
       and t.effective_date <= new.statement_date;
    lhs := new.statement_balance + unbanked - unpresented + bank_err;
    if lhs <> book then
      raise exception 'the certification equation fails: % + % - % + % = % but the book total is %',
        new.statement_balance, unbanked, unpresented, bank_err, lhs, book;
    end if;
    new.equation_snapshot := coalesce(new.equation_snapshot, jsonb_build_object(
      'statement_balance', new.statement_balance, 'unbanked_receipts', unbanked,
      'unpresented_payments', unpresented, 'bank_errors', bank_err, 'ledger_total', book));
    new.certified_at := coalesce(new.certified_at, now());
  end if;
  return new;
end $$;
create trigger reconciliation_guard before update or delete on deedbox.reconciliation
for each row execute function deedbox.reconciliation_guard();

-- covered instruments transition inside certification, mechanically.
create or replace function deedbox.reconciliation_instruments() returns trigger
language plpgsql as $$
begin
  update deedbox.instrument i
     set state = 'presented', state_changed_at = now()
   where i.direction = 'outbound' and i.state in ('created','stale')
     and i.transaction in (select mm.transaction from deedbox.recon_match_member mm
                            join deedbox.recon_match m on m.id = mm.match_group
                           where m.reconciliation = new.id and mm.member_kind = 'transaction');
  update deedbox.instrument i
     set state = 'cleared', state_changed_at = now()
   where i.direction = 'inbound' and i.state = 'banked'
     and i.transaction in (select mm.transaction from deedbox.recon_match_member mm
                            join deedbox.recon_match m on m.id = mm.match_group
                           where m.reconciliation = new.id and mm.member_kind = 'transaction');
  return null;
end $$;
create trigger reconciliation_instruments after update on deedbox.reconciliation
for each row when (new.status = 'certified' and old.status = 'in_progress')
execute function deedbox.reconciliation_instruments();

------------------------------------------------------------------------------
-- Period close — and the period lock joining the posting path.
------------------------------------------------------------------------------
create table deedbox.period_close (
    id bigint generated always as identity primary key,
    scope text not null check (scope in ('account','all_accounts')),
    account bigint references deedbox.client_account(id),
    period_start date not null,
    period_end date not null,
    due_by date,
    status text not null check (status in ('due','in_progress','certified')),
    certified_by bigint references deedbox.staff_member(id),
    certified_at timestamptz,
    late boolean,
    report_artefact text,
    created_at timestamptz not null default now(),
    check ((scope = 'account') = (account is not null)),
    check (period_end >= period_start),
    check (status <> 'certified' or (certified_by is not null and certified_at is not null
           and late is not null and report_artefact is not null))
);
create unique index period_close_unique on deedbox.period_close (scope, coalesce(account,-1), period_start);
create index period_close_status_idx on deedbox.period_close (status);
create index period_close_lock_idx on deedbox.period_close (account, period_end) where status = 'certified';
grant select, insert, update on deedbox.period_close to deedbox_app;

create table deedbox.balance_listing_line (
    id bigint generated always as identity primary key,
    close bigint not null references deedbox.period_close(id),
    matter_ledger bigint not null references deedbox.matter_ledger(id),
    balance numeric(14,2) not null,
    unique (close, matter_ledger)
);
grant select, insert on deedbox.balance_listing_line to deedbox_app;
create trigger balance_listing_line_append_only before update or delete on deedbox.balance_listing_line
for each row execute function deedbox.append_only_guard();

create or replace function deedbox.period_close_guard() returns trigger
language plpgsql as $$
declare led record; listing_total numeric := 0; book numeric;
begin
  if tg_op = 'DELETE' then
    raise exception 'period closes are never deleted';
  end if;
  if old.status = 'certified' then
    raise exception 'a certified close is never reopened; a later shortfall is an incident';
  end if;
  if new.status is distinct from old.status then
    if not ( (old.status = 'due' and new.status = 'in_progress')
          or (old.status = 'in_progress' and new.status = 'certified') ) then
      raise exception 'illegal close transition % -> %', old.status, new.status;
    end if;
  end if;
  if new.status = 'certified' and old.status <> 'certified' then
    -- the listing covers every ledger of every kind in scope, recomputed
    -- from lines, and totals the bank position; refused otherwise.
    for led in select ml.id from deedbox.matter_ledger ml
                where (new.scope = 'all_accounts' or ml.account = new.account)
    loop
      insert into deedbox.balance_listing_line (close, matter_ledger, balance)
      values (new.id, led.id, deedbox.ledger_balance(led.id));
      listing_total := listing_total + deedbox.ledger_balance(led.id);
    end loop;
    select coalesce(sum(l.signed_amount), 0) into book
      from deedbox.ledger_line l
     where l.side = 'cash_book'
       and (new.scope = 'all_accounts' or l.account = new.account);
    if listing_total <> book then
      raise exception 'the balance listing (%) does not total the bank position (%) — refused', listing_total, book;
    end if;
    new.late := coalesce(new.late,
      new.due_by is not null and (now() at time zone
        (select f.timezone from deedbox.firm f limit 1))::date > new.due_by);
    new.certified_at := coalesce(new.certified_at, now());
  end if;
  return new;
end $$;
create trigger period_close_guard before update or delete on deedbox.period_close
for each row execute function deedbox.period_close_guard();

-- the period lock: no posting lands inside a certified close.
create or replace function deedbox.z_assert_period_open() returns trigger
language plpgsql as $$
declare eff date;
begin
  select t.effective_date into eff from deedbox.money_transaction t where t.id = new.transaction;
  if exists (select 1 from deedbox.period_close pc
              where pc.status = 'certified'
                and (pc.scope = 'all_accounts' or pc.account = new.account)
                and eff between pc.period_start and pc.period_end) then
    raise exception 'period_locked: % falls inside a certified close', eff;
  end if;
  return new;
end $$;
create trigger a_assert_period_open before insert on deedbox.ledger_line
for each row execute function deedbox.z_assert_period_open();

------------------------------------------------------------------------------
-- The statutory set-aside formula and its calculation history.
------------------------------------------------------------------------------
create table deedbox.set_aside_requirement (
    id bigint generated always as identity primary key,
    account bigint not null unique references deedbox.client_account(id),
    formula_pack_version bigint not null references deedbox.pack_version(id),
    recalculation_schedule jsonb not null,
    created_at timestamptz not null default now()
);
grant select, insert, update on deedbox.set_aside_requirement to deedbox_app;

create table deedbox.set_aside_calculation (
    id bigint generated always as identity primary key,
    requirement bigint not null references deedbox.set_aside_requirement(id),
    calculated_at timestamptz not null default now(),
    required_balance numeric(14,2) not null,
    actual_balance numeric(14,2) not null,
    inputs jsonb not null,
    movement_transaction bigint references deedbox.money_transaction(id)
);
create index set_aside_calculation_req_idx on deedbox.set_aside_calculation (requirement, calculated_at desc);
grant select, insert, update on deedbox.set_aside_calculation to deedbox_app;

create or replace function deedbox.set_aside_calculation_guard() returns trigger
language plpgsql as $$
begin
  if tg_op = 'DELETE' then
    raise exception 'set-aside calculations are never deleted';
  end if;
  if old.movement_transaction is not null
     or new.movement_transaction is null
     or new.requirement is distinct from old.requirement
     or new.required_balance is distinct from old.required_balance
     or new.actual_balance is distinct from old.actual_balance
     or new.inputs is distinct from old.inputs
     or new.calculated_at is distinct from old.calculated_at then
    raise exception 'a calculation admits exactly one mutation: linking its movement';
  end if;
  return new;
end $$;
create trigger set_aside_calculation_guard before update or delete on deedbox.set_aside_calculation
for each row execute function deedbox.set_aside_calculation_guard();

------------------------------------------------------------------------------
-- Dormancy, contact evidence, the surviving remittance register.
------------------------------------------------------------------------------
create table deedbox.dormant_case (
    id bigint generated always as identity primary key,
    matter_ledger bigint not null references deedbox.matter_ledger(id),
    detected_at timestamptz not null default now(),
    balance_at_detection numeric(14,2) not null,
    state text not null default 'open'
      check (state in ('open','contact_in_progress','remitted','resolved')),
    resolved_reason text,
    created_at timestamptz not null default now(),
    check (state <> 'resolved' or resolved_reason is not null)
);
create unique index dormant_case_one_live
  on deedbox.dormant_case (matter_ledger) where state in ('open','contact_in_progress');
create index dormant_case_state_idx on deedbox.dormant_case (state);
grant select, insert, update on deedbox.dormant_case to deedbox_app;

create or replace function deedbox.dormant_case_guard() returns trigger
language plpgsql as $$
begin
  if tg_op = 'DELETE' then
    raise exception 'dormant cases are never deleted';
  end if;
  if old.state in ('remitted','resolved') then
    raise exception 'a finished dormant case is immutable';
  end if;
  if new.state is distinct from old.state then
    if not ( (old.state = 'open' and new.state in ('contact_in_progress','resolved','remitted'))
          or (old.state = 'contact_in_progress' and new.state in ('remitted','resolved')) ) then
      raise exception 'illegal dormant-case transition % -> %', old.state, new.state;
    end if;
  end if;
  return new;
end $$;
create trigger dormant_case_guard before update or delete on deedbox.dormant_case
for each row execute function deedbox.dormant_case_guard();

alter table deedbox.money_payment
  add constraint money_payment_dormant_case_fk
  foreign key (dormant_case) references deedbox.dormant_case(id);

create table deedbox.contact_attempt (
    id bigint generated always as identity primary key,
    "case" bigint not null references deedbox.dormant_case(id),
    attempted_at timestamptz not null default now(),
    channel text not null,
    evidence text not null,
    outbound_message bigint
);
create index contact_attempt_case_idx on deedbox.contact_attempt ("case");
grant select, insert on deedbox.contact_attempt to deedbox_app;
create trigger contact_attempt_append_only before update or delete on deedbox.contact_attempt
for each row execute function deedbox.append_only_guard();

create table deedbox.remittance_register (
    id bigint generated always as identity primary key,
    "case" bigint not null references deedbox.dormant_case(id),
    authority text not null,
    amount numeric(14,2) not null,
    remitted_date date not null,
    transaction bigint not null unique references deedbox.money_transaction(id),
    documentation text not null,
    created_at timestamptz not null default now()
);
create index remittance_register_date_idx on deedbox.remittance_register (remitted_date);
grant select, insert on deedbox.remittance_register to deedbox_app;
create trigger remittance_register_append_only before update or delete on deedbox.remittance_register
for each row execute function deedbox.append_only_guard();

------------------------------------------------------------------------------
-- Client money statements.
------------------------------------------------------------------------------
create table deedbox.client_money_statement (
    id bigint generated always as identity primary key,
    matter_ledger bigint not null references deedbox.matter_ledger(id),
    trigger_kind text not null check (trigger_kind in ('periodic','annual_run','matter_completion','on_request')),
    statement_number text not null unique,
    period_start date not null,
    period_end date not null,
    generated_at timestamptz not null default now(),
    issued_at timestamptz,
    issue_channel text check (issue_channel in ('email','print','portal')),
    artefact text not null,
    outbound_message bigint,
    check ((issued_at is not null) = (issue_channel is not null))
);
create index client_money_statement_ledger_idx on deedbox.client_money_statement (matter_ledger);
create index client_money_statement_run_idx on deedbox.client_money_statement (trigger_kind, period_end);
grant select, insert, update on deedbox.client_money_statement to deedbox_app;

create or replace function deedbox.client_money_statement_guard() returns trigger
language plpgsql as $$
begin
  if tg_op = 'DELETE' then
    raise exception 'statements are never deleted';
  end if;
  if old.issued_at is not null then
    raise exception 'an issued statement is immutable';
  end if;
  if new.issued_at is null
     or new.matter_ledger is distinct from old.matter_ledger
     or new.statement_number is distinct from old.statement_number
     or new.period_start is distinct from old.period_start
     or new.period_end is distinct from old.period_end
     or new.artefact is distinct from old.artefact then
    raise exception 'a statement admits exactly one mutation: its issue';
  end if;
  return new;
end $$;
create trigger client_money_statement_guard before update or delete on deedbox.client_money_statement
for each row execute function deedbox.client_money_statement_guard();

------------------------------------------------------------------------------
-- Statutory registers, pack-declared, densely numbered.
------------------------------------------------------------------------------
create table deedbox.statutory_register (
    id bigint generated always as identity primary key,
    pack_version bigint not null references deedbox.pack_version(id),
    register_key text not null,
    name text not null,
    created_at timestamptz not null default now(),
    unique (pack_version, register_key)
);
grant select, insert on deedbox.statutory_register to deedbox_app;

create table deedbox.statutory_register_entry (
    id bigint generated always as identity primary key,
    register bigint not null references deedbox.statutory_register(id),
    entry_no int not null,
    printable_artefact text,
    created_at timestamptz not null default now(),
    unique (register, entry_no)
);
grant select, insert on deedbox.statutory_register_entry to deedbox_app;
create trigger statutory_register_entry_append_only before update or delete on deedbox.statutory_register_entry
for each row execute function deedbox.append_only_guard();

create or replace function deedbox.statutory_register_entry_number() returns trigger
language plpgsql as $$
begin
  new.entry_no := coalesce(
    (select max(e.entry_no) from deedbox.statutory_register_entry e where e.register = new.register), 0) + 1;
  return new;
end $$;
create trigger a_statutory_register_entry_number before insert on deedbox.statutory_register_entry
for each row execute function deedbox.statutory_register_entry_number();

------------------------------------------------------------------------------
-- Examination pack exports — a privileged registered export.
------------------------------------------------------------------------------
create table deedbox.examination_pack_export (
    id bigint generated always as identity primary key,
    period jsonb not null,
    exported_by_kind text not null check (exported_by_kind in ('staff','examiner')),
    exported_by bigint not null,
    exported_at timestamptz not null default now(),
    artefact text not null
);
grant select, insert on deedbox.examination_pack_export to deedbox_app;
create trigger examination_pack_export_append_only before update or delete on deedbox.examination_pack_export
for each row execute function deedbox.append_only_guard();

------------------------------------------------------------------------------
-- Final guard clauses: the ledger close gains dormancy; account deactivation
-- gains its full set.
------------------------------------------------------------------------------
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
    if exists (select 1 from deedbox.earmark e
                where e.matter_ledger = new.id and e.state = 'active') then
      raise exception 'a ledger closes only with no active earmark';
    end if;
    if exists (select 1 from deedbox.instrument i
                join deedbox.ledger_line l on l.transaction = i.transaction
               where l.matter_ledger = new.id
                 and i.state not in ('presented','replaced','cleared','dishonoured','cancelled')) then
      raise exception 'a ledger closes only when its instruments rest in terminal-good states';
    end if;
    if exists (select 1 from deedbox.dormant_case d
                where d.matter_ledger = new.id and d.state in ('open','contact_in_progress')) then
      raise exception 'an open dormant case blocks the ledger''s close';
    end if;
    if new.closing_copy is null then
      raise exception 'the permanent closing copy is stored before the status flips';
    end if;
    new.closed_at := coalesce(new.closed_at, now());
  end if;
  if new.status = 'open' and old.status = 'closed' then
    new.reopened_count := old.reopened_count + 1;
    new.closed_at := null;
  end if;
  return new;
end $$;

create or replace function deedbox.client_account_guard() returns trigger
language plpgsql as $$
declare book numeric; last_post date;
begin
  if tg_op = 'DELETE' then
    raise exception 'accounts are never deleted';
  end if;
  if new.account_kind is distinct from old.account_kind
     or new.linked_matter is distinct from old.linked_matter then
    raise exception 'an account''s kind and linkage are immutable';
  end if;
  if not old.active then
    raise exception 'a deactivated account is immutable';
  end if;
  if not new.active then
    select coalesce(sum(l.signed_amount), 0) into book
      from deedbox.ledger_line l where l.account = new.id and l.side = 'cash_book';
    if book <> 0 then
      raise exception 'deactivation needs a zero cash-book balance (found %)', book;
    end if;
    if exists (select 1 from deedbox.matter_ledger ml
                where ml.account = new.id and ml.status <> 'closed') then
      raise exception 'deactivation needs every ledger closed';
    end if;
    select max(t.effective_date) into last_post
      from deedbox.ledger_line l join deedbox.money_transaction t on t.id = l.transaction
     where l.account = new.id;
    if last_post is not null and not exists (
        select 1 from deedbox.reconciliation r
         where r.account = new.id and r.status = 'certified'
           and r.statement_date >= last_post and r.statement_balance = 0) then
      raise exception 'deactivation needs a certified reconciliation at the final position';
    end if;
    new.deactivated_at := coalesce(new.deactivated_at, now());
  end if;
  return new;
end $$;
create trigger client_account_guard before update or delete on deedbox.client_account
for each row execute function deedbox.client_account_guard();

commit;
