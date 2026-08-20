-- 0010_receivables_core — the path from captured work to an issued, owed bill:
-- payer shares, billing runs, bill groups, bills with the draft→approval→issue
-- machine, bill lines — closing the capture items' bill_line pointers with
-- real foreign keys — and the append-only bill journal, the sole authority for
-- what a bill is owed. Plus payment_details: the versioned, register-audited,
-- optionally dual-approved firm record of where clients send money, with its
-- register kind and setting landing here alongside it. (Disputes, credits,
-- write-offs, payments, interest, statements, arrangements, reminders, top-ups
-- and application runs follow in 0011.)
--
-- Implementation notes:
--   * The payer-set sum-to-100 rule is a DEFERRED constraint trigger: the
--     whole-set replacement operation satisfies it at commit; a partial
--     edit that breaks the sum cannot commit. (Tests force it with SET
--     CONSTRAINTS.) Sibling issue atomicity is enforced the same way.
--   * Artefact references (rendered bills) are text refs until the
--     operations domain lands the stored-artefact table.
--   * Journal entries are accepted only against issued bills; the issue
--     operation writes the issue_total in the issuing transaction.
--   * Journal entry_no is assigned by trigger (max+1 per bill); the
--     writing operations serialise on a per-bill lock.
--   * payment_details admits at most one pending version at a time; a
--     version approved from pending requires a different approver (the same
--     separation-of-duties pattern); approving stamps the previously-governing
--     version superseded in the same transaction.
--   * Bill approval-flow capability checks (bill.issue / bill.approve)
--     are the operations layer's; the schema enforces state legality and
--     issue-time completeness — a bill physically cannot reach issued
--     without number, dates, terms and rendering.

begin;

------------------------------------------------------------------------------
-- matter_payer — the active set sums to exactly 100.00, or is empty.
------------------------------------------------------------------------------
create table deedbox.matter_payer (
    id bigint generated always as identity primary key,
    matter bigint not null references deedbox.matter(id),
    payer_party bigint not null references deedbox.party(id),
    share_pct numeric(5,2) not null check (share_pct > 0),
    active boolean not null default true,
    created_at timestamptz not null default now()
);
create unique index matter_payer_active_unique
  on deedbox.matter_payer (matter, payer_party) where active;
grant select, insert, update on deedbox.matter_payer to deedbox_app;

create or replace function deedbox.z_assert_payer_sum() returns trigger
language plpgsql as $$
declare m bigint; s numeric;
begin
  m := coalesce(new.matter, old.matter);
  select sum(p.share_pct) into s from deedbox.matter_payer p
   where p.matter = m and p.active;
  if s is not null and s <> 100.00 then
    raise exception 'the active payer set for matter % must sum to exactly 100.00 (found %)', m, s;
  end if;
  return null;
end $$;
create constraint trigger z_assert_payer_sum
after insert or update or delete on deedbox.matter_payer
deferrable initially deferred
for each row execute function deedbox.z_assert_payer_sum();

------------------------------------------------------------------------------
-- billing_run.
------------------------------------------------------------------------------
create table deedbox.billing_run (
    id bigint generated always as identity primary key,
    run_by bigint not null references deedbox.staff_member(id),
    run_at timestamptz not null default now(),
    filter_snapshot jsonb not null,
    state text not null default 'building'
      check (state in ('building','in_review','issued','abandoned'))
);
create index billing_run_state_idx on deedbox.billing_run (state);
grant select, insert, update on deedbox.billing_run to deedbox_app;

create or replace function deedbox.billing_run_guard() returns trigger
language plpgsql as $$
begin
  if tg_op = 'DELETE' then
    raise exception 'billing runs are never deleted';
  end if;
  if new.state is distinct from old.state then
    if not ( (old.state = 'building' and new.state = 'in_review')
          or (old.state = 'in_review' and new.state in ('issued','abandoned')) ) then
      raise exception 'illegal billing-run transition % -> %', old.state, new.state;
    end if;
  elsif old.state in ('issued','abandoned') then
    raise exception 'a finished billing run is immutable';
  end if;
  return new;
