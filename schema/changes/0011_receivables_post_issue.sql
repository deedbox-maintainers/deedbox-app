-- 0011_receivables_post_issue — everything that happens to an issued bill:
-- disputes, credit notes, write-offs, payments received on the firm's own
-- side, billed and collected attribution, payment references, channel
-- payments, interest policies and charges, statements, payment arrangements
-- with instalments, reminder sequences and per-bill reminder state, top-up
-- requests, and the held-funds application record layer. Implements: the
-- row-level mechanics only; the jobs, renderings, outbound messages and the
-- client-money bridge writes are app-layer, later stages.
--
-- Implementation notes:
--   * Interest-period non-overlap per bill is an EXCLUSION constraint
--     (btree_gist) — structural, not lock-discipline-dependent.
--   * reminder_step.template, reminder_contact.outbound_message/task, and
--     funds_application's client-money refs (matter_ledger, entitlement,
--     money_payment) are bare columns until their owning domains land
--     (configuration templates, workflow tasks, the money stage) — same
--     pattern as earlier slices.
--   * The credit-cap rule (Σ applications naming a note ≤ its amount) and
--     the payment-allocation cap (0 ≤ Σ allocations ≤ payment amount, and
--     no allocating a cancelled payment) are constraint triggers on the
--     journal, keyed by source_type — the journal is where those writes
--     land, so the rule lives with the write.
--   * "At most one active/broken arrangement covering a bill" is enforced
--     on the covering row (arrangement_bill) at insert against the
--     arrangement's current state; state flips back to active re-check
--     coverage.
--   * Reminder-state transition legality is enforced broadly here;
--     the resume rule's timing arithmetic is the scheduler's (app layer).

begin;

create extension if not exists btree_gist with schema extensions;

------------------------------------------------------------------------------
-- bill_dispute — a record, never a bill state.
------------------------------------------------------------------------------
create table deedbox.bill_dispute (
    id bigint generated always as identity primary key,
    bill bigint not null references deedbox.bill(id),
    raised_by bigint not null references deedbox.staff_member(id),
    raised_at timestamptz not null default now(),
    detail text not null check (detail <> ''),
    resolved_at timestamptz,
    resolution_note text,
    check ((resolved_at is not null) <= (resolution_note is not null))
);
create unique index bill_dispute_one_open on deedbox.bill_dispute (bill) where resolved_at is null;
grant select, insert, update on deedbox.bill_dispute to deedbox_app;

create or replace function deedbox.bill_dispute_guard() returns trigger
language plpgsql as $$
begin
  if tg_op = 'DELETE' then
    raise exception 'dispute records persist forever';
  end if;
  if old.resolved_at is not null then
    raise exception 'a resolved dispute is immutable';
  end if;
  if new.bill is distinct from old.bill
     or new.raised_by is distinct from old.raised_by
     or new.raised_at is distinct from old.raised_at
     or new.detail is distinct from old.detail then
    raise exception 'a dispute admits exactly one mutation: its resolution';
  end if;
  if new.resolved_at is null then
    raise exception 'a dispute admits exactly one mutation: its resolution';
  end if;
  return new;
end $$;
create trigger bill_dispute_guard before update or delete on deedbox.bill_dispute
for each row execute function deedbox.bill_dispute_guard();

------------------------------------------------------------------------------
-- Credit notes and write-offs — permanent records.
------------------------------------------------------------------------------
create table deedbox.credit_note (
    id bigint generated always as identity primary key,
    credit_number text not null unique,
    bill bigint not null references deedbox.bill(id),
    amount numeric(14,2) not null check (amount > 0),
    reason text not null check (reason <> ''),
    issued_by bigint not null references deedbox.staff_member(id),
    issued_at timestamptz not null default now(),
    rendered_artefact text not null
);
create index credit_note_bill_idx on deedbox.credit_note (bill);
grant select, insert on deedbox.credit_note to deedbox_app;
create trigger credit_note_append_only before update or delete on deedbox.credit_note
for each row execute function deedbox.append_only_guard();

