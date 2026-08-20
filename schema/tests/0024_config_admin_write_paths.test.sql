-- Tests for 0024_config_admin_write_paths. Run as deployment role AFTER
-- 0001–0024. Proves: replacement supersedes without renumbering (the gapless
-- series continues exactly where it stood, across the pattern change);
-- grammar refusals; the register entry carries before/after; the app role
-- can hard-delete an unshipped, unused choice item and the shipped guard
-- still refuses.

begin;

grant deedbox_app to current_user;

insert into deedbox.country_pack (code, name) values ('XNF','Numbering Test Pack');
insert into deedbox.firm (name, operating_currency, timezone, country_pack)
  select 'Numbering Test Firm','AUD','Australia/Sydney', id from deedbox.country_pack where code='XNF';

do $$
declare
  n1 text; n2 text; n3 text;
  old_fmt bigint; new_fmt bigint;
  li bigint; it bigint;
begin
  -- T1: allocate twice on the shipped top_up_request format, replace the
  -- format with a new pattern, allocate again: the serial continues (no
  -- restart, no gap) under the new pattern.
  n1 := deedbox.allocate_number('top_up_request');
  n2 := deedbox.allocate_number('top_up_request');
  select id into old_fmt from deedbox.number_format
   where purpose = 'top_up_request' and active;

  new_fmt := deedbox.replace_number_format(
    'top_up_request', null, 'TUX-{SEQ:6}', 'gapless', 'never', 'staff', 1, null);

  if exists (select 1 from deedbox.number_format where id = old_fmt and active) then
    raise exception 'T1 FAIL: the superseded format is still active';
  end if;
  n3 := deedbox.allocate_number('top_up_request');
  if n3 not like 'TUX-%' then
    raise exception 'T1 FAIL: new pattern not in force (got %)', n3;
  end if;
  if substring(n3 from '\d+$')::bigint <> substring(n2 from '\d+$')::bigint + 1 then
    raise exception 'T1 FAIL: series restarted or gapped (% then %)', n2, n3;
  end if;

  -- T2: the register entry exists with before and after
  if not exists (
    select 1 from deedbox.register_entry
     where event_kind = 'numbering.format_changed'
       and subject = new_fmt
       and detail ? 'before' and detail ? 'after') then
    raise exception 'T2 FAIL: numbering.format_changed entry missing or bare';
  end if;

  -- T3: grammar refusals — no SEQ token; yearly without YEAR
  begin
    perform deedbox.replace_number_format('top_up_request', null, 'TU-PLAIN',
                                          'gapless', 'never', 'staff', 1, null);
    raise exception 'T3 FAIL: pattern without SEQ accepted';
  exception when others then
    if sqlerrm like '%T3 FAIL%' then raise; end if;
  end;
  begin
    perform deedbox.replace_number_format('top_up_request', null, 'TU-{SEQ:6}',
                                          'gapless', 'yearly', 'staff', 1, null);
    raise exception 'T3 FAIL: yearly reset without YEAR accepted';
  exception when others then
    if sqlerrm like '%T3 FAIL%' then raise; end if;
  end;

  -- T4: the app role can delete an unshipped, unreferenced choice item;
  -- the shipped guard still refuses deletion of a shipped item.
  insert into deedbox.choice_list (purpose_key, name)
    values ('custom.xnf.test', 'XNF test list') returning id into li;
  insert into deedbox.choice_item (list, label, position)
    values (li, 'Disposable', 1) returning id into it;
  set local role deedbox_app;
  perform set_config('deedbox.principal_kind','staff',true),
          set_config('deedbox.principal_id','1',true);
  delete from deedbox.choice_item where id = it;
  if not found then
    raise exception 'T4 FAIL: unshipped item delete did not take effect';
  end if;
  begin
    delete from deedbox.choice_item where shipped_key = 'chargeable';
    raise exception 'T4 FAIL: shipped item deletion accepted';
  exception when others then
    if sqlerrm like '%T4 FAIL%' then raise; end if;
  end;

  -- T5: the app role can read the counters (preview) but still not write them
  perform count(*) from deedbox.sequence_counter;
  begin
    update deedbox.sequence_counter set next_value = next_value where format is not null;
    raise exception 'T5 FAIL: the app role wrote a counter directly';
  exception when others then
    if sqlerrm like '%T5 FAIL%' then raise; end if;
  end;
  reset role;
  raise notice '0024 suite: all assertions passed';
end $$;

-- T6: pack activation works AS THE APP ROLE (the seventh found defect: 0002's
-- invoker-rights function was permission-refused for every real principal).
do $$
declare pk bigint; pv bigint;
begin
  select country_pack into pk from deedbox.firm limit 1;
  insert into deedbox.pack_version (pack, version) values (pk, 'xnf-suite-1') returning id into pv;
  insert into deedbox.pack_declaration (pack_version, rule_point, kind, body)
    values (pv, 'money.dormancy', 'value', '{"period_months": 12}');
  set local role deedbox_app;
  perform set_config('deedbox.principal_kind','staff',true),
          set_config('deedbox.principal_id','1',true);
  perform deedbox.activate_pack(pk, pv, 'staff', 1);
  reset role;
  if (select active_version from deedbox.country_pack where id = pk) is distinct from pv then
    raise exception 'T6 FAIL: activation as the app role did not take effect';
  end if;
  if not exists (select 1 from deedbox.register_entry
                  where event_kind = 'pack.activated' and subject = pk and privileged) then
    raise exception 'T6 FAIL: pack.activated entry missing';
  end if;
  raise notice '0024 suite T6 passed';
end $$;

rollback;
