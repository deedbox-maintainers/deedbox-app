-- 0013_money_documents — the documents and reservations over the spine:
-- receipts, payments out with the domain's one rich state machine,
-- documented transfers, earmarks with the shared available definition and
-- the dishonour auto-release, the entitlement chain that alone permits
-- moving client money to the firm, and instruments. The ledger-close guard
-- gains its earmark and instrument clauses. The operations' register
-- emission, artefact generation and job scheduling are app-layer.
--
-- Implementation notes:
--   * money_payment.dormant_case is a bare column until dormant_case lands
--     in 0014.
--   * The earmark-coverage rule (Σ active earmarks ≤ balance) is enforced
--     at placement AND at every ledger movement: a staff-requested
--     movement that would leave the balance under the active earmarks is
--     refused; under a system-job principal (the dishonour path) excess
--     earmarks auto-release newest-first in the same transaction — the
--     operation registers the release with the dishonour evidence.
--   * Entitlement consumption is derived (Σ executed firm-transfer
--     payments naming it), never stored; the payment-execution guard
--     enforces actionability and headroom.
--   * Instrument state changes are guarded transitions; the reconciliation
--     -driven ones (presented/cleared) arrive with 0014's certification
--     but their legality is already encoded here.

begin;

------------------------------------------------------------------------------
-- earmark — a reservation within a ledger; available = balance − active.
------------------------------------------------------------------------------
create table deedbox.earmark (
    id bigint generated always as identity primary key,
    matter_ledger bigint not null references deedbox.matter_ledger(id),
    amount numeric(14,2) not null check (amount > 0),
    purpose text not null check (purpose <> ''),
    placed_by bigint not null references deedbox.staff_member(id),
    placed_at timestamptz not null default now(),
    state text not null default 'active' check (state in ('active','released','consumed')),
    released_by bigint references deedbox.staff_member(id),
    released_at timestamptz,
    consumed_by_payment bigint     -- FK added below (circular with money_payment)
);
create index earmark_ledger_state_idx on deedbox.earmark (matter_ledger, state);
grant select, insert, update on deedbox.earmark to deedbox_app;

create or replace function deedbox.ledger_active_earmarks(p_ledger bigint) returns numeric
language sql stable as $$
  select coalesce(sum(e.amount), 0) from deedbox.earmark e
   where e.matter_ledger = p_ledger and e.state = 'active';
$$;

create or replace function deedbox.ledger_available(p_ledger bigint) returns numeric
language sql stable as $$
  select deedbox.ledger_balance(p_ledger) - deedbox.ledger_active_earmarks(p_ledger);
$$;

create or replace function deedbox.earmark_guard() returns trigger
language plpgsql as $$
begin
  if tg_op = 'DELETE' then
    raise exception 'earmarks are released or consumed, never deleted';
  end if;
  if tg_op = 'INSERT' then
    if new.state <> 'active' then
      raise exception 'an earmark is born active';
    end if;
    if deedbox.ledger_active_earmarks(new.matter_ledger) + new.amount
       > deedbox.ledger_balance(new.matter_ledger) then
      raise exception 'refused: active earmarks would exceed the ledger balance';
    end if;
    return new;
  end if;
  if old.state <> 'active' then
    raise exception 'a released or consumed earmark is immutable';
  end if;
  if new.matter_ledger is distinct from old.matter_ledger
     or new.amount is distinct from old.amount
     or new.purpose is distinct from old.purpose
     or new.placed_by is distinct from old.placed_by
     or new.placed_at is distinct from old.placed_at then
    raise exception 'an earmark admits only its release or consumption';
  end if;
  if new.state = 'released' and (new.released_by is null or new.released_at is null) then
    raise exception 'a release records who and when';
  end if;
  if new.state = 'consumed' and new.consumed_by_payment is null then
    raise exception 'consumption names the executing payment';
  end if;
  if new.state = 'active' then
    raise exception 'an earmark admits only its release or consumption';
  end if;
  return new;
end $$;
create trigger earmark_guard before insert or update or delete on deedbox.earmark
for each row execute function deedbox.earmark_guard();

