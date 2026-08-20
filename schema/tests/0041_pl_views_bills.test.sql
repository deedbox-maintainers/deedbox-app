-- Tests for 0041_pl_views_bills. Run as deployment role AFTER the full
-- chain. Proves: the view serves an issued bill's journal-computed money
-- under a visible context, hides everything without one (fail-closed), and
-- a provisioned private-layer principal holds select on it.

begin;

grant deedbox_app to current_user;

insert into deedbox.country_pack (code, name) values ('XVB','Bills View Test Pack');
insert into deedbox.firm (name, operating_currency, timezone, country_pack)
  select 'Bills View Test Firm','AUD','Australia/Sydney', id from deedbox.country_pack where code='XVB';
insert into deedbox.office (name, code) values ('VB Office','XVB1');

do $$
declare
  off bigint; rl bigint; st bigint; pa bigint; p1 bigint; m1 bigint; num text;
  bg bigint; b1 bigint; n int; total numeric; owing numeric;
begin
  select id into off from deedbox.office where code = 'XVB1';
  select id into rl from deedbox.role where system_key = 'administrator';
  insert into deedbox.staff_member (person_name, login, role, office, email)
    values ('{"given":"Vera","family":"Bills"}','vera.xvb', rl, off, 'vera.xvb@example.test')
    returning id into st;
  insert into deedbox.practice_area (name) values ('VB General') returning id into pa;
  insert into deedbox.party (kind, display_name) values ('person','VB Client') returning id into p1;
  insert into deedbox.party_name (party, name_kind, full_name) values (p1,'current','VB Client');
  num := deedbox.allocate_number('matter', null, current_date);
  insert into deedbox.matter (matter_number, title, client_party, responsible_lawyer, office, practice_area)
    values (num, 'VB matter', p1, st, off, pa) returning id into m1;

  insert into deedbox.bill_group (matter, matter_total, payer_share_snapshot)
    values (m1, 1000.00, '[]') returning id into bg;
  insert into deedbox.bill (bill_group, matter, payer_party) values (bg, m1, p1) returning id into b1;
  update deedbox.bill
     set state='issued', bill_number=deedbox.allocate_number('bill', null, current_date),
         issue_date=current_date, terms_days_applied=14, due_date=current_date+14,
         rendered_artefact='artefact:xvb'
   where id = b1;
  insert into deedbox.bill_journal_entry (bill, entry_kind, signed_amount, source_type, source, effective_date, entered_by)
    values (b1, 'issue_total', 1000.00, 'bill', b1, current_date, st);
  insert into deedbox.bill_journal_entry (bill, entry_kind, signed_amount, source_type, source, effective_date, entered_by)
    values (b1, 'payment_allocation', -400.00, 'payment', 1, current_date, st);

  -- T1: under a visible staff context the view serves the journal's money
  perform set_config('deedbox.principal_kind','staff',true),
          set_config('deedbox.principal_id', st::text, true);
  select count(*)::int, max(issue_total), max(outstanding)
    into n, total, owing
    from pl_views.visible_bills where id = b1;
  if n <> 1 then raise exception 'T1 FAIL: the issued bill is not served (% rows)', n; end if;
  if total <> 1000.00 then raise exception 'T1 FAIL: issue_total % <> 1000.00', total; end if;
  if owing <> 600.00 then raise exception 'T1 FAIL: outstanding % <> 600.00', owing; end if;

  -- T2: a DRAFT sibling never appears (issued-only discipline)
  insert into deedbox.bill (bill_group, matter, payer_party) values (bg, m1, p1);
  select count(*)::int into n from pl_views.visible_bills where matter = m1;
  if n <> 1 then raise exception 'T2 FAIL: a non-issued bill leaked (% rows)', n; end if;

  -- T3: no context = no rows (fail-closed, the predicate's own posture)
  perform set_config('deedbox.principal_kind','',true),
          set_config('deedbox.principal_id','',true);
  select count(*)::int into n from pl_views.visible_bills where id = b1;
  if n <> 0 then raise exception 'T3 FAIL: the view served % rows with no context', n; end if;

  -- T4: a provisioned principal holds select on the NEW view (the 0041
  -- re-grant; provision-time bulk grants could not have covered it had the
  -- role predated this change — proven the direct way: provision now, ask)
  perform deedbox.private_layer_provision('pl_xvb_pkg', 'a-secret-of-sufficient-length');
  if not has_table_privilege('pl_xvb_pkg', 'pl_views.visible_bills', 'select') then
    raise exception 'T4 FAIL: the provisioned principal cannot read the bills view';
  end if;

  raise notice '0041 suite: all assertions passed';
end $$;

rollback;