end $$;
create trigger billing_run_guard before update or delete on deedbox.billing_run
for each row execute function deedbox.billing_run_guard();

------------------------------------------------------------------------------
-- Bill groups and bills — siblings move as one unit.
------------------------------------------------------------------------------
create table deedbox.bill_group (
    id bigint generated always as identity primary key,
    matter bigint not null references deedbox.matter(id),
    billing_run bigint references deedbox.billing_run(id),
    matter_total numeric(14,2) not null,
    payer_share_snapshot jsonb not null,
    rounding_record jsonb,
    state text not null default 'draft' check (state in ('draft','issued','abandoned')),
    created_at timestamptz not null default now()
);
create index bill_group_matter_idx on deedbox.bill_group (matter);
create index bill_group_run_idx on deedbox.bill_group (billing_run);
grant select, insert, update on deedbox.bill_group to deedbox_app;

create table deedbox.bill (
    id bigint generated always as identity primary key,
    bill_group bigint not null references deedbox.bill_group(id),
    matter bigint not null references deedbox.matter(id),
    payer_party bigint not null references deedbox.party(id),
    share_pct numeric(5,2) not null default 100,
    state text not null default 'draft' check (state in ('draft','pending_approval','issued')),
    bill_number text,
    issue_date date,
    terms_days_applied int,
    due_date date,
    interest_statement jsonb,
    rendered_artefact text,       -- stored-artefact ref; that table lands later
    submitted_by bigint references deedbox.staff_member(id),
    submitted_at timestamptz,
    approved_by bigint references deedbox.staff_member(id),
    approved_at timestamptz,
    reminder_exempt boolean not null default false,
    created_at timestamptz not null default now(),
    check (state <> 'issued' or (bill_number is not null and issue_date is not null
           and terms_days_applied is not null and due_date is not null
           and rendered_artefact is not null))
);
create unique index bill_number_unique on deedbox.bill (bill_number) where bill_number is not null;
create index bill_matter_state_idx on deedbox.bill (matter, state);
create index bill_group_idx on deedbox.bill (bill_group);
create index bill_due_idx on deedbox.bill (due_date) where state = 'issued';
create index bill_payer_idx on deedbox.bill (payer_party);
grant select, insert, update, delete on deedbox.bill to deedbox_app;

create or replace function deedbox.bill_guard() returns trigger
language plpgsql as $$
declare g_matter bigint;
begin
  if tg_op = 'INSERT' then
    select bg.matter into g_matter from deedbox.bill_group bg where bg.id = new.bill_group;
    if new.matter is distinct from g_matter then
      raise exception 'a bill''s matter must equal its group''s matter';
    end if;
    if new.state <> 'draft' then
      raise exception 'bills are born draft';
    end if;
    return new;
  end if;
  if tg_op = 'DELETE' then
    if old.state = 'issued' then
      raise exception 'issued bills are never deleted';
    end if;
    return old;
  end if;
  if old.state = 'issued' then
    raise exception 'an issued bill is immutable; its financial life is the journal';
  end if;
  if new.state is distinct from old.state then
    if not ( (old.state = 'draft' and new.state in ('pending_approval','issued'))
          or (old.state = 'pending_approval' and new.state in ('draft','issued')) ) then
      raise exception 'illegal bill transition % -> %', old.state, new.state;
    end if;
    if new.state = 'pending_approval' and (new.submitted_by is null or new.submitted_at is null) then
      raise exception 'submission records who and when';
    end if;
  end if;
  if new.bill_number is distinct from old.bill_number and old.bill_number is not null then
    raise exception 'a bill number, once allocated, is immutable';
  end if;
  if new.bill_group is distinct from old.bill_group or new.matter is distinct from old.matter then
    raise exception 'a bill never moves group or matter';
  end if;
  return new;
end $$;
create trigger bill_guard before insert or update or delete on deedbox.bill
for each row execute function deedbox.bill_guard();