create table deedbox.write_off (
    id bigint generated always as identity primary key,
    bill bigint not null references deedbox.bill(id),
    amount numeric(14,2) not null check (amount > 0),
    reason text not null check (reason <> ''),
    authorised_by bigint not null references deedbox.staff_member(id),
    authorised_at timestamptz not null default now()
);
create index write_off_bill_idx on deedbox.write_off (bill);
grant select, insert on deedbox.write_off to deedbox_app;
create trigger write_off_append_only before update or delete on deedbox.write_off
for each row execute function deedbox.append_only_guard();

------------------------------------------------------------------------------
-- payment_reference — opaque codes; deactivation is the one transition.
------------------------------------------------------------------------------
create table deedbox.payment_reference (
    id bigint generated always as identity primary key,
    code text not null unique,
    target_kind text not null check (target_kind in ('bill','statement','top_up_request','instalment')),
    target bigint not null,
    expected_amount numeric(14,2),
    active boolean not null default true,
    created_at timestamptz not null default now()
);
create index payment_reference_target_idx on deedbox.payment_reference (target_kind, target);
grant select, insert, update on deedbox.payment_reference to deedbox_app;

create or replace function deedbox.payment_reference_guard() returns trigger
language plpgsql as $$
begin
  if tg_op = 'DELETE' then
    raise exception 'payment references are never deleted';
  end if;
  if not old.active then
    raise exception 'a deactivated payment reference is immutable';
  end if;
  if new.active
     or new.code is distinct from old.code
     or new.target_kind is distinct from old.target_kind
     or new.target is distinct from old.target
     or new.expected_amount is distinct from old.expected_amount then
    raise exception 'a payment reference admits exactly one mutation: its deactivation';
  end if;
  return new;
end $$;
create trigger payment_reference_guard before update or delete on deedbox.payment_reference
for each row execute function deedbox.payment_reference_guard();

------------------------------------------------------------------------------
-- channel_payment — strictly forward, idempotent by channel event.
------------------------------------------------------------------------------
create table deedbox.channel_payment (
    id bigint generated always as identity primary key,
    payment_reference bigint not null references deedbox.payment_reference(id),
    channel text not null,
    method text not null,
    amount numeric(14,2) not null check (amount > 0),
    state text not null default 'started' check (state in ('started','settled','failed')),
    state_history jsonb not null,
    surcharge_amount numeric(14,2) not null default 0 check (surcharge_amount >= 0),
    resulting_receipt_type text check (resulting_receipt_type in ('receivable_payment','money_receipt')),
    resulting_receipt bigint,
    channel_event_ref text not null,
    created_at timestamptz not null default now(),
    unique (channel, channel_event_ref),
    check ((state = 'settled') = (resulting_receipt_type is not null and resulting_receipt is not null))
);
create index channel_payment_ref_idx on deedbox.channel_payment (payment_reference);
create index channel_payment_pending_idx on deedbox.channel_payment (state) where state = 'started';
grant select, insert, update on deedbox.channel_payment to deedbox_app;

create or replace function deedbox.channel_payment_guard() returns trigger
language plpgsql as $$
begin
  if tg_op = 'DELETE' then
    raise exception 'channel payments are never deleted';
  end if;
  if tg_op = 'INSERT' then
    if new.state <> 'started' then
      raise exception 'a channel payment is born started';
    end if;
    return new;
  end if;
  if old.state <> 'started' then
    raise exception 'a settled or failed channel payment is immutable';
  end if;
  if new.state = 'started' then
    if new.state_history is distinct from old.state_history then
      return new;   -- event appended while still in flight
    end if;
    raise exception 'a started channel payment moves only forward (settled or failed)';
  end if;
  return new;
end $$;
create trigger channel_payment_guard before insert or update or delete on deedbox.channel_payment
for each row execute function deedbox.channel_payment_guard();

