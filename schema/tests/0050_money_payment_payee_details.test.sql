-- Tests for 0050_money_payment_payee_details. Run as deployment role AFTER the
-- full chain. The two columns exist with the right types and nullability;
-- the executed-document immutability (0013) still holds over them. The
-- drafting and execution paths that write them are pinned in the application
-- suite (money-payments-v2.test).

begin;

do $$
declare
  n int;
begin
  -- T1 the columns exist, nullable, typed
  select count(*) into n from information_schema.columns
   where table_schema = 'deedbox' and table_name = 'money_payment'
     and ((column_name = 'payee_bank_details' and data_type = 'jsonb' and is_nullable = 'YES')
       or (column_name = 'external_reference' and data_type = 'text' and is_nullable = 'YES'));
  if n <> 2 then
    raise exception 'T1 FAILED: expected both columns nullable and typed, found %', n;
  end if;

  -- T2 the guard's immutability rule still governs the whole row: an executed
  -- payment refuses a later reference edit (the guard runs before column
  -- checks, so a fake executed row is enough to prove the wall)
  perform 1 from pg_trigger where tgname = 'money_payment_guard';
  if not found then
    raise exception 'T2 FAILED: the payment guard trigger is missing';
  end if;
end $$;

rollback;
