-- 0060 — reminders learn what the firm already holds.
--
-- A trust-accounting product demanding money it is already holding for the
-- client is a correctness problem, not a tone problem. The rule: a matter's
-- UNCOVERED arrears is what its issued bills still owe LESS the client
-- money the firm holds free for that matter (ledger balances minus active
-- set-asides, never below zero on either side).
--
-- The reminder scheduler consults it as a stop condition: while a bill's
-- matter is fully covered, the reminder parks in a new visible state,
-- `held_trust_cover`, advancing nothing — and the scheduler re-arms it the
-- moment cover lapses (the uniform resume rule; no step skipped, none
-- re-sent) or closes it `stopped_paid` when payment lands meanwhile. The
-- right next act on a covered matter is applying the held money to the
-- bill, not writing to the client.

create or replace function deedbox.matter_uncovered_arrears(p_matter bigint)
returns numeric language sql stable as $$
  select greatest(0,
    coalesce((select sum(deedbox.bill_outstanding(b.id))
                from deedbox.bill b
               where b.matter = p_matter and b.state = 'issued'
                 and deedbox.bill_outstanding(b.id) > 0), 0)
    - greatest(0,
        coalesce((select sum(deedbox.ledger_balance(l.id))
                    from deedbox.matter_ledger l
                   where l.matter = p_matter and l.ledger_kind = 'client_matter'), 0)
        - coalesce((select sum(e.amount)
                      from deedbox.earmark e
                      join deedbox.matter_ledger l on l.id = e.matter_ledger
                     where l.matter = p_matter and e.state = 'active'), 0)))
$$;
grant execute on function deedbox.matter_uncovered_arrears(bigint) to deedbox_app;

-- The parked state joins the catalogue…
alter table deedbox.bill_reminder_state drop constraint bill_reminder_state_status_check;
alter table deedbox.bill_reminder_state add constraint bill_reminder_state_status_check
  check (status in ('running','stopped_paid','stopped_arrangement','stopped_disputed',
                    'held_manual','held_trust_cover','exhausted'));

-- …the scheduler's re-arm scan stays cheap…
create index bill_reminder_trust_cover_idx
  on deedbox.bill_reminder_state (id) where status = 'held_trust_cover';

-- …and the transition guard admits exactly its three lawful hops: parked
-- from running, resumed to running, or closed paid while parked. (CREATE OR
-- REPLACE keeps the function's existing grants — never drop a granted
-- routine to change it.)
create or replace function deedbox.bill_reminder_state_guard() returns trigger
language plpgsql as $$
begin
  if tg_op = 'DELETE' then
    raise exception 'reminder state rows are never deleted';
  end if;
  if new.status is distinct from old.status then
    if not ( (old.status = 'running' and new.status in
                ('stopped_paid','stopped_arrangement','stopped_disputed',
                 'held_manual','held_trust_cover','exhausted'))
          or (old.status in ('stopped_paid','stopped_arrangement','stopped_disputed',
                             'held_manual','held_trust_cover')
              and new.status = 'running')
          or (old.status = 'held_trust_cover' and new.status = 'stopped_paid')
          or (old.status = 'exhausted' and new.status = 'running') ) then
      raise exception 'illegal reminder transition % -> %', old.status, new.status;
    end if;
    if new.status = 'running' then
      new.held_by := null; new.held_at := null; new.hold_reason := null;
    end if;
  end if;
  return new;
end $$;