------------------------------------------------------------------------------
-- receivable_payment — money received on the firm's own side.
------------------------------------------------------------------------------
create table deedbox.receivable_payment (
    id bigint generated always as identity primary key,
    payer_party bigint references deedbox.party(id),
    received_date date not null,
    entered_at timestamptz not null default now(),
    amount numeric(14,2) not null check (amount > 0),
    method text not null,
    source text not null default 'direct' check (source in ('direct','channel','held_funds_application')),
    channel_payment bigint references deedbox.channel_payment(id),
    funds_application bigint,      -- FK lands with funds_application below (circular)
    reference text,
    receipt_number text not null unique,
    reverses bigint unique references deedbox.receivable_payment(id),
    reason text,
    check ((source = 'channel') = (channel_payment is not null)),
    check ((reverses is not null) <= (reason is not null))
);
create index receivable_payment_payer_idx on deedbox.receivable_payment (payer_party);
grant select, insert on deedbox.receivable_payment to deedbox_app;

create or replace function deedbox.receivable_payment_append_only() returns trigger
language plpgsql as $$
begin
  raise exception 'receivable payments are insert-only; corrections are mirror payments';
end $$;
create trigger receivable_payment_append_only before update or delete on deedbox.receivable_payment
for each row execute function deedbox.receivable_payment_append_only();

create or replace function deedbox.receivable_payment_cancelled(p_payment bigint) returns boolean
language sql stable as $$
  select exists (select 1 from deedbox.receivable_payment r
                  where r.id = p_payment and r.reverses is not null)
      or exists (select 1 from deedbox.receivable_payment r
                  where r.reverses = p_payment);
$$;

------------------------------------------------------------------------------
-- Journal caps: allocations never exceed their payment; credit applications
-- never exceed their note; cancelled payments never allocate.
------------------------------------------------------------------------------
create or replace function deedbox.z_assert_journal_caps() returns trigger
language plpgsql as $$
declare cap numeric; used numeric;
begin
  if new.entry_kind = 'payment_allocation' and new.source_type = 'receivable_payment' then
    if deedbox.receivable_payment_cancelled(new.source) then
      raise exception 'a cancelled payment cannot be allocated';
    end if;
    select r.amount into cap from deedbox.receivable_payment r where r.id = new.source;
    if cap is null then
      raise exception 'allocation names a payment that does not exist';
    end if;
    select coalesce(-sum(j.signed_amount), 0) into used
      from deedbox.bill_journal_entry j
     where j.entry_kind = 'payment_allocation'
       and j.source_type = 'receivable_payment' and j.source = new.source
       and not exists (select 1 from deedbox.bill_journal_entry rv where rv.reverses = j.id);
    if used > cap then
      raise exception 'allocations against payment % would exceed its amount (% > %)', new.source, used, cap;
    end if;
  end if;
  if new.entry_kind = 'credit_application' and new.source_type = 'credit_note' then
    select c.amount into cap from deedbox.credit_note c where c.id = new.source;
    if cap is null then
      raise exception 'credit application names a note that does not exist';
    end if;
    select coalesce(-sum(j.signed_amount), 0) into used
      from deedbox.bill_journal_entry j
     where j.entry_kind = 'credit_application'
       and j.source_type = 'credit_note' and j.source = new.source
       and not exists (select 1 from deedbox.bill_journal_entry rv where rv.reverses = j.id);
    if used > cap then
      raise exception 'applications of credit note % would exceed its amount (% > %)', new.source, used, cap;
    end if;
  end if;
  return null;
end $$;
create constraint trigger z_assert_journal_caps
after insert on deedbox.bill_journal_entry
deferrable initially immediate
for each row execute function deedbox.z_assert_journal_caps();

------------------------------------------------------------------------------
-- Billed and collected attribution.
------------------------------------------------------------------------------
create table deedbox.bill_attribution (
    id bigint generated always as identity primary key,
    bill bigint not null references deedbox.bill(id),
    staff bigint not null references deedbox.staff_member(id),
    billed_share numeric(14,2) not null,
    superseded_at timestamptz,
    created_at timestamptz not null default now()
);
create unique index bill_attribution_current_unique
  on deedbox.bill_attribution (bill, staff) where superseded_at is null;
