-- 0021_interest_charge_proposal — the parking home for system-computed
-- interest charges: system-computed charges park as proposals in the
-- interest panel until approved. The schema layer shipped interest_charge
-- with approval mandatory AT insert (0011) — correct for the posted record,
-- but it leaves the accrual job's unapproved computations homeless. This
-- change adds that home, found by the app layer while implementing the
-- interest operations.
--
-- A proposal is a working paper, not a financial record: it holds the
-- computation the job produced, waits for a human, and resolves exactly once
-- (approved with the posted charge's id, dismissed with a reason, or
-- superseded by a fresher computation). Terminal rows are immutable evidence
-- of what was proposed and who resolved it. Posting itself remains the
-- transaction against interest_charge + the bill journal — this table never
-- touches a figure.

begin;

create table deedbox.interest_charge_proposal (
    id bigint generated always as identity primary key,
    bill bigint not null references deedbox.bill(id),
    period_from date not null,
    period_to date not null,
    rate_pct_applied numeric(6,3) not null,
    amount numeric(14,2) not null check (amount > 0),
    computed_at timestamptz not null default now(),
    state text not null default 'pending'
      check (state in ('pending','approved','dismissed','superseded')),
    resolved_by bigint references deedbox.staff_member(id),
    resolved_at timestamptz,
    interest_charge bigint references deedbox.interest_charge(id),
    reason text,
    check (period_to >= period_from),
    check ((state = 'approved') <= (interest_charge is not null)),
    check ((state = 'dismissed') <= (reason is not null)),
    check ((state <> 'pending') <= (resolved_at is not null))
);

-- one pending proposal per bill: the job refreshes by superseding, never by
-- queue-stacking
create unique index interest_charge_proposal_one_pending
  on deedbox.interest_charge_proposal (bill) where state = 'pending';
create index interest_charge_proposal_state_idx
  on deedbox.interest_charge_proposal (state, computed_at);

grant select, insert, update on deedbox.interest_charge_proposal to deedbox_app;

create or replace function deedbox.interest_charge_proposal_guard() returns trigger
language plpgsql as $$
begin
  if tg_op = 'DELETE' then
    raise exception 'interest proposals are resolved, never deleted';
  end if;
  if tg_op = 'INSERT' then
    if new.state <> 'pending' then
      raise exception 'an interest proposal is born pending';
    end if;
    if new.resolved_by is not null or new.resolved_at is not null
       or new.interest_charge is not null then
      raise exception 'a pending proposal carries no resolution';
    end if;
    return new;
  end if;
  if old.state <> 'pending' then
    raise exception 'a resolved interest proposal is immutable';
  end if;
  if new.state = 'pending' then
    raise exception 'a proposal admits exactly one mutation: its resolution';
  end if;
  if new.bill is distinct from old.bill
     or new.period_from is distinct from old.period_from
     or new.period_to is distinct from old.period_to
     or new.rate_pct_applied is distinct from old.rate_pct_applied
     or new.amount is distinct from old.amount
     or new.computed_at is distinct from old.computed_at then
    raise exception 'the proposed computation is frozen; resolve it or supersede it';
  end if;
  if new.resolved_at is null then
    new.resolved_at := now();
  end if;
  return new;
end $$;
create trigger interest_charge_proposal_guard
before insert or update or delete on deedbox.interest_charge_proposal
for each row execute function deedbox.interest_charge_proposal_guard();

commit;
