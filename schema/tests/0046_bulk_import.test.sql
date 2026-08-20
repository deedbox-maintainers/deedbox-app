-- Tests for 0046_bulk_import. Run as deployment role AFTER the full chain.
-- Proves the bulk pipeline reproduces the per-record pipeline's semantics:
-- staging, per-record verdicts with the same texts, validate-only persisting
-- nothing but its evidence, real batches writing rows + registers + source
-- references, repeat-safety warnings, the documented template refusal,
-- client money all-or-nothing with the refusal-capture shape, and the
-- capability gate. Bulk calls run under the app role with the principal
-- context set — the same posture as live operations.

begin;

grant deedbox_app to current_user;

insert into deedbox.country_pack (code, name) values ('XB6', 'Bulk Test Pack');
insert into deedbox.firm (name, operating_currency, timezone, country_pack)
  select 'Bulk Test Firm', 'AUD', 'Australia/Sydney', id
    from deedbox.country_pack where code = 'XB6';
insert into deedbox.office (name, code) values ('Bulk Office', 'XB61');
insert into deedbox.practice_area (name) values ('Bulk General');
insert into deedbox.practice_area (name) values ('Bulk Templated');
insert into deedbox.client_account (name, account_kind)
  values ('Bulk Test Trust Account', 'pooled');

do $$
declare
  v_firm bigint; v_office bigint; v_role bigint; v_actor bigint; v_area bigint;
  v_area_t bigint; v_account bigint; v_norole bigint; v_nobody bigint;
  v_out record; v_n int; v_b int; v_msg text; v_dtl text;
  v_party bigint; v_matter bigint; v_doc bigint; v_before int;
  v_bal numeric; v_num text;
