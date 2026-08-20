-- Tests for 0055_invoicing_by_lawyer_report. Run as deployment role AFTER
-- the full chain. The definition is seeded once with the right shape; the
-- builder's figures are pinned in the application suite (reports.test).

begin;

do $$
declare
  n int;
begin
  -- T1 seeded exactly once, admin/accounts visibility, own-figures capable,
  --    schedulable standard report
  select count(*) into n from deedbox.report_definition
   where key = 'invoicing_by_lawyer' and category = 'standard_report'
     and own_figures_scope_supported and schedulable
     and visibility_roles::jsonb ? 'administrator'
     and visibility_roles::jsonb ? 'accounts';
  if n <> 1 then
    raise exception 'T1 FAILED: invoicing_by_lawyer definition missing or mis-shaped (%)', n;
  end if;
end $$;

rollback;