create index bill_attribution_staff_idx on deedbox.bill_attribution (staff) where superseded_at is null;
grant select, insert, update on deedbox.bill_attribution to deedbox_app;

create or replace function deedbox.bill_attribution_guard() returns trigger
language plpgsql as $$
begin
  if tg_op = 'DELETE' then
    raise exception 'attribution history is retained; supersede instead';
  end if;
  if old.superseded_at is not null then
    raise exception 'a superseded attribution row is immutable';
  end if;
  if new.superseded_at is null
     or new.bill is distinct from old.bill
     or new.staff is distinct from old.staff
     or new.billed_share is distinct from old.billed_share then
    raise exception 'attribution rows admit exactly one mutation: supersession';
  end if;
  return new;
end $$;
create trigger bill_attribution_guard before update or delete on deedbox.bill_attribution
for each row execute function deedbox.bill_attribution_guard();

-- The current set sums to the bill's issue total (checked at commit; the
-- set is replaced whole).
create or replace function deedbox.z_assert_attribution_sum() returns trigger
language plpgsql as $$
declare b bigint; s numeric; total numeric;
begin
  b := coalesce(new.bill, old.bill);
  select sum(a.billed_share) into s from deedbox.bill_attribution a
   where a.bill = b and a.superseded_at is null;
  if s is null then
    return null;   -- no current set is legal
  end if;
  select j.signed_amount into total from deedbox.bill_journal_entry j
   where j.bill = b and j.entry_kind = 'issue_total';
  if total is null or s <> total then
    raise exception 'the current attribution set for bill % must sum to its issue total (% vs %)', b, s, total;
  end if;
  return null;
end $$;
create constraint trigger z_assert_attribution_sum
after insert or update on deedbox.bill_attribution
deferrable initially deferred
for each row execute function deedbox.z_assert_attribution_sum();

create table deedbox.collection_attribution (
    id bigint generated always as identity primary key,
    allocation_entry bigint not null references deedbox.bill_journal_entry(id),
    staff bigint not null references deedbox.staff_member(id),
    amount numeric(14,2) not null,
    created_at timestamptz not null default now()
);
create index collection_attribution_entry_idx on deedbox.collection_attribution (allocation_entry);
create index collection_attribution_staff_idx on deedbox.collection_attribution (staff);
grant select, insert on deedbox.collection_attribution to deedbox_app;
create trigger collection_attribution_append_only before update or delete on deedbox.collection_attribution
for each row execute function deedbox.append_only_guard();

-- Σ per allocation = the allocation amount exactly, at commit.
create or replace function deedbox.z_assert_collection_fan() returns trigger
language plpgsql as $$
declare s numeric; target numeric;
begin
  select sum(c.amount) into s from deedbox.collection_attribution c
   where c.allocation_entry = new.allocation_entry;
  select abs(j.signed_amount) into target from deedbox.bill_journal_entry j
   where j.id = new.allocation_entry
     and (j.entry_kind = 'payment_allocation'
          or (j.entry_kind = 'reversal' and exists (
                select 1 from deedbox.bill_journal_entry t
                 where t.id = j.reverses and t.entry_kind = 'payment_allocation')));
  if target is null then
    raise exception 'collection attribution fans allocations (or their reversals) only';
  end if;
  if s <> target then
    raise exception 'the collection fan for entry % must sum to its amount (% vs %)', new.allocation_entry, s, target;
  end if;
  return null;
end $$;
create constraint trigger z_assert_collection_fan
after insert on deedbox.collection_attribution
deferrable initially deferred
for each row execute function deedbox.z_assert_collection_fan();

------------------------------------------------------------------------------
-- Interest policies and charges.
------------------------------------------------------------------------------
create table deedbox.interest_policy (
    id bigint generated always as identity primary key,
    scope text not null check (scope in ('firm','matter')),
    matter bigint references deedbox.matter(id),
    annual_rate_pct numeric(6,3) not null check (annual_rate_pct >= 0),
    grace_days int not null check (grace_days >= 0),
    active boolean not null default true,
    effective_from date not null,
    created_at timestamptz not null default now(),
    check ((scope = 'matter') = (matter is not null))
);
create unique index interest_policy_one_active_firm
  on deedbox.interest_policy (scope) where scope = 'firm' and active;
