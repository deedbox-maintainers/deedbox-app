-- 0009_billing_guardrails — the forecasting-and-guardrail layer: billing
-- holds with the transactional matter mirror, cost estimates and their
-- append-only revision history, budgets with one-active-per-scope
-- supersession, the matter funds policy, and the one generic
-- one-shot-per-threshold alert mechanism. This change ships the row-level
-- mechanics; the measures, outbound messages and top-up generation are
-- app-layer, later slices.
--
-- Implementation notes:
--   * cost_estimate.current_amount and arming_version move only under the
--     maintenance ceremony (session flag deedbox.estimate_maintenance),
--     which the revision trigger itself sets — the column can never drift
--     from the revision history; alert_thresholds stays user-editable.
--   * A creation's revision 1 sets the amount without bumping the arming
--     version (an estimate is born armed at 1; re-arming is for revisions).
--   * budget.stage is a bare column until the workflow domain lands.
--   * Budget rows are immutable except the active flag, and that moves in
--     one direction (supersession deactivates; a new row replaces).
--   * The funds policy's setting-seeded defaults are supplied by the
--     operation; the schema requires explicit values.
--   * threshold_alert uniqueness includes subject_type on top of the
--     (subject, pct, arming) triple — two subject tables can share an id.

begin;

------------------------------------------------------------------------------
-- billing_hold — one open hold per matter; the matter mirrors it.
------------------------------------------------------------------------------
create table deedbox.billing_hold (
    id bigint generated always as identity primary key,
    matter bigint not null references deedbox.matter(id),
    reason text not null check (reason <> ''),
    placed_by bigint not null references deedbox.staff_member(id),
    placed_at timestamptz not null default now(),
    released_by bigint references deedbox.staff_member(id),
    released_at timestamptz,
    check ((released_by is null) = (released_at is null))
);
create unique index billing_hold_one_open
  on deedbox.billing_hold (matter) where released_at is null;
grant select, insert, update on deedbox.billing_hold to deedbox_app;

create or replace function deedbox.billing_hold_guard() returns trigger
language plpgsql as $$
begin
  if tg_op = 'DELETE' then
    raise exception 'billing holds are a permanent record and are never deleted';
  end if;
  if tg_op = 'UPDATE' then
    if old.released_at is not null then
      raise exception 'a released billing hold is immutable';
    end if;
    if new.matter is distinct from old.matter
       or new.reason is distinct from old.reason
       or new.placed_by is distinct from old.placed_by
       or new.placed_at is distinct from old.placed_at then
      raise exception 'a billing hold admits exactly one mutation: its release';
    end if;
    if new.released_at is null then
      raise exception 'a billing hold admits exactly one mutation: its release';
    end if;
  end if;
  return new;
end $$;
create trigger billing_hold_guard before update or delete on deedbox.billing_hold
for each row execute function deedbox.billing_hold_guard();

create or replace function deedbox.billing_hold_mirror() returns trigger
language plpgsql as $$
declare m bigint;
begin
  m := coalesce(new.matter, old.matter);
  update deedbox.matter mt
     set billing_hold = exists (select 1 from deedbox.billing_hold h
                                 where h.matter = m and h.released_at is null)
   where mt.id = m;
  return null;
end $$;
create trigger billing_hold_mirror after insert or update on deedbox.billing_hold
for each row execute function deedbox.billing_hold_mirror();

------------------------------------------------------------------------------
-- The client-facing estimate and its provable revision history.
------------------------------------------------------------------------------
create table deedbox.cost_estimate (
    id bigint generated always as identity primary key,
    matter bigint not null unique references deedbox.matter(id),
    current_amount numeric(14,2) not null check (current_amount >= 0),
    alert_thresholds jsonb not null,
    arming_version int not null default 1,
    created_at timestamptz not null default now()
);
grant select, insert, update on deedbox.cost_estimate to deedbox_app;

create table deedbox.estimate_revision (
    id bigint generated always as identity primary key,
    estimate bigint not null references deedbox.cost_estimate(id),
    revision_no int not null,
    amount numeric(14,2) not null check (amount >= 0),
    revised_at timestamptz not null default now(),
    author bigint not null references deedbox.staff_member(id),
    reason text not null check (reason <> ''),
    unique (estimate, revision_no)
);
create index estimate_revision_estimate_idx on deedbox.estimate_revision (estimate, revision_no desc);
grant select, insert on deedbox.estimate_revision to deedbox_app;
create trigger estimate_revision_append_only before update or delete on deedbox.estimate_revision
for each row execute function deedbox.append_only_guard();