-- The group's derived state mirror, and the group's immutability once issued.
create or replace function deedbox.bill_group_guard() returns trigger
language plpgsql as $$
begin
  if tg_op = 'DELETE' then
    raise exception 'bill groups are never deleted (abandonment is a state)';
  end if;
  if old.state = 'issued'
     and (new.matter_total is distinct from old.matter_total
          or new.payer_share_snapshot is distinct from old.payer_share_snapshot
          or new.rounding_record is distinct from old.rounding_record
          or new.matter is distinct from old.matter) then
    raise exception 'an issued bill group is immutable';
  end if;
  return new;
end $$;
create trigger bill_group_guard before update or delete on deedbox.bill_group
for each row execute function deedbox.bill_group_guard();

create or replace function deedbox.bill_group_mirror() returns trigger
language plpgsql as $$
declare g bigint; n_total int; n_issued int;
begin
  g := coalesce(new.bill_group, old.bill_group);
  select count(*), count(*) filter (where b.state = 'issued')
    into n_total, n_issued
    from deedbox.bill b where b.bill_group = g;
  update deedbox.bill_group bg
     set state = case when n_total = 0 then 'abandoned'
                      when n_issued = n_total then 'issued'
                      else 'draft' end
   where bg.id = g and bg.state is distinct from
         (case when n_total = 0 then 'abandoned'
               when n_issued = n_total then 'issued'
               else 'draft' end);
  return null;
end $$;
create trigger bill_group_mirror after insert or update or delete on deedbox.bill
for each row execute function deedbox.bill_group_mirror();

-- Sibling atomicity: at commit, no group holds a mix of issued and
-- unissued bills.
create or replace function deedbox.z_assert_sibling_issue() returns trigger
language plpgsql as $$
declare bad bigint;
begin
  select b.bill_group into bad
    from deedbox.bill b
   group by b.bill_group
  having count(*) filter (where b.state = 'issued') > 0
     and count(*) filter (where b.state <> 'issued') > 0
   limit 1;
  if bad is not null then
    raise exception 'bill group % would commit part-issued: siblings issue as one unit', bad;
  end if;
  return null;
end $$;
create constraint trigger z_assert_sibling_issue
after insert or update or delete on deedbox.bill
deferrable initially deferred
for each row execute function deedbox.z_assert_sibling_issue();

------------------------------------------------------------------------------
-- Bill lines — immutable once the bill issues; the capture items'
-- back-pointers become real foreign keys here.
------------------------------------------------------------------------------
create table deedbox.bill_line (
    id bigint generated always as identity primary key,
    bill bigint not null references deedbox.bill(id),
    position int not null,
    kind text not null check (kind in ('time','fixed_fee','disbursement','manual')),
    source_entry bigint,
    description text not null,
    quantity_units int,
    rate numeric(14,2),
    original_value numeric(14,2) not null,
    written_down_to numeric(14,2),
    write_down_reason text,
    amount numeric(14,2) not null,
    tax_treatment text not null,
    tax_amount numeric(14,2) not null,
    category_key text not null,
    unique (bill, position),
    check (written_down_to is null or written_down_to < original_value),
    check ((written_down_to is not null) <= (write_down_reason is not null)),
    check (amount = coalesce(written_down_to, original_value))
);
create index bill_line_bill_idx on deedbox.bill_line (bill);
create index bill_line_source_idx on deedbox.bill_line (source_entry);
grant select, insert, update, delete on deedbox.bill_line to deedbox_app;

create or replace function deedbox.bill_line_guard() returns trigger
language plpgsql as $$
declare b_state text;
begin
  select b.state into b_state from deedbox.bill b
   where b.id = coalesce(new.bill, old.bill);
  if tg_op = 'INSERT' then
    if b_state <> 'draft' then
      raise exception 'lines are drafted onto draft bills only';
    end if;
    return new;
  end if;
  if b_state = 'issued' then
    raise exception 'an issued bill''s lines are immutable';
  end if;
  if tg_op = 'DELETE' then
    return old;
  end if;
  if new.bill is distinct from old.bill then
    raise exception 'a line never moves between bills';
  end if;
  return new;
end $$;
create trigger bill_line_guard before insert or update or delete on deedbox.bill_line
for each row execute function deedbox.bill_line_guard();

alter table deedbox.time_entry
  add constraint time_entry_bill_line_fk foreign key (bill_line) references deedbox.bill_line(id);