create unique index interest_policy_one_active_matter
  on deedbox.interest_policy (matter) where scope = 'matter' and active;
grant select, insert, update on deedbox.interest_policy to deedbox_app;

create or replace function deedbox.interest_policy_guard() returns trigger
language plpgsql as $$
begin
  if tg_op = 'DELETE' then
    raise exception 'interest policies are superseded, never deleted';
  end if;
  if new.active and not old.active then
    raise exception 'a superseded interest policy never reactivates';
  end if;
  if new.scope is distinct from old.scope
     or new.matter is distinct from old.matter
     or new.annual_rate_pct is distinct from old.annual_rate_pct
     or new.grace_days is distinct from old.grace_days
     or new.effective_from is distinct from old.effective_from then
    raise exception 'interest policy rows are immutable; supersede with a new row';
  end if;
  return new;
end $$;
create trigger interest_policy_guard before update or delete on deedbox.interest_policy
for each row execute function deedbox.interest_policy_guard();

create table deedbox.interest_charge (
    id bigint generated always as identity primary key,
    bill bigint not null references deedbox.bill(id),
    period_from date not null,
    period_to date not null,
    rate_pct_applied numeric(6,3) not null,
    amount numeric(14,2) not null check (amount > 0),
    computed_by text not null check (computed_by in ('system','manual')),
    approved_by bigint not null references deedbox.staff_member(id),
    approved_at timestamptz not null,
    supplementary_rendering text not null,
    created_at timestamptz not null default now(),
    check (period_to >= period_from),
    constraint interest_charge_periods_disjoint
      exclude using gist (bill with =, daterange(period_from, period_to, '[]') with &&)
);
grant select, insert on deedbox.interest_charge to deedbox_app;
create trigger interest_charge_append_only before update or delete on deedbox.interest_charge
for each row execute function deedbox.append_only_guard();

------------------------------------------------------------------------------
-- Receivable statements — insert-only snapshots.
------------------------------------------------------------------------------
create table deedbox.receivable_statement (
    id bigint generated always as identity primary key,
    scope_kind text not null check (scope_kind in ('client','matter')),
    scope bigint not null,
    statement_number text not null unique,
    as_at timestamptz not null default now(),
    content_snapshot jsonb not null,
    artefact text not null,
    payment_reference bigint references deedbox.payment_reference(id)
);
create index receivable_statement_scope_idx on deedbox.receivable_statement (scope_kind, scope, as_at desc);
grant select, insert on deedbox.receivable_statement to deedbox_app;
create trigger receivable_statement_append_only before update or delete on deedbox.receivable_statement
for each row execute function deedbox.append_only_guard();

------------------------------------------------------------------------------
-- Payment arrangements.
------------------------------------------------------------------------------
create table deedbox.payment_arrangement (
    id bigint generated always as identity primary key,
    client_party bigint not null references deedbox.party(id),
    matter bigint references deedbox.matter(id),
    covers_future_bills boolean not null default false,
    instalment_amount numeric(14,2) not null check (instalment_amount > 0),
    frequency text not null check (frequency in ('weekly','every_two_weeks','monthly','custom')),
    custom_interval_days int,
    instalment_count int not null check (instalment_count > 0),
    stored_method_ref text,
    state text not null default 'active' check (state in ('active','completed','broken','cancelled')),
    broken_at timestamptz,
    created_at timestamptz not null default now(),
    check ((frequency = 'custom') = (custom_interval_days is not null))
);
create index payment_arrangement_state_idx on deedbox.payment_arrangement (state);
create index payment_arrangement_client_idx on deedbox.payment_arrangement (client_party);
grant select, insert, update on deedbox.payment_arrangement to deedbox_app;

