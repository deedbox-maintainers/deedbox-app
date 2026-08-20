-- Tests for 0052_client_account_bank_identifiers. Run as deployment role AFTER
-- the full chain. The column exists, nullable, jsonb; existing rows are
-- untouched (null). The requisition read that prints it is pinned in the
-- application suite (money-screens.test).

begin;

do $$
declare
  n int;
begin
  -- T1 the column exists, nullable, typed
  select count(*) into n from information_schema.columns
   where table_schema = 'deedbox' and table_name = 'client_account'
     and column_name = 'bank_identifiers' and data_type = 'jsonb' and is_nullable = 'YES';
  if n <> 1 then
    raise exception 'T1 FAILED: expected one nullable jsonb bank_identifiers column, found %', n;
  end if;

  -- T2 pre-existing rows are untouched: the column defaults to null
  select count(*) into n from information_schema.columns
   where table_schema = 'deedbox' and table_name = 'client_account'
     and column_name = 'bank_identifiers' and column_default is not null;
  if n <> 0 then
    raise exception 'T2 FAILED: bank_identifiers must carry no default';
  end if;
end $$;

rollback;
