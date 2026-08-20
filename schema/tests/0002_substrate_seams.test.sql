-- Tests for 0002_substrate_seams. Run as the deployment role AFTER 0001+0002.

begin;

-- Fixture (0001's provisioning path).
insert into deedbox.country_pack (code, name) values ('AU-NSW','Australia (NSW)');
insert into deedbox.pack_version (pack, version)
  select id, '0.0.1' from deedbox.country_pack where code='AU-NSW';
update deedbox.country_pack cp set active_version = pv.id
  from deedbox.pack_version pv where pv.pack = cp.id and cp.code='AU-NSW';
insert into deedbox.firm (name, operating_currency, timezone, country_pack)
  select 'Test Firm','AUD','Australia/Sydney', id from deedbox.country_pack where code='AU-NSW';

do $$
declare n1 text; n2 text; n3 text; pv bigint; pk bigint; d bigint; cl bigint; ci bigint;
begin
  select id into pk from deedbox.country_pack limit 1;
  select id into pv from deedbox.pack_version limit 1;

  ------------------------------------------------------------------
  -- Numbering: gapless streams never gap, even across a rollback.
  ------------------------------------------------------------------
  n1 := deedbox.allocate_number('bill');
  if n1 <> 'B-000001' then raise exception 'expected B-000001, got %', n1; end if;
  begin
    perform deedbox.allocate_number('bill');
    raise exception 'sentinel';           -- forces the savepoint block to roll back
  exception when others then
    if sqlerrm <> 'sentinel' then raise; end if;
  end;
  n2 := deedbox.allocate_number('bill');  -- the aborted allocation consumed nothing
  if n2 <> 'B-000002' then raise exception 'gapless stream gapped: got %', n2; end if;

  -- Yearly reset partitions derive from the governing act's date.
  n3 := deedbox.allocate_number('matter', null, date '2026-08-13');
  if n3 <> 'M-2026-00001' then raise exception 'expected M-2026-00001, got %', n3; end if;
  n3 := deedbox.allocate_number('matter', null, date '2027-01-02');
  if n3 <> 'M-2027-00001' then raise exception 'year partition: got %', n3; end if;

  -- Sequence-mode streams allocate (gaps tolerated by design).
  n3 := deedbox.allocate_number('statement');
  if n3 !~ '^S-\d{6}$' then raise exception 'statement pattern: got %', n3; end if;

  -- The office receivable-receipt stream is distinct from client-money receipts.
  n1 := deedbox.allocate_number('money_receipt');
  n2 := deedbox.allocate_number('receivable_receipt');
  if n1 <> 'R-000001' or n2 <> 'OR-000001' then
    raise exception 'receipt streams collided: % / %', n1, n2;
  end if;

  ------------------------------------------------------------------
  -- Packs: declaration guards + activation validation.
  ------------------------------------------------------------------
  insert into deedbox.pack_declaration (pack_version, rule_point, kind, body)
    values (pv, 'money.instrument_kinds', 'value', '{"cheque_stale_days":180}');
  insert into deedbox.pack_declaration (pack_version, rule_point, kind, body)
    values (pv, 'strings.en-AU', 'string_bundle', '{"hello":"g''day"}');
  begin
    insert into deedbox.pack_declaration (pack_version, rule_point, kind, body)
      values (pv, 'made.up_point', 'value', '{}');
    raise exception 'unknown rule point accepted';
  exception when others then
    if sqlerrm not like '%unknown rule point%' then raise; end if;
  end;
  begin
    insert into deedbox.pack_declaration (pack_version, rule_point, kind, body)
      values (pv, 'privacy.erasure', 'register_schema', '{}');
    raise exception 'wrong declaration kind accepted';
  exception when others then
    if sqlerrm not like '%not permitted for rule point%' then raise; end if;
  end;
  begin
    update deedbox.pack_declaration set body = '{}' where pack_version = pv;
    raise exception 'declaration mutation permitted';
  exception when others then
    if sqlerrm not like '%immutable%' then raise; end if;
  end;
  perform deedbox.activate_pack(pk, pv, 'staff', 1);
  if deedbox.register_verify_chain((select id from deedbox.firm limit 1)) <> 0 then
    raise exception 'activation broke the register chain';
  end if;

  ------------------------------------------------------------------
  -- Choice lists: shipped protections.
  ------------------------------------------------------------------
  select ci2.id into ci from deedbox.choice_item ci2
    join deedbox.choice_list cl2 on cl2.id = ci2.list
   where cl2.purpose_key='time_categories' and ci2.shipped_key='chargeable';
  begin
    delete from deedbox.choice_item where id = ci;
    raise exception 'shipped item deletion permitted';
  exception when others then
    if sqlerrm not like '%never deleted%' then raise; end if;
  end;
  begin
    update deedbox.choice_item set counts_as_chargeable = false where id = ci;
    raise exception 'shipped chargeability flip permitted';
  exception when others then
    if sqlerrm not like '%immutable%' then raise; end if;
  end;
  -- A firm-added third category is always classifiable.
  select id into cl from deedbox.choice_list where purpose_key='time_categories';
  insert into deedbox.choice_item (list, label, position, counts_as_chargeable)
    values (cl, 'Pro bono', 3, false);

  ------------------------------------------------------------------
  -- Custom fields: type discipline + auto choice list + guards.
  ------------------------------------------------------------------
  insert into deedbox.custom_field_definition (scope, key, label, data_type)
    values ('matter', 'court_file_no', 'Court file number', 'text')
    returning id into d;
  begin
    update deedbox.custom_field_definition set data_type='number' where id = d;
    raise exception 'data_type change permitted';
  exception when others then
    if sqlerrm not like '%immutable%' then raise; end if;
  end;
  insert into deedbox.custom_field_definition (scope, key, label, data_type)
    values ('matter', 'urgency', 'Urgency', 'choice');
  if not exists (select 1 from deedbox.choice_list where purpose_key = 'custom.matter.urgency') then
    raise exception 'choice field did not auto-create its list';
  end if;
  insert into deedbox.custom_field_value (definition, owner_type, owner, text_value)
    values (d, 'matter', 42, 'SYD-2026-001');
  begin
    insert into deedbox.custom_field_value (definition, owner_type, owner, number_value)
      values (d, 'matter', 43, 7);
    raise exception 'mismatched value column permitted';
  exception when others then
    if sqlerrm not like '%match the definition%' then raise; end if;
  end;

  ------------------------------------------------------------------
  -- Extension points: deprecate, never delete. Namespace shape guard.
  ------------------------------------------------------------------
  -- (0029 renamed report.menu to report.menu_entry and gave the
  -- namespace its final shape — this suite runs against the full chain)
  update deedbox.ui_extension_point set deprecation_state='deprecated'
   where point_key='report.menu_entry';
  begin
    delete from deedbox.ui_extension_point where point_key='report.menu_entry';
    raise exception 'extension point deletion permitted';
  exception when others then
    if sqlerrm not like '%append-only%' then raise; end if;
  end;
  begin
    insert into deedbox.private_namespace (namespace, description, db_principal)
      values ('not_reserved_prefix', 'bad', 'pl_probe');
    raise exception 'unreserved namespace accepted';
  exception when check_violation then null;
  end;

  raise notice 'ALL 0002 SUBSTRATE-SEAMS TESTS PASSED';
end $$;

rollback;
