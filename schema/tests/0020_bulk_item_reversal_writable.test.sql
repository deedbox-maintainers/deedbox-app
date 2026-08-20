-- Tests for 0020_bulk_item_reversal_writable. Run as deployment role AFTER
-- 0001–0020. Proves the one-shot outcome discipline as the app role.

begin;

grant deedbox_app to current_user;

do $$
declare op bigint; item bigint;
begin
  set local role deedbox_app;
  perform set_config('deedbox.principal_kind','staff', true);
  perform set_config('deedbox.principal_id','1', true);

  insert into deedbox.bulk_operation (operation_kind, dry_run_summary, reversible_until, committed_at, committed_by)
    values ('test_kind', '{}', now() + interval '7 days', now(), null)
    returning id into op;
  insert into deedbox.bulk_operation_item (operation, entity_type, entity, before, after)
    values (op, 'test_entity', 900301, '{"v":1}', '{"v":2}') returning id into item;

  -- T1: identity/state immutable.
  begin
    update deedbox.bulk_operation_item set entity = 900302 where id = item;
    raise exception 'T1-FAILED: item identity mutated';
  exception when others then
    if sqlerrm like '%T1-FAILED%' then raise; end if;
  end;

  -- T2: blocked demands its reason; reversed refuses one.
  begin
    update deedbox.bulk_operation_item set reversal_outcome = 'blocked' where id = item;
    raise exception 'T2-FAILED: blocked without reason accepted';
  exception when others then
    if sqlerrm like '%T2-FAILED%' then raise; end if;
  end;

  -- T3: the one sanctioned mutation lands.
  update deedbox.bulk_operation_item set reversal_outcome = 'reversed' where id = item;

  -- T4: once written, never changed.
  begin
    update deedbox.bulk_operation_item
       set reversal_outcome = 'blocked', block_reason = 'later change' where id = item;
    raise exception 'T4-FAILED: outcome rewritten';
  exception when others then
    if sqlerrm like '%T4-FAILED%' then raise; end if;
  end;

  -- T5: never deleted.
  begin
    delete from deedbox.bulk_operation_item where id = item;
    raise exception 'T5-FAILED: item deleted';
  exception when others then
    if sqlerrm like '%T5-FAILED%' then raise; end if;
  end;

  reset role;
end $$;

rollback;
