-- Tests for 0056_bill_notice. Run as deployment role AFTER the full chain.
-- The two settings exist as text with blank neutral defaults; the issue-time
-- embedding and the document rendering are pinned in the application suite
-- (billing-tax.test / presentation.test).

begin;

do $$
declare
  n int;
begin
  select count(*) into n from deedbox.setting_definition
   where key in ('billing.bill_notice_heading', 'billing.bill_notice')
     and value_type = 'text' and neutral_default = '""'::jsonb;
  if n <> 2 then
    raise exception 'T1 FAILED: expected the two blank text notice settings, found %', n;
  end if;
end $$;

rollback;
