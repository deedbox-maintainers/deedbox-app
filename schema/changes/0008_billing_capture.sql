-- 0008_billing_capture — stage 4 (billing) opens: pricing (staff rates,
-- structurally confined cost rates, matter overrides) and capture (time
-- entries with the stored-and-verified value formula and the billed-state
-- lock rule, timers, activity signals, suggested entries, cost types,
-- disbursements). The remaining guardrails land in 0009; receivables in the
-- slices after. Implements the pricing and capture tables plus the
-- row-level mechanics of the capture operations (their register emission,
-- search-index rows and threshold enqueue are app-layer, later stages).
--
-- Implementation notes:
--   * Money columns are numeric(14,2) (the operating currency's cents);
--     the client-money stage will carry the same convention.
--   * The timed value formula is a CHECK: value = round(units ×
--     unit_minutes_applied × applied_rate ÷ 60, 2) — numeric round() is
--     half-away-from-zero, the intended convention.
--   * bill_line is a bare column until the receivables slice lands the
--     bill-line table (same pattern as intake's source_integration_key);
--     the lock rule and state machine are enforced now.
--   * Rate resolution prefers a label-exact override over a null-label
--     override within each tier (specific beats generic), then the latest
--     effective date ≤ the work date.
--   * Tax-treatment validation binds only when the firm's active pack
--     declares billing.tax keys (as declaration discriminators); the
--     shipped neutral default is "no additional rule", so any non-empty
--     key passes until a pack constrains it.
--   * Cost-rate confinement is row security on the table itself: staff
--     principals need see_cost_rates; system jobs read; everything else
--     (and absent context) reads nothing.
--   * written_off_before_billing rows are frozen entirely (the machine
--     calls the state terminal; narrative-edit latitude applies to
--     on-draft/billed rows).

begin;

------------------------------------------------------------------------------
-- Staff rates and cost rates — append-only history.
------------------------------------------------------------------------------
create table deedbox.staff_rate (
    id bigint generated always as identity primary key,
    staff bigint not null references deedbox.staff_member(id),
    label text not null default 'standard',
    rate numeric(14,2) not null check (rate >= 0),
    effective_from date not null,
    created_at timestamptz not null default now(),
    unique (staff, label, effective_from)
);
create index staff_rate_lookup_idx on deedbox.staff_rate (staff, label, effective_from desc);
grant select, insert on deedbox.staff_rate to deedbox_app;

create table deedbox.staff_cost_rate (
    id bigint generated always as identity primary key,
    staff bigint not null references deedbox.staff_member(id),
    cost_rate numeric(14,2) not null check (cost_rate >= 0),
    effective_from date not null,
    created_at timestamptz not null default now(),
    unique (staff, effective_from)
);
create index staff_cost_rate_lookup_idx on deedbox.staff_cost_rate (staff, effective_from desc);
grant select, insert on deedbox.staff_cost_rate to deedbox_app;

create or replace function deedbox.append_only_guard() returns trigger
language plpgsql as $$
begin
  raise exception '% rows are append-only', tg_table_name;
end $$;
create trigger staff_rate_append_only before update or delete on deedbox.staff_rate
for each row execute function deedbox.append_only_guard();
create trigger staff_cost_rate_append_only before update or delete on deedbox.staff_cost_rate
for each row execute function deedbox.append_only_guard();

-- Cost-rate confinement: a structural property of the table, not a code path.
create or replace function deedbox.can_see_cost_rates() returns boolean
security definer set search_path = deedbox, pg_temp
language plpgsql stable as $$
declare kind text; pid bigint;
begin
  kind := current_setting('deedbox.principal_kind', true);
  pid  := nullif(current_setting('deedbox.principal_id', true), '')::bigint;
  if kind = 'system_job' then
    return true;
  end if;
  if kind = 'staff' and pid is not null then
    return exists (
      select 1 from deedbox.staff_member s
      join deedbox.role_capability rc on rc.role = s.role
      where s.id = pid and s.active
        and rc.capability = 'see_cost_rates' and rc.scope <> 'none');
  end if;
  return false;   -- portal clients, examiners, keys, absent context: nothing
end $$;

alter table deedbox.staff_cost_rate enable row level security;
create policy staff_cost_rate_read on deedbox.staff_cost_rate
  for select to deedbox_app using (deedbox.can_see_cost_rates());
create policy staff_cost_rate_write on deedbox.staff_cost_rate
  for insert to deedbox_app with check (deedbox.can_see_cost_rates());

------------------------------------------------------------------------------
-- Matter rate overrides — append-only.
------------------------------------------------------------------------------
create table deedbox.matter_rate_override (
    id bigint generated always as identity primary key,
    matter bigint not null references deedbox.matter(id),
    staff bigint references deedbox.staff_member(id),   -- null = all staff
    label text,
    rate numeric(14,2) not null check (rate >= 0),
    effective_from date not null,
    created_at timestamptz not null default now()
);
create unique index matter_rate_override_unique
  on deedbox.matter_rate_override (matter, coalesce(staff, -1), coalesce(label, ''), effective_from);
create index matter_rate_override_lookup_idx
  on deedbox.matter_rate_override (matter, staff, effective_from desc);
grant select, insert on deedbox.matter_rate_override to deedbox_app;
create trigger matter_rate_override_append_only before update or delete on deedbox.matter_rate_override
for each row execute function deedbox.append_only_guard();

-- The rate resolution order, one definition: (1) staff-named override,
-- (2) all-staff override, (3) the staff rate for the label — label-exact
-- beats null-label within each override tier; latest effective wins.
create or replace function deedbox.resolve_rate(
    p_matter bigint, p_staff bigint, p_label text, p_work_date date)
returns table (rate numeric, rate_source text) language sql stable as $$
  select r.rate, r.src from (
    select o.rate, 'matter_override' src, 1 tier,
           (o.label is not distinct from coalesce(p_label,'standard'))::int label_exact, o.effective_from
      from deedbox.matter_rate_override o
     where o.matter = p_matter and o.staff = p_staff
       and (o.label = coalesce(p_label,'standard') or o.label is null)
       and o.effective_from <= p_work_date
    union all
    select o.rate, 'matter_override', 2,
           (o.label is not distinct from coalesce(p_label,'standard'))::int, o.effective_from
      from deedbox.matter_rate_override o
     where o.matter = p_matter and o.staff is null
       and (o.label = coalesce(p_label,'standard') or o.label is null)
       and o.effective_from <= p_work_date
    union all
    select s.rate, 'staff_rate', 3, 1, s.effective_from
      from deedbox.staff_rate s
     where s.staff = p_staff and s.label = coalesce(p_label,'standard')
       and s.effective_from <= p_work_date
  ) r
  order by r.tier, r.label_exact desc, r.effective_from desc
  limit 1;
$$;

------------------------------------------------------------------------------
-- Cost types.
------------------------------------------------------------------------------
create table deedbox.cost_type (
    id bigint generated always as identity primary key,
    name text not null,
    default_amount numeric(14,2),
    default_tax_treatment text not null,
    active boolean not null default true,
    created_at timestamptz not null default now()
);
create unique index cost_type_name_unique on deedbox.cost_type (name) where active;
grant select, insert, update on deedbox.cost_type to deedbox_app;

-- Tax keys bind to the active pack's billing.tax declarations where any
-- exist; the shipped neutral default constrains nothing beyond non-empty.
create or replace function deedbox.valid_tax_treatment(p_key text) returns boolean
language sql stable as $$
  select case
    when p_key is null or p_key = '' then false
    when not exists (
      select 1 from deedbox.pack_declaration pd
      join deedbox.firm f on true
      join deedbox.country_pack cp on cp.id = f.country_pack
      where pd.pack_version = cp.active_version and pd.rule_point = 'billing.tax')
      then true
    else exists (
      select 1 from deedbox.pack_declaration pd
      join deedbox.firm f on true
      join deedbox.country_pack cp on cp.id = f.country_pack
      where pd.pack_version = cp.active_version and pd.rule_point = 'billing.tax'
        and pd.discriminator = p_key)
  end;
$$;

------------------------------------------------------------------------------
-- time_entry — the stored-and-verified value, the lock rule, the billed-state
-- machine.
------------------------------------------------------------------------------
create table deedbox.time_entry (
    id bigint generated always as identity primary key,
    matter bigint not null references deedbox.matter(id),
    staff bigint not null references deedbox.staff_member(id),
    work_date date not null,
    kind text not null default 'timed' check (kind in ('timed','fixed_fee')),
    units int,
    unit_minutes_applied int,
    applied_rate numeric(14,2),
    rate_source text check (rate_source in ('staff_rate','matter_override','manual')),
    fixed_amount numeric(14,2),
    value numeric(14,2) not null,
    narrative text not null,
    category bigint not null references deedbox.choice_item(id),
    billed_state text not null default 'unbilled'
      check (billed_state in ('unbilled','on_draft','billed','written_off_before_billing')),
    bill_line bigint,      -- FK lands with the receivables slice
    suggestion bigint,     -- FK added below (circular with suggested_entry)
    origin text not null check (origin in ('manual','timer','suggestion','import')),
    writeoff_reason text,
    created_at timestamptz not null default now(),
    created_by bigint,
    deleted_at timestamptz,
    deleted_by bigint,
    check (kind <> 'timed' or (units is not null and units > 0
           and unit_minutes_applied is not null and unit_minutes_applied > 0
           and applied_rate is not null and rate_source is not null
           and fixed_amount is null
           and value = round(units * unit_minutes_applied * applied_rate / 60.0, 2))),
    check (kind <> 'fixed_fee' or (fixed_amount is not null and fixed_amount >= 0
           and value = fixed_amount
           and units is null and unit_minutes_applied is null
           and applied_rate is null and rate_source is null)),
    check ((billed_state in ('on_draft','billed')) = (bill_line is not null)),
    check (billed_state <> 'written_off_before_billing' or writeoff_reason is not null)
);
create index time_entry_matter_state_idx on deedbox.time_entry (matter, billed_state);
create index time_entry_staff_date_idx on deedbox.time_entry (staff, work_date);
create index time_entry_matter_date_idx on deedbox.time_entry (matter, work_date);
create index time_entry_bill_line_idx on deedbox.time_entry (bill_line);
grant select, insert, update on deedbox.time_entry to deedbox_app;

create or replace function deedbox.billed_item_guard() returns trigger
language plpgsql as $$
begin
  if tg_op = 'DELETE' then
    raise exception 'captured items soft-delete; they are never hard-deleted';
  end if;
  if old.billed_state = 'written_off_before_billing' then
    raise exception 'a written-off item is terminal';
  end if;
  if new.billed_state is distinct from old.billed_state then
    if not ( (old.billed_state = 'unbilled' and new.billed_state in ('on_draft','written_off_before_billing'))
          or (old.billed_state = 'on_draft' and new.billed_state in ('unbilled','billed')) ) then
      raise exception 'illegal billed-state transition % -> %', old.billed_state, new.billed_state;
    end if;
  end if;
  if old.billed_state in ('on_draft','billed') then
    -- the lock rule: value-bearing fields frozen; narrative stays writable.
    if new.matter is distinct from old.matter
       or new.staff is distinct from old.staff
       or new.work_date is distinct from old.work_date
       or new.kind is distinct from old.kind
       or new.units is distinct from old.units
       or new.unit_minutes_applied is distinct from old.unit_minutes_applied
       or new.applied_rate is distinct from old.applied_rate
       or new.rate_source is distinct from old.rate_source
       or new.fixed_amount is distinct from old.fixed_amount
       or new.value is distinct from old.value
       or new.category is distinct from old.category then
      raise exception 'a drafted or billed item''s value fields are immutable';
    end if;
    if old.billed_state = 'billed' and new.bill_line is distinct from old.bill_line then
      raise exception 'a billed item never leaves its bill line';
    end if;
    if new.deleted_at is not null then
      raise exception 'only unbilled items soft-delete';
    end if;
  end if;
  if new.deleted_at is not null and old.deleted_at is null
     and old.billed_state <> 'unbilled' then
    raise exception 'only unbilled items soft-delete';
  end if;
  return new;
end $$;
create trigger time_entry_guard before update or delete on deedbox.time_entry
for each row execute function deedbox.billed_item_guard();

------------------------------------------------------------------------------
-- timer — ephemeral, hard-deleted on stop or discard.
------------------------------------------------------------------------------
create table deedbox.timer (
    id bigint generated always as identity primary key,
    staff bigint not null references deedbox.staff_member(id),
    matter bigint references deedbox.matter(id),
    started_at timestamptz not null default now(),
    accumulated_seconds int not null default 0 check (accumulated_seconds >= 0),
    state text not null default 'running' check (state in ('running','paused')),
    narrative_draft text
);
create index timer_staff_idx on deedbox.timer (staff);
grant select, insert, update, delete on deedbox.timer to deedbox_app;

------------------------------------------------------------------------------
-- Activity signals — insert-only, idempotent by source.
------------------------------------------------------------------------------
create table deedbox.activity_signal (
    id bigint generated always as identity primary key,
    source_module text not null,
    signal_kind text not null
      check (signal_kind in ('email_sent','document_worked','appointment_held','call_logged','other')),
    source_ref text not null,
    occurred_at timestamptz not null,
    staff bigint references deedbox.staff_member(id),
    matter_hint jsonb,
    duration_hint_minutes int,
    detail jsonb not null,
    created_at timestamptz not null default now(),
    unique (source_module, source_ref)
);
create index activity_signal_staff_idx on deedbox.activity_signal (staff);
grant select, insert on deedbox.activity_signal to deedbox_app;
create trigger activity_signal_insert_only before update or delete on deedbox.activity_signal
for each row execute function deedbox.append_only_guard();

------------------------------------------------------------------------------
-- Suggested entries — every signal reviewed, nothing billed unreviewed.
------------------------------------------------------------------------------
create table deedbox.suggested_entry (
    id bigint generated always as identity primary key,
    signal bigint not null unique references deedbox.activity_signal(id),
    staff bigint not null references deedbox.staff_member(id),
    matter bigint references deedbox.matter(id),
    state text not null check (state in
      ('held_unmatched','pending','accepted','edited_accepted','merged','discarded','superseded_by_manual')),
    proposed_date date not null,
    proposed_minutes int not null,
    proposed_narrative text not null,
    resulting_entry bigint references deedbox.time_entry(id),
    merged_into_entry bigint references deedbox.time_entry(id),
    resolved_at timestamptz,
    created_at timestamptz not null default now(),
    check (case when state = 'held_unmatched' then matter is null
                when state in ('pending','accepted','edited_accepted','merged','discarded') then matter is not null
                else true end),
    check ((state in ('accepted','edited_accepted')) = (resulting_entry is not null)),
    check ((state = 'merged') = (merged_into_entry is not null)),
    check ((state not in ('held_unmatched','pending')) = (resolved_at is not null))
);
create index suggested_entry_queue_idx on deedbox.suggested_entry (staff, state);
create index suggested_entry_matter_idx on deedbox.suggested_entry (matter, state);
grant select, insert, update on deedbox.suggested_entry to deedbox_app;

create or replace function deedbox.suggested_entry_guard() returns trigger
language plpgsql as $$
begin
  if tg_op = 'DELETE' then
    raise exception 'suggestions are retained as evidence of review';
  end if;
  if tg_op = 'INSERT' then
    if new.state not in ('held_unmatched','pending') then
      raise exception 'a suggestion is born held or pending';
    end if;
    return new;
  end if;
  if old.state not in ('held_unmatched','pending') then
    raise exception 'a resolved suggestion is immutable';
  end if;
  if new.state is distinct from old.state then
    if not ( (old.state = 'held_unmatched' and new.state in ('pending','superseded_by_manual'))
          or (old.state = 'pending' and new.state in
              ('accepted','edited_accepted','merged','discarded','superseded_by_manual')) ) then
      raise exception 'illegal suggestion transition % -> %', old.state, new.state;
    end if;
  end if;
  return new;
end $$;
create trigger suggested_entry_guard before insert or update or delete on deedbox.suggested_entry
for each row execute function deedbox.suggested_entry_guard();

alter table deedbox.time_entry
  add constraint time_entry_suggestion_fk
  foreign key (suggestion) references deedbox.suggested_entry(id);

------------------------------------------------------------------------------
-- disbursement — same lock rule and machine as time entries.
------------------------------------------------------------------------------
create table deedbox.disbursement (
    id bigint generated always as identity primary key,
    matter bigint not null references deedbox.matter(id),
    incurred_date date not null,
    description text not null,
    amount numeric(14,2) not null check (amount > 0),
    tax_treatment text not null,
    billable boolean not null default true,
    cost_type bigint references deedbox.cost_type(id),
    billed_state text not null default 'unbilled'
      check (billed_state in ('unbilled','on_draft','billed','written_off_before_billing')),
    bill_line bigint,      -- FK lands with the receivables slice
    writeoff_reason text,
    created_at timestamptz not null default now(),
    created_by bigint,
    deleted_at timestamptz,
    deleted_by bigint,
    check ((billed_state in ('on_draft','billed')) = (bill_line is not null)),
    check (billed_state <> 'written_off_before_billing' or writeoff_reason is not null),
    constraint disbursement_tax_valid check (tax_treatment <> '')
);
create index disbursement_matter_state_idx on deedbox.disbursement (matter, billed_state);
create index disbursement_bill_line_idx on deedbox.disbursement (bill_line);
create index disbursement_cost_type_idx on deedbox.disbursement (cost_type);
grant select, insert, update on deedbox.disbursement to deedbox_app;

create or replace function deedbox.disbursement_guard() returns trigger
language plpgsql as $$
begin
  if tg_op = 'DELETE' then
    raise exception 'captured items soft-delete; they are never hard-deleted';
  end if;
  if tg_op = 'INSERT' then
    if not deedbox.valid_tax_treatment(new.tax_treatment) then
      raise exception 'tax treatment % is not a key of the active pack''s tax rules', new.tax_treatment;
    end if;
    return new;
  end if;
  if old.billed_state = 'written_off_before_billing' then
    raise exception 'a written-off item is terminal';
  end if;
  if new.billed_state is distinct from old.billed_state then
    if not ( (old.billed_state = 'unbilled' and new.billed_state in ('on_draft','written_off_before_billing'))
          or (old.billed_state = 'on_draft' and new.billed_state in ('unbilled','billed')) ) then
      raise exception 'illegal billed-state transition % -> %', old.billed_state, new.billed_state;
    end if;
  end if;
  if new.tax_treatment is distinct from old.tax_treatment
     and not deedbox.valid_tax_treatment(new.tax_treatment) then
    raise exception 'tax treatment % is not a key of the active pack''s tax rules', new.tax_treatment;
  end if;
  if old.billed_state in ('on_draft','billed') then
    -- description stays correctable; the value-bearing fields freeze.
    if new.matter is distinct from old.matter
       or new.incurred_date is distinct from old.incurred_date
       or new.amount is distinct from old.amount
       or new.tax_treatment is distinct from old.tax_treatment
       or new.billable is distinct from old.billable then
      raise exception 'a drafted or billed item''s value fields are immutable';
    end if;
    if old.billed_state = 'billed' and new.bill_line is distinct from old.bill_line then
      raise exception 'a billed item never leaves its bill line';
    end if;
    if new.deleted_at is not null then
      raise exception 'only unbilled items soft-delete';
    end if;
  end if;
  if new.deleted_at is not null and old.deleted_at is null
     and old.billed_state <> 'unbilled' then
    raise exception 'only unbilled items soft-delete';
  end if;
  return new;
end $$;
create trigger disbursement_guard before insert or update or delete on deedbox.disbursement
for each row execute function deedbox.disbursement_guard();

commit;