create or replace function deedbox.payment_arrangement_guard() returns trigger
language plpgsql as $$
begin
  if tg_op = 'DELETE' then
    raise exception 'arrangements are never deleted';
  end if;
  if new.state is distinct from old.state then
    if not ( (old.state = 'active' and new.state in ('completed','broken','cancelled'))
          or (old.state = 'broken' and new.state in ('active','cancelled')) ) then
      raise exception 'illegal arrangement transition % -> %', old.state, new.state;
    end if;
    if new.state = 'broken' and new.broken_at is null then
      new.broken_at := now();
    end if;
  elsif old.state in ('completed','cancelled') then
    raise exception 'a finished arrangement is immutable';
  end if;
  return new;
end $$;
create trigger payment_arrangement_guard before update or delete on deedbox.payment_arrangement
for each row execute function deedbox.payment_arrangement_guard();

create table deedbox.arrangement_bill (
    id bigint generated always as identity primary key,
    arrangement bigint not null references deedbox.payment_arrangement(id),
    bill bigint not null references deedbox.bill(id),
    unique (arrangement, bill)
);
create index arrangement_bill_bill_idx on deedbox.arrangement_bill (bill);
grant select, insert on deedbox.arrangement_bill to deedbox_app;

-- one live (active/broken) arrangement covering any bill, ever.
create or replace function deedbox.arrangement_bill_guard() returns trigger
language plpgsql as $$
begin
  if tg_op in ('UPDATE','DELETE') then
    raise exception 'coverage rows are insert-only';
  end if;
  if (select a.state from deedbox.payment_arrangement a where a.id = new.arrangement)
       not in ('active','broken') then
    raise exception 'coverage attaches to a live arrangement';
  end if;
  if exists (select 1 from deedbox.arrangement_bill ab
              join deedbox.payment_arrangement a on a.id = ab.arrangement
             where ab.bill = new.bill and ab.arrangement <> new.arrangement
               and a.state in ('active','broken')) then
    raise exception 'another live arrangement already covers bill %', new.bill;
  end if;
  return new;
end $$;
create trigger arrangement_bill_guard before insert or update or delete on deedbox.arrangement_bill
for each row execute function deedbox.arrangement_bill_guard();

create table deedbox.instalment (
    id bigint generated always as identity primary key,
    arrangement bigint not null references deedbox.payment_arrangement(id),
    sequence_no int not null,
    due_date date not null,
    amount numeric(14,2) not null check (amount > 0),
    state text not null default 'scheduled'
      check (state in ('scheduled','notified','collecting','paid','missed')),
    channel_payment bigint references deedbox.channel_payment(id),
    notified_at timestamptz,
    unique (arrangement, sequence_no)
);
create index instalment_due_idx on deedbox.instalment (state, due_date);
grant select, insert, update on deedbox.instalment to deedbox_app;

create or replace function deedbox.instalment_guard() returns trigger
language plpgsql as $$
begin
  if tg_op = 'DELETE' then
    raise exception 'instalments are never deleted';
  end if;
  if tg_op = 'INSERT' then
    if new.state <> 'scheduled' then
      raise exception 'an instalment is born scheduled';
    end if;
    return new;
  end if;
  if old.state in ('paid','missed') and new.state is distinct from old.state then
    raise exception 'a paid or missed instalment is terminal';
  end if;
  if new.state is distinct from old.state then
    if not ( (old.state = 'scheduled' and new.state in ('notified','collecting','paid','missed'))
          or (old.state = 'notified' and new.state in ('collecting','paid','missed'))
          or (old.state = 'collecting' and new.state in ('paid','missed')) ) then
      raise exception 'illegal instalment transition % -> %', old.state, new.state;
    end if;
    if new.state = 'notified' and new.notified_at is null then
      new.notified_at := now();
    end if;
  end if;
  return new;
end $$;
create trigger instalment_guard before insert or update or delete on deedbox.instalment
for each row execute function deedbox.instalment_guard();

