-- 0041: the issued-view set grows a BILLS view — a debt view for
-- package-side reporting jobs. Issued bills only, their money computed
-- from the bill's own append-only journal (issue_total = the issue entry;
-- outstanding = the signed sum, never below zero by the journal's own
-- guard), predicate-bound like every issued view: pl_views.visible() reads
-- the CALLER's stamped context through the definer wrapper, fail-closed.

create view pl_views.visible_bills as
  select b.id, b.matter, b.payer_party, b.bill_number, b.issue_date,
         b.terms_days_applied, b.due_date,
         coalesce(sum(e.signed_amount) filter (where e.entry_kind = 'issue_total'), 0) as issue_total,
         coalesce(sum(e.signed_amount), 0) as outstanding
    from deedbox.bill b
    left join deedbox.bill_journal_entry e on e.bill = b.id
   where b.state = 'issued' and pl_views.visible(b.matter)
   group by b.id;

-- provisioning bulk-grants cover only the views existing at provision
-- time: a NEW issued view re-grants to every live private-layer principal
do $$
declare r record;
begin
  for r in
    select rolname from pg_catalog.pg_roles
     where rolname ~ '^pl_[a-z0-9_]+$' and rolcanlogin
  loop
    execute format('grant select on pl_views.visible_bills to %I', r.rolname);
  end loop;
end $$;