-- The movement-side coverage rule: staff movements never leave the balance
-- under the active earmarks; the system dishonour path auto-releases the
-- excess, newest first.
create or replace function deedbox.z_assert_earmark_cover() returns trigger
language plpgsql as $$
declare bal numeric; marked numeric; e record;
begin
  if new.matter_ledger is null or new.signed_amount >= 0 then
    return null;
  end if;
  marked := deedbox.ledger_active_earmarks(new.matter_ledger);
  if marked = 0 then
    return null;   -- nothing reserved (contra ledgers live below zero; no cover rule)
  end if;
  bal := deedbox.ledger_balance(new.matter_ledger);
  if marked <= bal then
    return null;
  end if;
  if coalesce(current_setting('deedbox.principal_kind', true), '') = 'system_job' then
    for e in select * from deedbox.earmark em
              where em.matter_ledger = new.matter_ledger and em.state = 'active'
              order by em.placed_at desc, em.id desc loop
      exit when marked <= bal;
      update deedbox.earmark set state='released', released_by = e.placed_by, released_at = now()
       where id = e.id;
      marked := marked - e.amount;
    end loop;
    return null;
  end if;
  raise exception 'refused: earmark shortfall — the movement would leave balance under the active earmarks';
end $$;
create trigger z_assert_earmark_cover after insert on deedbox.ledger_line
for each row execute function deedbox.z_assert_earmark_cover();

------------------------------------------------------------------------------
-- money_receipt — the document behind a receipt; cancellation derived.
------------------------------------------------------------------------------
create table deedbox.money_receipt (
    id bigint generated always as identity primary key,
    matter_ledger bigint not null references deedbox.matter_ledger(id),
    receipt_number text not null unique,
    payer_party bigint references deedbox.party(id),
    payer_description text,
    method text not null,
    received_date date not null,
    amount numeric(14,2) not null check (amount > 0),
    transaction bigint not null unique references deedbox.money_transaction(id),
    instrument bigint,             -- FK added below (circular with instrument)
    top_up_request bigint references deedbox.top_up_request(id),
    channel_payment bigint references deedbox.channel_payment(id),
    printable_artefact text not null,
    created_at timestamptz not null default now(),
    check (payer_party is not null or payer_description is not null)
);
create index money_receipt_ledger_idx on deedbox.money_receipt (matter_ledger);
create index money_receipt_method_date_idx on deedbox.money_receipt (method, received_date);
grant select, insert on deedbox.money_receipt to deedbox_app;
create trigger money_receipt_append_only before update or delete on deedbox.money_receipt
for each row execute function deedbox.append_only_guard();

create or replace function deedbox.receipt_cancelled(p_receipt bigint) returns boolean
language sql stable as $$
  select exists (
    select 1 from deedbox.money_receipt r
    join deedbox.money_transaction rv on rv.reverses = r.transaction
    where r.id = p_receipt);
$$;

------------------------------------------------------------------------------
-- entitlement — the chain that alone moves client money to the firm.
------------------------------------------------------------------------------
create table deedbox.entitlement (
    id bigint generated always as identity primary key,
    matter_ledger bigint not null references deedbox.matter_ledger(id),
    basis_kind text not null check (basis_kind in ('rendered_bill','pack_defined')),
    bill bigint references deedbox.bill(id),
    pack_basis text,
    pack_basis_evidence jsonb,
    amount numeric(14,2) not null check (amount > 0),
    established_at timestamptz not null default now(),
    notice_required boolean not null,
    notice_given_at timestamptz,
    notice_event_type text,
    notice_event bigint,
    actionable_from timestamptz,
    cancelled_at timestamptz,
    cancelled_by bigint references deedbox.staff_member(id),
    created_at timestamptz not null default now(),
    check ((basis_kind = 'rendered_bill') = (bill is not null)),
    check ((basis_kind = 'pack_defined') = (pack_basis is not null)),
    check ((notice_given_at is not null) <= (notice_event_type is not null and notice_event is not null)),
    check ((cancelled_at is null) = (cancelled_by is null))
);
create index entitlement_ledger_idx on deedbox.entitlement (matter_ledger) where cancelled_at is null;
create index entitlement_bill_idx on deedbox.entitlement (bill);
grant select, insert, update on deedbox.entitlement to deedbox_app;