create or replace function deedbox.cost_estimate_guard() returns trigger
language plpgsql as $$
begin
  if tg_op = 'DELETE' then
    raise exception 'estimates are never deleted (the history is the record)';
  end if;
  if (new.current_amount is distinct from old.current_amount
      or new.arming_version is distinct from old.arming_version)
     and coalesce(current_setting('deedbox.estimate_maintenance', true), '') <> 'on' then
    raise exception 'the estimate amount moves only through a revision';
  end if;
  if new.matter is distinct from old.matter then
    raise exception 'an estimate never moves to another matter';
  end if;
  return new;
end $$;
create trigger cost_estimate_guard before update or delete on deedbox.cost_estimate
for each row execute function deedbox.cost_estimate_guard();

create or replace function deedbox.estimate_revision_apply() returns trigger
language plpgsql as $$
begin
  perform set_config('deedbox.estimate_maintenance', 'on', true);
  update deedbox.cost_estimate e
     set current_amount = new.amount,
         arming_version = case when new.revision_no > 1 then e.arming_version + 1
                               else e.arming_version end
   where e.id = new.estimate;
  perform set_config('deedbox.estimate_maintenance', 'off', true);
  return null;
end $$;

create or replace function deedbox.estimate_revision_number() returns trigger
language plpgsql as $$
begin
  new.revision_no := coalesce(
    (select max(r.revision_no) from deedbox.estimate_revision r where r.estimate = new.estimate), 0) + 1;
  return new;
end $$;
create trigger a_estimate_revision_number before insert on deedbox.estimate_revision
for each row execute function deedbox.estimate_revision_number();
create trigger z_estimate_revision_apply after insert on deedbox.estimate_revision
for each row execute function deedbox.estimate_revision_apply();

------------------------------------------------------------------------------
-- Budgets — one active per scope; superseded, never edited.
------------------------------------------------------------------------------
create table deedbox.budget (
    id bigint generated always as identity primary key,
    matter bigint not null references deedbox.matter(id),
    level text not null check (level in ('matter','stage')),
    stage bigint,          -- FK lands with the workflow domain
    amount numeric(14,2) not null check (amount >= 0),
    thresholds jsonb not null,
    recipients jsonb not null,
    active boolean not null default true,
    arming_version int not null default 1,
    created_at timestamptz not null default now(),
    created_by bigint,
    check ((level = 'stage') = (stage is not null))
);
create unique index budget_one_active_per_scope
  on deedbox.budget (matter, level, coalesce(stage, -1)) where active;
create index budget_matter_idx on deedbox.budget (matter);
grant select, insert, update on deedbox.budget to deedbox_app;

create or replace function deedbox.budget_guard() returns trigger
language plpgsql as $$
begin
  if tg_op = 'DELETE' then
    raise exception 'budgets are superseded, never deleted';
  end if;
  if new.active and not old.active then
    raise exception 'a superseded budget never reactivates; set a new budget';
  end if;
  if new.matter is distinct from old.matter
     or new.level is distinct from old.level
     or new.stage is distinct from old.stage
     or new.amount is distinct from old.amount
     or new.thresholds is distinct from old.thresholds
     or new.recipients is distinct from old.recipients
     or new.arming_version is distinct from old.arming_version then
    raise exception 'budget rows are immutable; supersede with a new row';
  end if;
  return new;
end $$;
create trigger budget_guard before update or delete on deedbox.budget
for each row execute function deedbox.budget_guard();

------------------------------------------------------------------------------
-- The matter funds policy — the one mutable policy row.
------------------------------------------------------------------------------
create table deedbox.matter_funds_policy (
    id bigint generated always as identity primary key,
    matter bigint not null unique references deedbox.matter(id),
    minimum_threshold numeric(14,2) not null check (minimum_threshold >= 0),
    target_amount numeric(14,2) not null,
    attach_to_next_bill boolean not null,
    auto_issue boolean not null,
    arming_version int not null default 1,
    created_at timestamptz not null default now(),
    check (target_amount >= minimum_threshold)
);
grant select, insert, update on deedbox.matter_funds_policy to deedbox_app;

------------------------------------------------------------------------------
-- threshold_alert — fires once per threshold per arming, structurally.
------------------------------------------------------------------------------
create table deedbox.threshold_alert (
    id bigint generated always as identity primary key,
    subject_type text not null check (subject_type in ('budget','estimate','funds_policy')),
    subject bigint not null,
    threshold_pct int not null,
    arming_version int not null,
    fired_at timestamptz not null default now(),
    recipients jsonb not null,
    unique (subject_type, subject, threshold_pct, arming_version)
);
create index threshold_alert_subject_idx
  on deedbox.threshold_alert (subject_type, subject, arming_version);
grant select, insert on deedbox.threshold_alert to deedbox_app;
create trigger threshold_alert_append_only before update or delete on deedbox.threshold_alert
for each row execute function deedbox.append_only_guard();

commit;