begin
  select f.id into v_firm from deedbox.firm f where f.name = 'Bulk Test Firm';
  select o.id into v_office from deedbox.office o where o.code = 'XB61';
  select r.id into v_role from deedbox.role r where r.system_key = 'administrator';
  select a.id into v_area from deedbox.practice_area a where a.name = 'Bulk General';
  select a.id into v_area_t from deedbox.practice_area a where a.name = 'Bulk Templated';
  select c.id into v_account from deedbox.client_account c where c.name = 'Bulk Test Trust Account';
  insert into deedbox.staff_member (person_name, login, role, office, email)
    values ('{"given":"Bulk","family":"Actor"}', 'bulk.actor', v_role, v_office,
            'bulk.actor@example.test') returning id into v_actor;
  insert into deedbox.workflow_template (practice_area, name, active)
    values (v_area_t, 'Bulk Refusal Template', true);

  perform set_config('deedbox.principal_kind', 'staff', true);
  perform set_config('deedbox.principal_id', v_actor::text, true);

  -- T1 clients: validate persists nothing but its evidence; real lands with
  --    register + source reference; a re-run warns instead of duplicating.
  perform deedbox.bulk_stage('t1', jsonb_build_array(
    jsonb_build_object('source_ref', 'c1', 'data', jsonb_build_object(
      'full_name', 'Quentin ("Q") Bulk', 'phone', '0400000001')),
    jsonb_build_object('source_ref', 'c2', 'data', jsonb_build_object(
      'full_name', 'Plain Bulk Client'))));
  select count(*)::int into v_before from deedbox.party;

  set local role deedbox_app;
  v_n := 0; v_b := 0;
  for v_out in select * from deedbox.bulk_apply('clients', 'bulk-test', 't1',
                                                'validate_only', null, v_actor, v_firm) loop
    v_n := v_n + 1;
    if v_out.disposition = 'accepted' then v_b := v_b + 1; end if;
  end loop;
  reset role;
  if v_n <> 2 or v_b <> 2 then
    raise exception 'T1 FAILED: validate verdicts % accepted of %', v_b, v_n;
  end if;
  select count(*)::int into v_n from deedbox.party;
  if v_n <> v_before then
    raise exception 'T1 FAILED: a validate-only batch persisted % new parties', v_n - v_before;
  end if;
  perform 1 from deedbox.import_batch b
   where b.record_domain = 'clients' and b.mode = 'validate_only' and b.state = 'completed';
  if not found then
    raise exception 'T1 FAILED: the validate batch row did not survive';
  end if;

  set local role deedbox_app;
  v_n := 0;
  for v_out in select * from deedbox.bulk_apply('clients', 'bulk-test', 't1',
                                                'real', null, v_actor, v_firm) loop
    if v_out.disposition = 'accepted' then v_n := v_n + 1; end if;
  end loop;
  reset role;
  if v_n <> 2 then
    raise exception 'T1 FAILED: the real batch accepted % of 2', v_n;
  end if;
  select h.o_target into v_party from deedbox.bulk_source_hit('bulk-test', 'c1', 'party') h;
  if v_party is null then
    raise exception 'T1 FAILED: no source reference for c1';
  end if;
  perform 1 from deedbox.register_entry e
   where e.subject_type = 'party' and e.subject = v_party and e.event_kind = 'record.created';
  if not found then
    raise exception 'T1 FAILED: the party creation did not register';
  end if;
  perform 1 from deedbox.party_name pn where pn.party = v_party
     and pn.full_name = 'Quentin ("Q") Bulk' and pn.name_kind = 'current';
  if not found then
    raise exception 'T1 FAILED: the quoted name did not land intact';
  end if;

  set local role deedbox_app;
  v_msg := null;
  for v_out in select * from deedbox.bulk_apply('clients', 'bulk-test', 't1',
                                                'real', null, v_actor, v_firm) loop
    if v_out.source_ref = 'c2' then v_msg := v_out.message; end if;
    if v_out.disposition = 'accepted' then
      raise exception 'T1 FAILED: a re-run accepted an already-imported client';
    end if;
  end loop;
  reset role;
  if v_msg is distinct from 'already imported; no changes' then
    raise exception 'T1 FAILED: re-run warning read %, not the repeat-safety text', v_msg;
  end if;

  -- T2 matters: source-ref client resolution, closed import closes through
  --    the ported direct path, the prior reference stamps, an unresolved
  --    client refuses with the per-record text, and an active workflow
  --    template refuses with the documented deviation text.
  perform deedbox.bulk_stage('t2', jsonb_build_array(
    jsonb_build_object('source_ref', 'm1', 'data', jsonb_build_object(
      'title', 'Bulk Matter One', 'client_source_ref', 'c1',
      'responsible_lawyer_login', 'bulk.actor', 'office_code', 'XB61',
      'practice_area_name', 'Bulk General', 'prior_reference', 'OLD-77',
      'status', 'closed')),
    jsonb_build_object('source_ref', 'm2', 'data', jsonb_build_object(
      'title', 'Bulk Matter Two', 'client_source_ref', 'c2',
      'responsible_lawyer_login', 'bulk.actor', 'office_code', 'XB61',
      'practice_area_name', 'Bulk General')),
    jsonb_build_object('source_ref', 'm3', 'data', jsonb_build_object(
      'title', 'Bulk Matter Three', 'client_source_ref', 'ghost',
      'responsible_lawyer_login', 'bulk.actor', 'office_code', 'XB61',
      'practice_area_name', 'Bulk General')),
    jsonb_build_object('source_ref', 'm4', 'data', jsonb_build_object(
      'title', 'Bulk Matter Four', 'client_source_ref', 'c1',
      'responsible_lawyer_login', 'bulk.actor', 'office_code', 'XB61',
      'practice_area_name', 'Bulk Templated'))));
  set local role deedbox_app;
  v_n := 0;
  for v_out in select * from deedbox.bulk_apply('matters', 'bulk-test', 't2',
                                                'real', null, v_actor, v_firm) loop
    if v_out.source_ref in ('m1','m2') and v_out.disposition <> 'accepted' then
      raise exception 'T2 FAILED: % refused: %', v_out.source_ref, v_out.message;
    end if;
    if v_out.source_ref = 'm3' then
      if v_out.disposition <> 'refused'
         or v_out.message <> 'client source reference ghost has not been imported' then
        raise exception 'T2 FAILED: m3 verdict % / %', v_out.disposition, v_out.message;
      end if;
    end if;
    if v_out.source_ref = 'm4' then
      if v_out.disposition <> 'refused' or v_out.message not like '%active workflow template%' then
        raise exception 'T2 FAILED: the template deviation did not refuse (m4: % / %)',
          v_out.disposition, v_out.message;
      end if;
    end if;
    v_n := v_n + 1;
  end loop;
  reset role;
  if v_n <> 4 then raise exception 'T2 FAILED: % verdicts of 4', v_n; end if;
  select h.o_target into v_matter from deedbox.bulk_source_hit('bulk-test', 'm1', 'matter') h;
  perform 1 from deedbox.matter m
   where m.id = v_matter and m.status = 'closed' and m.prior_reference = 'OLD-77';
  if not found then
    raise exception 'T2 FAILED: m1 did not close with its prior reference';
  end if;
  perform 1 from deedbox.matter_close_request q where q.matter = v_matter and q.state = 'approved';
  if not found then
    raise exception 'T2 FAILED: the closed import left no approved close request';
  end if;

  -- T3 time: a timed entry at a manual rate lands at the exact value and
  --    registers.
  select h.o_target into v_matter from deedbox.bulk_source_hit('bulk-test', 'm2', 'matter') h;
  perform deedbox.bulk_stage('t3', jsonb_build_array(
    jsonb_build_object('source_ref', 'te1', 'data', jsonb_build_object(
      'matter', v_matter, 'staff_login', 'bulk.actor', 'work_date', '2024-01-15',
      'kind', 'timed', 'units', 3, 'manual_rate', 400, 'narrative', 'bulk time probe'))));
  set local role deedbox_app;
  for v_out in select * from deedbox.bulk_apply('time', 'bulk-test', 't3',
                                                'real', null, v_actor, v_firm) loop
    if v_out.disposition <> 'accepted' then
      raise exception 'T3 FAILED: refused: %', v_out.message;
    end if;
  end loop;
  reset role;
  perform 1 from deedbox.time_entry te
   where te.matter = v_matter and te.value = 120.00 and te.origin = 'import';
  if not found then
    raise exception 'T3 FAILED: the timed value did not land at 120.00';
  end if;
  perform 1 from deedbox.register_entry e
   where e.subject_type = 'time_entry' and e.event_kind = 'record.created' and e.matter = v_matter;
  if not found then
    raise exception 'T3 FAILED: the time entry did not register';
  end if;

  -- T4 bills: the journal replays and the outstanding figure reports; a
  --    lines-versus-total mismatch refuses to the cent.
  perform deedbox.bulk_stage('t4', jsonb_build_array(
    jsonb_build_object('source_ref', 'b1', 'data', jsonb_build_object(
      'matter', v_matter, 'bill_number', 'OLDB-1', 'issue_date', '2024-02-01',
      'terms_days', 14,
      'lines', jsonb_build_array(jsonb_build_object('description', 'work', 'net', 90, 'tax', 10)),
      'journal', jsonb_build_array(
        jsonb_build_object('kind', 'issue_total', 'amount', 100, 'date', '2024-02-01'),
        jsonb_build_object('kind', 'payment_allocation', 'amount', -40, 'date', '2024-03-01')))),
    jsonb_build_object('source_ref', 'b2', 'data', jsonb_build_object(
      'matter', v_matter, 'bill_number', 'OLDB-2', 'issue_date', '2024-02-01',
      'terms_days', 14,
      'lines', jsonb_build_array(jsonb_build_object('description', 'work', 'net', 50, 'tax', 5)),
      'journal', jsonb_build_array(
        jsonb_build_object('kind', 'issue_total', 'amount', 100, 'date', '2024-02-01'))))));
  set local role deedbox_app;
  for v_out in select * from deedbox.bulk_apply('bills', 'bulk-test', 't4',
                                                'real', null, v_actor, v_firm) loop
    if v_out.source_ref = 'b1' then
      if v_out.disposition <> 'accepted' or v_out.message <> 'outstanding 60.00' then
        raise exception 'T4 FAILED: b1 % / %', v_out.disposition, v_out.message;
      end if;
    end if;
    if v_out.source_ref = 'b2' then
      if v_out.disposition <> 'refused' or v_out.message not like '%must reproduce to the cent%' then
        raise exception 'T4 FAILED: b2 mismatch did not refuse (% / %)',
          v_out.disposition, v_out.message;
      end if;
    end if;
  end loop;
  reset role;

  -- T5 documents: a folder record, then a two-version document whose second
  --    version's text is current in the search index.
  perform deedbox.bulk_stage('t5', jsonb_build_array(
    jsonb_build_object('source_ref', 'f1', 'data', jsonb_build_object(
      'record_kind', 'folder', 'matter', v_matter, 'path', 'Correspondence/Inbound')),
    jsonb_build_object('source_ref', 'd1', 'data', jsonb_build_object(
      'record_kind', 'document', 'matter', v_matter,
      'folder_path', 'Correspondence/Inbound', 'title', 'Bulk Letter',
      'versions', jsonb_build_array(
        jsonb_build_object('filename', 'letter-v1.pdf', 'size_bytes', 100,
          'storage_ref', 'bulk/letter-v1.pdf', 'uploaded_at', '2024-01-01T00:00:00Z',
          'extracted_text', 'first version text'),
        jsonb_build_object('filename', 'letter-v2.pdf', 'size_bytes', 120,
          'storage_ref', 'bulk/letter-v2.pdf', 'uploaded_at', '2024-01-02T00:00:00Z',
          'extracted_text', 'second version text'))))));
  set local role deedbox_app;
  for v_out in select * from deedbox.bulk_apply('documents', 'bulk-test', 't5',
                                                'real', null, v_actor, v_firm) loop
    if v_out.disposition <> 'accepted' then
      raise exception 'T5 FAILED: % refused: %', v_out.source_ref, v_out.message;
    end if;
  end loop;
  reset role;
  select h.o_target into v_doc from deedbox.bulk_source_hit('bulk-test', 'd1', 'document') h;
  select count(*)::int into v_n from deedbox.document_version dv where dv.document = v_doc;
  if v_n <> 2 then raise exception 'T5 FAILED: % versions of 2', v_n; end if;
  perform 1 from deedbox.document d
   where d.id = v_doc and d.current_version = 2;
  if not found then raise exception 'T5 FAILED: version 2 is not current'; end if;
  perform 1 from deedbox.search_index si
   where si.entry_type = 'document' and si.source = v_doc
     and si.body like '%second version text%';
  if not found then
    raise exception 'T5 FAILED: the search index does not carry the current text';
  end if;

  -- T6 notes: a note lands and registers; an unknown author refuses with the
  --    per-record text.
  perform deedbox.bulk_stage('t6', jsonb_build_array(
    jsonb_build_object('source_ref', 'n1', 'data', jsonb_build_object(
      'matter', v_matter, 'body', 'bulk note probe')),
    jsonb_build_object('source_ref', 'n2', 'data', jsonb_build_object(
      'matter', v_matter, 'body', 'ghost note', 'author_login', 'nobody.here'))));
  set local role deedbox_app;
  for v_out in select * from deedbox.bulk_apply('notes', 'bulk-test', 't6',
                                                'real', null, v_actor, v_firm) loop
    if v_out.source_ref = 'n1' and v_out.disposition <> 'accepted' then
      raise exception 'T6 FAILED: n1 refused: %', v_out.message;
    end if;
    if v_out.source_ref = 'n2' then
      if v_out.disposition <> 'refused'
         or v_out.message <> 'n2: no staff member with login nobody.here' then
        raise exception 'T6 FAILED: n2 verdict % / %', v_out.disposition, v_out.message;
      end if;
    end if;
  end loop;
  reset role;

  -- T7 client money: a clean replay lands to the cent; an overdrawing replay
  --    aborts whole, carries its outcomes in the error detail, and the
  --    refusal recorder commits the evidence.
  perform deedbox.bulk_stage('t7good', jsonb_build_array(
    jsonb_build_object('source_ref', 'mv1', 'data', jsonb_build_object(
      'kind', 'receipt', 'matter', v_matter, 'amount', 500,
      'effective_date', '2024-01-10', 'entered_at', '2024-01-10T00:00:00Z',
      'payer_description', 'Bulk Payer')),
    jsonb_build_object('source_ref', 'mv2', 'data', jsonb_build_object(
      'kind', 'payment_out', 'matter', v_matter, 'amount', 200,
      'effective_date', '2024-01-11', 'entered_at', '2024-01-11T00:00:00Z',
      'payee', 'Bulk Payee'))));
  set local role deedbox_app;
  for v_out in select * from deedbox.bulk_apply('client_money_full_history', 'bulk-test',
                't7good', 'real', null, v_actor, v_firm, v_account) loop
    if v_out.disposition <> 'accepted' then
      raise exception 'T7 FAILED: % %: %', v_out.source_ref, v_out.disposition, v_out.message;
    end if;
  end loop;
  reset role;
  select deedbox.ledger_balance(l.id) into v_bal from deedbox.matter_ledger l
   where l.matter = v_matter and l.account = v_account and l.ledger_kind = 'client_matter';
  if v_bal <> 300.00 then
    raise exception 'T7 FAILED: the ledger balance is %, not 300.00', v_bal;
  end if;

  perform deedbox.bulk_stage('t7bad', jsonb_build_array(
    jsonb_build_object('source_ref', 'mv3', 'data', jsonb_build_object(
      'kind', 'receipt', 'matter', v_matter, 'amount', 50,
      'effective_date', '2024-02-10', 'entered_at', '2024-02-10T00:00:00Z')),
    jsonb_build_object('source_ref', 'mv4', 'data', jsonb_build_object(
      'kind', 'payment_out', 'matter', v_matter, 'amount', 10000,
      'effective_date', '2024-02-11', 'entered_at', '2024-02-11T00:00:00Z'))));
  v_msg := null; v_dtl := null;
  begin
    set local role deedbox_app;
    perform * from deedbox.bulk_apply('client_money_full_history', 'bulk-test',
              't7bad', 'real', null, v_actor, v_firm, v_account);
    reset role;
    raise exception 'T7 FAILED: an overdrawing replay did not refuse';
  exception when others then
    reset role;
    v_msg := sqlerrm;
    get stacked diagnostics v_dtl = pg_exception_detail;
    if v_msg like 'T7 FAILED%' then raise; end if;
  end;
  if v_dtl is null or v_dtl = '' then
    raise exception 'T7 FAILED: the refusal carried no outcome detail';
  end if;
  perform 1 from deedbox.bulk_source_hit('bulk-test', 'mv3', 'money_transaction') h
   where h.o_target is not null;
  if found then
    raise exception 'T7 FAILED: a movement of the aborted replay persisted';
  end if;
  set local role deedbox_app;
  perform deedbox.bulk_record_money_refusal('bulk-test', null, v_actor, v_firm,
    v_account, 'would_go_below_zero', v_msg, v_dtl::jsonb);
  reset role;
  perform 1 from deedbox.refused_operation ro
   where ro.account = v_account and ro.refusal_reason = 'would_go_below_zero';
  if not found then
    raise exception 'T7 FAILED: the refusal recorder left no refused_operation';
  end if;
  perform 1 from deedbox.import_batch b
   where b.record_domain = 'client_money_full_history' and b.mode = 'real' and b.state = 'refused';
  if not found then
    raise exception 'T7 FAILED: the refused money batch row is missing';
  end if;

  -- T8 the capability gate: an actor without import.execute is refused.
  insert into deedbox.role (name) values ('t0046 no-import') returning id into v_norole;
  insert into deedbox.staff_member (person_name, login, role, office, email)
    values ('{"given":"No","family":"Cap"}', 'no.cap', v_norole, v_office,
            'no.cap@example.test') returning id into v_nobody;
  perform deedbox.bulk_stage('t8', jsonb_build_array(
    jsonb_build_object('source_ref', 'c9', 'data', jsonb_build_object('full_name', 'Never Lands'))));
  begin
    perform set_config('deedbox.principal_id', v_nobody::text, true);
    set local role deedbox_app;
    perform * from deedbox.bulk_apply('clients', 'bulk-test', 't8',
              'real', null, v_nobody, v_firm);
    reset role;
    raise exception 'T8 FAILED: a capability-less actor ran a batch';
  exception when others then
    reset role;
    if sqlerrm like 'T8 FAILED%' then raise; end if;
    if sqlerrm <> 'this operation requires import.execute' then raise; end if;
  end;
  perform set_config('deedbox.principal_id', v_actor::text, true);
end $$;

rollback;