------------------------------------------------------------------------------
-- Reminder sequences, per-bill reminder state, contact evidence.
------------------------------------------------------------------------------
create table deedbox.reminder_sequence (
    id bigint generated always as identity primary key,
    name text not null,
    active boolean not null default true,
    default_for_new_bills boolean not null default false,
    created_at timestamptz not null default now()
);
create unique index reminder_sequence_one_default
  on deedbox.reminder_sequence (default_for_new_bills) where default_for_new_bills and active;
grant select, insert, update on deedbox.reminder_sequence to deedbox_app;

create table deedbox.reminder_step (
    id bigint generated always as identity primary key,
    sequence bigint not null references deedbox.reminder_sequence(id),
    step_no int not null,
    days_after_previous int not null check (days_after_previous >= 0),
    channel text not null check (channel in ('email','text_message','task')),
    template bigint,     -- FK lands with the configuration domain's message_template
    unique (sequence, step_no)
);
grant select, insert, update, delete on deedbox.reminder_step to deedbox_app;

create table deedbox.bill_reminder_state (
    id bigint generated always as identity primary key,
    bill bigint not null unique references deedbox.bill(id),
    sequence bigint not null references deedbox.reminder_sequence(id),
    current_step_no int not null default 0,
    next_step_at timestamptz,
    status text not null default 'running'
      check (status in ('running','stopped_paid','stopped_arrangement','stopped_disputed','held_manual','exhausted')),
    held_by bigint references deedbox.staff_member(id),
    held_at timestamptz,
    hold_reason text,
    check ((status = 'held_manual') <= (held_by is not null and held_at is not null and hold_reason is not null))
);
create index bill_reminder_running_idx
  on deedbox.bill_reminder_state (next_step_at) where status = 'running';
grant select, insert, update on deedbox.bill_reminder_state to deedbox_app;

create or replace function deedbox.bill_reminder_state_guard() returns trigger
language plpgsql as $$
begin
  if tg_op = 'DELETE' then
    raise exception 'reminder state rows are never deleted';
  end if;
  if new.status is distinct from old.status then
    if not ( (old.status = 'running' and new.status in
                ('stopped_paid','stopped_arrangement','stopped_disputed','held_manual','exhausted'))
          or (old.status in ('stopped_paid','stopped_arrangement','stopped_disputed','held_manual')
              and new.status = 'running')
          or (old.status = 'exhausted' and new.status = 'running') ) then
      raise exception 'illegal reminder transition % -> %', old.status, new.status;
    end if;
    if new.status = 'running' then
      new.held_by := null; new.held_at := null; new.hold_reason := null;
    end if;
  end if;
  return new;
end $$;
create trigger bill_reminder_state_guard before update or delete on deedbox.bill_reminder_state
for each row execute function deedbox.bill_reminder_state_guard();

create table deedbox.reminder_contact (
    id bigint generated always as identity primary key,
    bill bigint not null references deedbox.bill(id),
    step_no int not null,
    channel text not null,
    outbound_message bigint,   -- FK lands with the operations domain
    task bigint,               -- FK lands with the workflow domain
    sent_at timestamptz not null default now()
);
create index reminder_contact_bill_idx on deedbox.reminder_contact (bill);
grant select, insert on deedbox.reminder_contact to deedbox_app;
create trigger reminder_contact_append_only before update or delete on deedbox.reminder_contact
for each row execute function deedbox.append_only_guard();

------------------------------------------------------------------------------
-- Top-up requests — one open per policy, structurally.
------------------------------------------------------------------------------
create table deedbox.top_up_request (
    id bigint generated always as identity primary key,
    funds_policy bigint not null references deedbox.matter_funds_policy(id),
    raised_at timestamptz not null default now(),
    request_number text not null unique,
    amount_requested numeric(14,2) not null check (amount_requested > 0),
    attach_to_next_bill boolean not null,
    payment_reference bigint references deedbox.payment_reference(id),
    alerted_staff bigint not null references deedbox.staff_member(id),
    state text not null check (state in ('pending_confirmation','issued','satisfied','cancelled')),
    check (state <> 'issued' or payment_reference is not null)
);
create unique index top_up_one_open
  on deedbox.top_up_request (funds_policy) where state in ('pending_confirmation','issued');
