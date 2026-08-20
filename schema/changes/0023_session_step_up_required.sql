-- 0023_session_step_up_required — a schema defect found by the security
-- tests.
--
-- A sign-in from an unrecognised device or novel location must create a
-- session that is unusable until step-up — every request except the step-up
-- challenge is refused. As built, the session row had no way to represent
-- that state: step_up_passed=false is every fresh session's default,
-- including recognised ones that are fully usable, and setting
-- step_up_passed=true at creation for recognised sessions would falsify the
-- dual-control freshness anchor (step_up_at) that money authorisations
-- assert against.
--
-- This change adds the explicit flag and one machine rule: the only way
-- out of required is passing the challenge — a session can never quietly
-- become usable.

begin;

alter table deedbox.session add column step_up_required boolean not null default false;

create or replace function deedbox.session_guard() returns trigger
language plpgsql as $$
begin
  if tg_op = 'DELETE' then
    raise exception 'sessions are never deleted';
  end if;
  if old.ended_at is not null then
    raise exception 'an ended session is terminal';
  end if;
  if old.step_up_required and not new.step_up_required and not new.step_up_passed then
    raise exception 'the only exit from a step-up requirement is passing the challenge';
  end if;
  return new;
end $$;

commit;
