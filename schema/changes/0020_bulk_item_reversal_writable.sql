-- 0020_bulk_item_reversal_writable — the app role can record per-item
-- reversal outcomes, and only that.
--
-- Found by the application layer while building the merge undo:
-- 0016 added reversal_outcome/block_reason to bulk_operation_item, but the
-- app role held select+insert only — the undo run had no sanctioned way to
-- write its itemised report. The grant is column-scoped and the guard makes
-- the mutation exactly one-shot: identity and before/after stay immutable,
-- an outcome is written once and never changed, a block reason accompanies
-- exactly the blocked outcome, and items are never deleted.

begin;

grant update (reversal_outcome, block_reason) on deedbox.bulk_operation_item to deedbox_app;

create or replace function deedbox.bulk_item_guard() returns trigger
language plpgsql as $$
begin
  if tg_op = 'DELETE' then
    raise exception 'bulk operation items are never deleted';
  end if;
  if tg_op = 'UPDATE' then
    if new.operation is distinct from old.operation
       or new.entity_type is distinct from old.entity_type
       or new.entity is distinct from old.entity
       or new.before is distinct from old.before
       or new.after is distinct from old.after then
      raise exception 'a bulk item''s identity and captured states are immutable';
    end if;
    if old.reversal_outcome is not null then
      raise exception 'an item''s reversal outcome is written once';
    end if;
    if new.reversal_outcome is null then
      raise exception 'the only permitted item mutation is recording its reversal outcome';
    end if;
    if (new.reversal_outcome = 'blocked') <> (new.block_reason is not null and new.block_reason <> '') then
      raise exception 'a block reason accompanies exactly the blocked outcome';
    end if;
  end if;
  return new;
end $$;
create trigger bulk_item_guard before update or delete on deedbox.bulk_operation_item
for each row execute function deedbox.bulk_item_guard();

commit;