create index top_up_state_idx on deedbox.top_up_request (state, raised_at);
grant select, insert, update on deedbox.top_up_request to deedbox_app;

create or replace function deedbox.top_up_guard() returns trigger
language plpgsql as $$
begin
  if tg_op = 'DELETE' then
    raise exception 'top-up requests are never deleted';
  end if;
  if tg_op = 'INSERT' then
    if new.state not in ('pending_confirmation','issued') then
      raise exception 'a top-up request is born pending or issued';
    end if;
    return new;
  end if;
  if old.state in ('satisfied','cancelled') then
    raise exception 'a finished top-up request is immutable';
  end if;
  if new.state is distinct from old.state then
    if not ( (old.state = 'pending_confirmation' and new.state in ('issued','cancelled'))
          or (old.state = 'issued' and new.state in ('satisfied','cancelled')) ) then
      raise exception 'illegal top-up transition % -> %', old.state, new.state;
    end if;
  end if;
  return new;
end $$;
create trigger top_up_guard before insert or update or delete on deedbox.top_up_request
for each row execute function deedbox.top_up_guard();

------------------------------------------------------------------------------
-- Held-funds application — the record layer of the one bridge.
------------------------------------------------------------------------------
create table deedbox.application_run (
    id bigint generated always as identity primary key,
    run_by bigint not null references deedbox.staff_member(id),
    run_at timestamptz not null default now(),
    scope text not null check (scope in ('single_matter','cross_matter')),
    bulk_operation bigint not null references deedbox.bulk_operation(id),
    state text not null default 'previewed'
      check (state in ('previewed','committing','completed','completed_with_refusals','abandoned'))
);
grant select, insert, update on deedbox.application_run to deedbox_app;

create or replace function deedbox.application_run_guard() returns trigger
language plpgsql as $$
begin
  if tg_op = 'DELETE' then
    raise exception 'application runs are never deleted';
  end if;
  if new.state is distinct from old.state then
    if not ( (old.state = 'previewed' and new.state in ('committing','abandoned'))
          or (old.state = 'committing' and new.state in ('completed','completed_with_refusals')) ) then
      raise exception 'illegal application-run transition % -> %', old.state, new.state;
    end if;
  elsif old.state in ('completed','completed_with_refusals','abandoned') then
    raise exception 'a finished application run is immutable';
  end if;
  return new;
end $$;
create trigger application_run_guard before update or delete on deedbox.application_run
for each row execute function deedbox.application_run_guard();

create table deedbox.funds_application (
    id bigint generated always as identity primary key,
    run bigint not null references deedbox.application_run(id),
    matter_ledger bigint,      -- FK lands with the client-money stage
    entitlement bigint,        -- FK lands with the client-money stage
    bill bigint not null references deedbox.bill(id),
    amount numeric(14,2) not null check (amount > 0),
    money_payment bigint,      -- FK lands with the client-money stage
    receivable_payment bigint references deedbox.receivable_payment(id),
    allocation_entry bigint references deedbox.bill_journal_entry(id),
    item_state text not null default 'previewed'
      check (item_state in ('previewed','awaiting_authorisation','completed','refused')),
    refusal_reason text,
    check (item_state <> 'completed'
           or (money_payment is not null and receivable_payment is not null and allocation_entry is not null)),
    check ((item_state = 'refused') <= (refusal_reason is not null))
);
create index funds_application_run_idx on deedbox.funds_application (run);
create index funds_application_bill_idx on deedbox.funds_application (bill);
grant select, insert, update on deedbox.funds_application to deedbox_app;

alter table deedbox.receivable_payment
  add constraint receivable_payment_funds_application_fk
  foreign key (funds_application) references deedbox.funds_application(id);
alter table deedbox.receivable_payment
  add constraint receivable_payment_funds_source
  check ((source = 'held_funds_application') = (funds_application is not null));

commit;