alter table deedbox.disbursement
  add constraint disbursement_bill_line_fk foreign key (bill_line) references deedbox.bill_line(id);

------------------------------------------------------------------------------
-- The bill journal — append-only, the sole authority for what is owed;
-- outstanding can never go below zero.
------------------------------------------------------------------------------
create table deedbox.bill_journal_entry (
    id bigint generated always as identity primary key,
    bill bigint not null references deedbox.bill(id),
    entry_no int not null,
    entry_kind text not null check (entry_kind in
      ('issue_total','interest_charge','payment_allocation','credit_application','write_off','reversal')),
    signed_amount numeric(14,2) not null check (signed_amount <> 0),
    source_type text not null,
    source bigint not null,
    effective_date date not null,
    entered_at timestamptz not null default now(),
    entered_by bigint not null,
    reverses bigint references deedbox.bill_journal_entry(id),
    reason text,
    unique (bill, entry_no),
    check ((entry_kind = 'reversal') = (reverses is not null)),
    check (entry_kind not in ('reversal','write_off') or (reason is not null and reason <> '')),
    check (entry_kind not in ('issue_total','interest_charge') or signed_amount > 0),
    check (entry_kind not in ('payment_allocation','credit_application','write_off') or signed_amount < 0)
);
create unique index bill_journal_one_issue_total
  on deedbox.bill_journal_entry (bill) where entry_kind = 'issue_total';
create unique index bill_journal_one_reversal_per_entry
  on deedbox.bill_journal_entry (reverses) where reverses is not null;
create index bill_journal_kind_date_idx on deedbox.bill_journal_entry (entry_kind, effective_date);
create index bill_journal_source_idx on deedbox.bill_journal_entry (source_type, source);
grant select, insert on deedbox.bill_journal_entry to deedbox_app;

create or replace function deedbox.bill_journal_guard() returns trigger
language plpgsql as $$
declare b_state text;
begin
  if tg_op in ('UPDATE','DELETE') then
    raise exception 'the bill journal is append-only; corrections are reversal entries';
  end if;
  select b.state into b_state from deedbox.bill b where b.id = new.bill;
  if b_state <> 'issued' then
    raise exception 'journal entries record the financial life of ISSUED bills';
  end if;
  new.entry_no := coalesce(
    (select max(j.entry_no) from deedbox.bill_journal_entry j where j.bill = new.bill), 0) + 1;
  if new.reverses is not null then
    declare tgt deedbox.bill_journal_entry%rowtype;
    begin
      select * into tgt from deedbox.bill_journal_entry j where j.id = new.reverses;
      if tgt.bill <> new.bill then
        raise exception 'a reversal targets an entry of its own bill';
      end if;
      if new.signed_amount <> -tgt.signed_amount then
        raise exception 'a reversal mirrors its target exactly';
      end if;
    end;
  end if;
  return new;
end $$;
create trigger bill_journal_guard before insert or update or delete on deedbox.bill_journal_entry
for each row execute function deedbox.bill_journal_guard();

create or replace function deedbox.z_assert_outstanding() returns trigger
language plpgsql as $$
declare s numeric;
begin
  select sum(j.signed_amount) into s from deedbox.bill_journal_entry j where j.bill = new.bill;
  if s < 0 then
    raise exception 'outstanding on bill % would fall below zero (%)', new.bill, s;
  end if;
  return null;
end $$;
create constraint trigger z_assert_outstanding
after insert on deedbox.bill_journal_entry
deferrable initially immediate
for each row execute function deedbox.z_assert_outstanding();

create or replace function deedbox.bill_outstanding(p_bill bigint) returns numeric
language sql stable as $$
  select coalesce(sum(j.signed_amount), 0) from deedbox.bill_journal_entry j where j.bill = p_bill;
$$;

------------------------------------------------------------------------------
-- payment_details — the versioned, register-audited, optionally dual-approved
-- firm record of where clients are told to send money.
------------------------------------------------------------------------------
insert into deedbox.setting_definition (key, value_type, neutral_default, allowed_values, description) values
('billing.payment_details_require_approval','boolean','false',null,
 'Whether a new payment-details version needs approval by a second person before it governs.');

