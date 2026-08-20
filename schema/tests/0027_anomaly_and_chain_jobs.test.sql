-- Tests for 0027_anomaly_and_chain_jobs. Run as deployment role AFTER
-- 0001–0027. Proves: the app role writes cursors but can never rewind one;
-- the chain_break rule exists; the detail verifier walks clean from genesis
-- AND from a checkpoint, and the wrapper still returns the plain count.

begin;

grant deedbox_app to current_user;

insert into deedbox.country_pack (code, name) values ('XCJ','Chain Jobs Test Pack');
insert into deedbox.firm (name, operating_currency, timezone, country_pack)
  select 'Chain Jobs Test Firm','AUD','Australia/Sydney', id from deedbox.country_pack where code='XCJ';

do $$
declare
  f bigint; r bigint; d record; w bigint; mid_seq bigint;
begin
  select id into f from deedbox.firm where name = 'Chain Jobs Test Firm';
  select id into r from deedbox.anomaly_rule where key = 'repeated_sign_in_failure';

  -- T1: the chain_break rule is seeded and active
  if not exists (select 1 from deedbox.anomaly_rule where key = 'chain_break' and active) then
    raise exception 'T1 FAIL: chain_break rule missing';
  end if;

  -- T2: the app role writes a cursor forward but can never rewind it
  set local role deedbox_app;
  perform set_config('deedbox.principal_kind','system_job',true),
          set_config('deedbox.principal_id','18',true);
  insert into deedbox.anomaly_cursor (rule, last_seq) values (r, 10);
  update deedbox.anomaly_cursor set last_seq = 25 where rule = r;
  begin
    update deedbox.anomaly_cursor set last_seq = 5 where rule = r;
    raise exception 'T2 FAIL: a cursor rewind was accepted';
  exception when others then
    if sqlerrm like '%T2 FAIL%' then raise; end if;
  end;
  reset role;

  -- T3: a fresh firm's chain verifies clean from genesis and from a
  -- mid-chain checkpoint; the wrapper agrees
  set local role deedbox_app;
  perform set_config('deedbox.principal_kind','system_job',true),
          set_config('deedbox.principal_id','18',true);
  insert into deedbox.register_entry (firm, actor_kind, actor, event_kind, subject_type, subject)
    values (f, 'system_job', 18, 'record.created', 'anomaly_rule', r);
  insert into deedbox.register_entry (firm, actor_kind, actor, event_kind, subject_type, subject)
    values (f, 'system_job', 18, 'record.created', 'anomaly_rule', r);
  insert into deedbox.register_entry (firm, actor_kind, actor, event_kind, subject_type, subject)
    values (f, 'system_job', 18, 'record.created', 'anomaly_rule', r);
  reset role;

  select * into d from deedbox.register_verify_chain_detail(f, 0);
  if d.breaks <> 0 or d.first_bad_seq is not null then
    raise exception 'T3 FAIL: fresh chain reported breaks (%, first %)', d.breaks, d.first_bad_seq;
  end if;
  select seq into mid_seq from deedbox.register_entry where firm = f order by seq limit 1 offset 1;
  select * into d from deedbox.register_verify_chain_detail(f, mid_seq);
  if d.breaks <> 0 then
    raise exception 'T3 FAIL: checkpoint walk reported breaks (%)', d.breaks;
  end if;
  if d.last_seq <= mid_seq then
    raise exception 'T3 FAIL: checkpoint walk did not advance (last %)', d.last_seq;
  end if;
  select deedbox.register_verify_chain(f) into w;
  if w <> 0 then
    raise exception 'T3 FAIL: the wrapper disagrees (%)', w;
  end if;

  raise notice '0027 suite: all assertions passed';
end $$;

rollback;
