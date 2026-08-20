-- Tests for 0037_gl_journal_number_purpose. Run as deployment role AFTER
-- the full chain. Proves the enum value landed and is orderable/usable.

begin;

do $$
begin
  if not exists (
    select 1 from pg_enum e
      join pg_type t on t.oid = e.enumtypid
      join pg_namespace n on n.oid = t.typnamespace
     where n.nspname = 'deedbox' and t.typname = 'number_purpose'
       and e.enumlabel = 'gl_journal') then
    raise exception 'T1 FAIL: number_purpose lacks gl_journal';
  end if;
  -- usable as a value (committed by the time suites run)
  perform 'gl_journal'::deedbox.number_purpose;
  raise notice '0037 suite: all assertions passed';
end $$;

rollback;
