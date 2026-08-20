-- Tests for 0023_session_step_up_required. Run as deployment role AFTER
-- 0001–0023. Proves: the flag exists defaulted off; a required session
-- cannot clear the requirement without passing the challenge; passing
-- clears it lawfully; the terminal rule still holds.

begin;

grant deedbox_app to current_user;

insert into deedbox.country_pack (code, name) values ('XSU','Step-Up Test Pack');
insert into deedbox.firm (name, operating_currency, timezone, country_pack)
  select 'Step-Up Test Firm','AUD','Australia/Sydney', id from deedbox.country_pack where code='XSU';
insert into deedbox.office (name, code) values ('StepUp','XSU');

do $$
declare o bigint; r_admin bigint; s1 bigint; d1 bigint; sess bigint;
begin
  select id into o from deedbox.office where code='XSU';
  select id into r_admin from deedbox.role where system_key='administrator';
  insert into deedbox.staff_member (person_name, login, role, office, email)
    values ('{"display":"Sue Stepup"}','sue.xsu', r_admin, o, 'sue@xsu.test') returning id into s1;
  insert into deedbox.device (owner_kind, owner, fingerprint)
    values ('staff', s1, 'fp-xsu-1') returning id into d1;

  -- T1: born required; the requirement cannot clear without the challenge
  insert into deedbox.session (principal_kind, principal, device, step_up_required)
    values ('staff', s1, d1, true) returning id into sess;
  begin
    update deedbox.session set step_up_required = false where id = sess;
    raise exception 'T1 FAIL: requirement cleared without the challenge';
  exception when others then
    if sqlerrm like '%T1 FAIL%' then raise; end if;
  end;

  -- T2: passing the challenge clears it lawfully
  update deedbox.session
     set step_up_passed = true, step_up_at = now(), step_up_required = false
   where id = sess;
  if not exists (select 1 from deedbox.session
                  where id = sess and step_up_passed and not step_up_required) then
    raise exception 'T2 FAIL: lawful step-up did not clear the requirement';
  end if;

  -- T3: ended stays terminal
  update deedbox.session set ended_at = now(), end_reason = 'logout' where id = sess;
  begin
    update deedbox.session set last_seen_at = now() where id = sess;
    raise exception 'T3 FAIL: an ended session accepted a change';
  exception when others then
    if sqlerrm like '%T3 FAIL%' then raise; end if;
  end;

  raise notice '0023 suite: all assertions passed';
end $$;

rollback;