-- (deedbox.entitlement_consumed is defined after money_payment below —
-- SQL-language functions validate at creation; entitlement_status and the
-- guards call it at runtime only.)

create or replace function deedbox.entitlement_status(p_ent bigint) returns text
language plpgsql stable as $$
declare e deedbox.entitlement%rowtype;
begin
  select * into e from deedbox.entitlement where id = p_ent;
  if e.cancelled_at is not null then return 'cancelled'; end if;
  if e.notice_required and (e.actionable_from is null or e.actionable_from > now()) then
    return 'awaiting_notice';
  end if;
  if deedbox.entitlement_consumed(p_ent) >= e.amount then return 'exhausted'; end if;
  return 'actionable';
end $$;

create or replace function deedbox.entitlement_guard() returns trigger
language plpgsql as $$
declare b deedbox.bill%rowtype; led deedbox.matter_ledger%rowtype;
begin
  if tg_op = 'DELETE' then
    raise exception 'entitlements are cancelled, never deleted';
  end if;
  if tg_op = 'INSERT' then
    select * into led from deedbox.matter_ledger ml where ml.id = new.matter_ledger;
    if led.ledger_kind <> 'client_matter' then
      raise exception 'entitlements attach to client-matter ledgers only';
    end if;
    if new.basis_kind = 'rendered_bill' then
      select * into b from deedbox.bill where id = new.bill;
      if b.state <> 'issued' or b.rendered_artefact is null then
        raise exception 'an entitlement rests on an ISSUED, rendered bill';
      end if;
      if b.matter is distinct from led.matter then
        raise exception 'the entitlement''s bill must belong to the ledger''s matter';
      end if;
      if new.amount > deedbox.bill_outstanding(new.bill) then
        raise exception 'an entitlement never exceeds the bill''s outstanding at establishment';
      end if;
    end if;
    if not new.notice_required and new.actionable_from is null then
      new.actionable_from := new.established_at;
    end if;
    if new.cancelled_at is not null then
      raise exception 'an entitlement is not born cancelled';
    end if;
    return new;
  end if;
  -- UPDATE: the notice event (once) and the cancellation (once, unconsumed).
  if old.cancelled_at is not null then
    raise exception 'a cancelled entitlement is immutable';
  end if;
  if new.matter_ledger is distinct from old.matter_ledger
     or new.basis_kind is distinct from old.basis_kind
     or new.bill is distinct from old.bill
     or new.pack_basis is distinct from old.pack_basis
     or new.amount is distinct from old.amount
     or new.established_at is distinct from old.established_at
     or new.notice_required is distinct from old.notice_required then
    raise exception 'an entitlement''s substance is immutable';
  end if;
  if new.notice_given_at is distinct from old.notice_given_at then
    if old.notice_given_at is not null then
      raise exception 'notice is recorded once';
    end if;
  end if;
  if new.cancelled_at is not null then
    if deedbox.entitlement_consumed(new.id) <> 0 then
      raise exception 'a consumed entitlement can no longer be cancelled';
    end if;
  end if;
  return new;
end $$;
create trigger entitlement_guard before insert or update or delete on deedbox.entitlement
for each row execute function deedbox.entitlement_guard();

------------------------------------------------------------------------------
-- money_payment — the one rich state machine.
------------------------------------------------------------------------------
create table deedbox.money_payment (
    id bigint generated always as identity primary key,
    matter_ledger bigint not null references deedbox.matter_ledger(id),
    payee_party bigint references deedbox.party(id),
    payee_description text,
    method text not null,
    amount numeric(14,2) not null check (amount > 0),
    reason text not null check (reason <> ''),
    requested_by bigint not null references deedbox.staff_member(id),
    state text not null default 'draft' check (state in
      ('draft','pending_authorisation','authorised','executed','rejected','cancelled','blocked')),
    required_authorisations int,
    earmark bigint references deedbox.earmark(id),
    entitlement bigint references deedbox.entitlement(id),
    purpose text not null default 'general'
      check (purpose in ('general','firm_transfer','remittance','cross_account_transfer')),
    dormant_case bigint,           -- FK lands with the dormant_case table in 0014
    transaction bigint unique references deedbox.money_transaction(id),
    instrument bigint,             -- FK added below
    payment_number text unique,
    submitted_at timestamptz, decided_at timestamptz, executed_at timestamptz,
    blocked_at timestamptz, cancelled_at timestamptz,
    rejection_reason text,
    created_at timestamptz not null default now(),
    check (payee_party is not null or payee_description is not null),
    check ((purpose = 'firm_transfer') <= (entitlement is not null)),
    check (state <> 'executed' or (transaction is not null and payment_number is not null and executed_at is not null)),
    check (state <> 'rejected' or rejection_reason is not null),
    check (state not in ('pending_authorisation','authorised','executed') or required_authorisations is not null)
);
create index money_payment_state_idx on deedbox.money_payment (state);
create index money_payment_ledger_idx on deedbox.money_payment (matter_ledger);
create index money_payment_entitlement_idx on deedbox.money_payment (entitlement);
grant select, insert, update on deedbox.money_payment to deedbox_app;