insert into deedbox.register_event_kind (kind, privileged_required) values
('payment_details.changed', true);
update deedbox.register_event_kind
   set matter_link = 'forbidden'
 where kind = 'payment_details.changed';

create table deedbox.payment_details (
    id bigint generated always as identity primary key,
    version_no int not null,
    account_holder_name text not null check (account_holder_name <> ''),
    bank_name text not null check (bank_name <> ''),
    identifier_values jsonb not null,
    reference_rule text not null default 'matter_reference' check (reference_rule = 'matter_reference'),
    state text not null check (state in ('pending','approved')),
    created_by bigint not null references deedbox.staff_member(id),
    created_at timestamptz not null default now(),
    approved_by bigint references deedbox.staff_member(id),
    approved_at timestamptz,
    superseded_at timestamptz,
    unique (version_no),
    check ((state = 'approved') = (approved_by is not null and approved_at is not null))
);
create unique index payment_details_one_pending
  on deedbox.payment_details (state) where state = 'pending';
create index payment_details_governing_idx
  on deedbox.payment_details (state) where state = 'approved' and superseded_at is null;
grant select, insert, update on deedbox.payment_details to deedbox_app;

create or replace function deedbox.payment_details_guard() returns trigger
language plpgsql as $$
begin
  if tg_op = 'DELETE' then
    raise exception 'payment-details versions are never deleted';
  end if;
  if tg_op = 'INSERT' then
    new.version_no := coalesce((select max(pd.version_no) from deedbox.payment_details pd), 0) + 1;
    if new.state = 'approved' and new.approved_by is null then
      raise exception 'a born-approved version records its approver';
    end if;
    if new.superseded_at is not null then
      raise exception 'a version is not born superseded';
    end if;
    return new;
  end if;
  -- UPDATE: pending -> approved (different person), or the supersession stamp.
  if old.state = 'pending' then
    if new.state <> 'approved'
       or new.account_holder_name is distinct from old.account_holder_name
       or new.bank_name is distinct from old.bank_name
       or new.identifier_values is distinct from old.identifier_values
       or new.created_by is distinct from old.created_by
       or new.created_at is distinct from old.created_at
       or new.version_no is distinct from old.version_no then
      raise exception 'a pending version changes only by being approved';
    end if;
    if new.approved_by = new.created_by then
      raise exception 'payment details need a different approver than their author';
    end if;
    return new;
  end if;
  -- approved rows: only the supersession stamp, set once.
  if old.superseded_at is not null then
    raise exception 'a superseded payment-details version is immutable';
  end if;
  if new.superseded_at is null
     or new.state is distinct from old.state
     or new.account_holder_name is distinct from old.account_holder_name
     or new.bank_name is distinct from old.bank_name
     or new.identifier_values is distinct from old.identifier_values
     or new.version_no is distinct from old.version_no
     or new.approved_by is distinct from old.approved_by
     or new.approved_at is distinct from old.approved_at then
    raise exception 'an approved version admits exactly one mutation: its supersession';
  end if;
  return new;
end $$;
create trigger payment_details_guard before insert or update or delete on deedbox.payment_details
for each row execute function deedbox.payment_details_guard();

-- Approval (born or from pending) supersedes the previously governing version.
create or replace function deedbox.payment_details_supersede() returns trigger
language plpgsql as $$
begin
  update deedbox.payment_details pd
     set superseded_at = now()
   where pd.state = 'approved' and pd.superseded_at is null and pd.id <> new.id;
  return null;
end $$;
create trigger payment_details_supersede after insert or update on deedbox.payment_details
for each row when (new.state = 'approved' and new.superseded_at is null)
execute function deedbox.payment_details_supersede();

-- The one resolver every rendering path uses: the governing version, or
-- nothing (all-or-nothing rendering; the app renders no partial block).
create or replace function deedbox.governing_payment_details()
returns deedbox.payment_details language sql stable as $$
  select pd.* from deedbox.payment_details pd
   where pd.state = 'approved' and pd.superseded_at is null
   order by pd.version_no desc limit 1;
$$;

commit;