alter table deedbox.earmark
  add constraint earmark_consumed_by_payment_fk
  foreign key (consumed_by_payment) references deedbox.money_payment(id);

create or replace function deedbox.entitlement_consumed(p_ent bigint) returns numeric
language sql stable as $$
  select coalesce(sum(p.amount), 0) from deedbox.money_payment p
   where p.entitlement = p_ent and p.state = 'executed';
$$;

create or replace function deedbox.money_payment_guard() returns trigger
language plpgsql as $$
declare approvals int; ent_status text; headroom numeric; em deedbox.earmark%rowtype;
begin
  if tg_op = 'DELETE' then
    raise exception 'payment documents are never deleted';
  end if;
  if tg_op = 'INSERT' then
    if new.state <> 'draft' then
      raise exception 'a payment is born draft';
    end if;
    return new;
  end if;
  if old.state in ('executed','rejected','cancelled') then
    raise exception 'a finished payment document is immutable';
  end if;
  if new.state is distinct from old.state then
    if not ( (old.state = 'draft' and new.state in ('pending_authorisation','cancelled'))
          or (old.state = 'pending_authorisation' and new.state in ('authorised','rejected','cancelled'))
          or (old.state = 'authorised' and new.state in ('executed','blocked'))
          or (old.state = 'blocked' and new.state in ('authorised','cancelled')) ) then
      raise exception 'illegal payment transition % -> %', old.state, new.state;
    end if;
    if new.state = 'pending_authorisation' then
      if new.required_authorisations is null or new.required_authorisations < 1 then
        raise exception 'submission freezes the required approvals count';
      end if;
      new.submitted_at := coalesce(new.submitted_at, now());
    end if;
    if new.state = 'authorised' and old.state = 'pending_authorisation' then
      select count(*) into approvals from deedbox.payment_authorisation a
       where a.subject_type = 'money_payment' and a.subject = new.id and a.decision = 'approved';
      if approvals < new.required_authorisations then
        raise exception 'authorisation needs % approvals; % recorded', new.required_authorisations, approvals;
      end if;
      new.decided_at := coalesce(new.decided_at, now());
    end if;
    if new.state = 'executed' then
      if new.earmark is not null then
        select * into em from deedbox.earmark e where e.id = new.earmark;
        if em.matter_ledger is distinct from new.matter_ledger then
          raise exception 'a payment consumes an earmark of its own ledger only';
        end if;
      end if;
      if new.purpose = 'firm_transfer' then
        ent_status := deedbox.entitlement_status(new.entitlement);
        if ent_status <> 'actionable' then
          raise exception 'a firm transfer executes only on an actionable entitlement (found %)', ent_status;
        end if;
        select e.amount - deedbox.entitlement_consumed(e.id) into headroom
          from deedbox.entitlement e where e.id = new.entitlement;
        if new.amount > headroom then
          raise exception 'the firm transfer exceeds the entitlement''s remaining headroom (%)', headroom;
        end if;
      end if;
      new.executed_at := coalesce(new.executed_at, now());
    end if;
    if new.state = 'blocked' then
      new.blocked_at := coalesce(new.blocked_at, now());
    end if;
    if new.state = 'cancelled' then
      new.cancelled_at := coalesce(new.cancelled_at, now());
    end if;
    if old.state = 'blocked' and new.state = 'authorised' then
      if new.amount is distinct from old.amount or new.payee_party is distinct from old.payee_party
         or new.payee_description is distinct from old.payee_description then
        raise exception 'a change of amount or payee forces a fresh draft';
      end if;
    end if;
  elsif old.state <> 'draft' then
    -- non-transition edits are draft-only; submitted documents are frozen.
    if new.amount is distinct from old.amount
       or new.payee_party is distinct from old.payee_party
       or new.payee_description is distinct from old.payee_description
       or new.method is distinct from old.method
       or new.matter_ledger is distinct from old.matter_ledger
       or new.purpose is distinct from old.purpose
       or new.entitlement is distinct from old.entitlement
       or new.earmark is distinct from old.earmark then
      raise exception 'a submitted payment''s substance is frozen; cancel and redraft';
    end if;
  end if;
  return new;
end $$;
create trigger money_payment_guard before insert or update or delete on deedbox.money_payment
for each row execute function deedbox.money_payment_guard();

-- consuming an earmark at execution, transactionally.
create or replace function deedbox.money_payment_consume_earmark() returns trigger
language plpgsql as $$
declare em deedbox.earmark%rowtype;
begin
  if new.earmark is null then return null; end if;
  select * into em from deedbox.earmark e where e.id = new.earmark;
  if em.state <> 'active' then return null; end if;
  update deedbox.earmark set state='consumed', consumed_by_payment = new.id where id = em.id;
  if new.amount < em.amount then
    insert into deedbox.earmark (matter_ledger, amount, purpose, placed_by)
    values (em.matter_ledger, em.amount - new.amount, em.purpose, em.placed_by);
  end if;
  return null;
end $$;
create trigger money_payment_consume_earmark after update on deedbox.money_payment
for each row when (new.state = 'executed' and old.state is distinct from new.state)
execute function deedbox.money_payment_consume_earmark();

------------------------------------------------------------------------------
-- documented transfers — one unbroken number series.
------------------------------------------------------------------------------
create table deedbox.ledger_transfer (
    id bigint generated always as identity primary key,
    from_ledger bigint not null references deedbox.matter_ledger(id),
    to_ledger bigint not null references deedbox.matter_ledger(id),
    amount numeric(14,2) not null check (amount > 0),
    reason text not null check (reason <> ''),
    authorisation bigint not null references deedbox.payment_authorisation(id),
    transfer_number text not null unique,
    transaction bigint not null unique references deedbox.money_transaction(id),
    created_at timestamptz not null default now(),
    check (from_ledger <> to_ledger)
);
create index ledger_transfer_from_idx on deedbox.ledger_transfer (from_ledger);
create index ledger_transfer_to_idx on deedbox.ledger_transfer (to_ledger);
grant select, insert on deedbox.ledger_transfer to deedbox_app;
create trigger ledger_transfer_append_only before update or delete on deedbox.ledger_transfer
for each row execute function deedbox.append_only_guard();

create or replace function deedbox.ledger_transfer_doc_guard() returns trigger
language plpgsql as $$
declare fl deedbox.matter_ledger%rowtype; tl deedbox.matter_ledger%rowtype;
begin
  select * into fl from deedbox.matter_ledger where id = new.from_ledger;
  select * into tl from deedbox.matter_ledger where id = new.to_ledger;
  if fl.account <> tl.account then
    raise exception 'a ledger transfer stays within one account (use a cross-account transfer)';
  end if;
  if fl.ledger_kind <> 'client_matter' or tl.ledger_kind <> 'client_matter' then
    raise exception 'ledger transfers move between client-matter ledgers';
  end if;
  return new;
end $$;
create trigger ledger_transfer_doc_guard before insert on deedbox.ledger_transfer
for each row execute function deedbox.ledger_transfer_doc_guard();

create table deedbox.cross_account_transfer (
    id bigint generated always as identity primary key,
    reason text not null check (reason <> ''),
    authorisation bigint not null references deedbox.payment_authorisation(id),
    payment bigint not null unique references deedbox.money_payment(id),
    receipt bigint not null unique references deedbox.money_receipt(id),
    transfer_number text not null unique,
    created_at timestamptz not null default now()
);
grant select, insert on deedbox.cross_account_transfer to deedbox_app;
create trigger cross_account_transfer_append_only before update or delete on deedbox.cross_account_transfer
for each row execute function deedbox.append_only_guard();

------------------------------------------------------------------------------
-- instrument — cheques and equivalents, both directions.
------------------------------------------------------------------------------
create table deedbox.instrument (
    id bigint generated always as identity primary key,
    account bigint not null references deedbox.client_account(id),
    direction text not null check (direction in ('outbound','inbound')),
    instrument_kind text not null,
    number text not null,
    amount numeric(14,2) not null check (amount > 0),
    state text not null,
    state_changed_at timestamptz not null default now(),
    stale_after date not null,
    replaces bigint unique references deedbox.instrument(id),
    replaced_by bigint unique references deedbox.instrument(id),
    source_type text not null,
    source bigint not null,
    transaction bigint not null references deedbox.money_transaction(id),
    dishonour_reversal bigint references deedbox.money_transaction(id),
    cancellation_reversal bigint references deedbox.money_transaction(id),
    created_at timestamptz not null default now(),
    unique (account, direction, number),
    check ((direction = 'outbound' and state in ('created','presented','stale','cancelled','replaced'))
        or (direction = 'inbound' and state in ('received','banked','cleared','dishonoured')))
);
create index instrument_account_state_idx on deedbox.instrument (account, state);
create index instrument_stale_idx on deedbox.instrument (stale_after) where state = 'created';
grant select, insert, update on deedbox.instrument to deedbox_app;

create or replace function deedbox.instrument_guard() returns trigger
language plpgsql as $$
begin
  if tg_op = 'DELETE' then
    raise exception 'instrument rows and their numbers are retained forever';
  end if;
  if tg_op = 'INSERT' then
    if new.direction = 'outbound' and new.state <> 'created' then
      raise exception 'an outbound instrument is born created';
    end if;
    if new.direction = 'inbound' and new.state <> 'received' then
      raise exception 'an inbound instrument is born received';
    end if;
    return new;
  end if;
  if new.account is distinct from old.account
     or new.direction is distinct from old.direction
     or new.number is distinct from old.number
     or new.amount is distinct from old.amount
     or new.transaction is distinct from old.transaction then
    raise exception 'an instrument''s identity is immutable';
  end if;
  if new.state is distinct from old.state then
    if old.direction = 'outbound' then
      if not ( (old.state = 'created' and new.state in ('presented','stale','cancelled'))
            or (old.state = 'stale' and new.state in ('presented','cancelled'))
            or (old.state = 'cancelled' and new.state = 'replaced') ) then
        raise exception 'illegal outbound instrument transition % -> %', old.state, new.state;
      end if;
      if new.state = 'cancelled' and new.cancellation_reversal is null then
        raise exception 'cancellation posts its reversal in the same transaction';
      end if;
      if new.state = 'replaced' and new.replaced_by is null then
        raise exception 'replacement links the new instrument';
      end if;
    else
      if not ( (old.state = 'received' and new.state = 'banked')
            or (old.state = 'banked' and new.state in ('cleared','dishonoured')) ) then
        raise exception 'illegal inbound instrument transition % -> %', old.state, new.state;
      end if;
      if new.state = 'dishonoured' and new.dishonour_reversal is null then
        raise exception 'a dishonour posts its system reversal in the same transaction';
      end if;
    end if;
    new.state_changed_at := now();
  elsif old.state in ('presented','replaced','cleared','dishonoured') then
    raise exception 'a terminal instrument is immutable';
  end if;
  return new;
end $$;
create trigger instrument_guard before insert or update or delete on deedbox.instrument
for each row execute function deedbox.instrument_guard();

alter table deedbox.money_receipt
  add constraint money_receipt_instrument_fk foreign key (instrument) references deedbox.instrument(id);
alter table deedbox.money_payment
  add constraint money_payment_instrument_fk foreign key (instrument) references deedbox.instrument(id);

------------------------------------------------------------------------------
-- The ledger-close guard gains its earmark and instrument clauses (0014
-- adds dormancy and account-deactivation reconciliation clauses).
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

commit;
