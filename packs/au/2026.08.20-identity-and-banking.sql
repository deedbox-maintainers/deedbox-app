-- Australian country pack — version 2026.08.20: tax (carried forward with a
-- declared default), bank identifiers, and the Australian document wording.
--
-- A firm holds ONE active pack version, so each version declares the
-- complete rulebook. This version carries forward 2026.08.19's two tax
-- treatments — now marking `standard` as the DEFAULT the engine applies
-- when a caller names none — and adds:
--
--   bank.account_identifiers   Australian accounts are identified by a BSB
--                              and an account number. Drives the firm
--                              payment-details capture, the payee capture on
--                              client-money payments, and gates the
--                              Australian bank-payment-file download.
--   strings.bill_title         "Tax Invoice" — the statutory name of the
--                              billing document under Australian GST law.
--   strings.receipt_title      "Trust Account Receipt".
--   strings.registration_label "ABN" — what the firm's registration number
--                              is called on documents (the number itself is
--                              firm data: setting firm.registration_number).
--
-- Installing records the version; nothing changes until activation
-- (Settings → Country pack → Activate, or deedbox.activate_pack). NOTE for
-- existing installations: once active, tax keys are validated as before, the
-- payee capture offers BSB + account number, and bills keep the Tax Invoice
-- title through the pack rather than the engine.
--
-- Idempotent: re-running against a database that already holds this version
-- changes nothing (declarations are immutable within a version).

do $$
declare
  v_pack bigint;
  v_ver  bigint;
begin
  select id into v_pack from deedbox.country_pack where code = 'au';
  if v_pack is null then
    insert into deedbox.country_pack (code, name) values ('au', 'Australia') returning id into v_pack;
  end if;

  select id into v_ver from deedbox.pack_version where pack = v_pack and version = '2026.08.20';
  if v_ver is not null then
    raise notice 'au pack version 2026.08.20 already installed (id %)', v_ver;
    return;
  end if;

  insert into deedbox.pack_version (pack, version) values (v_pack, '2026.08.20') returning id into v_ver;

  insert into deedbox.pack_declaration (pack_version, rule_point, kind, discriminator, body) values
    (v_ver, 'billing.tax', 'enumeration', 'standard',
     '{"label":"GST","rate":0.10,"default":true,"description":"Goods and services tax at 10% of the line amount."}'),
    (v_ver, 'billing.tax', 'enumeration', 'gst_free',
     '{"label":"GST-free","rate":0,"description":"No GST on this line."}'),
    (v_ver, 'bank.account_identifiers', 'field_schema', null,
     '{"fields":[{"key":"bsb","label":"BSB"},{"key":"account_number","label":"Account number"}]}'),
    (v_ver, 'strings.bill_title', 'string_bundle', null,
     '{"value":"Tax Invoice"}'),
    (v_ver, 'strings.receipt_title', 'string_bundle', null,
     '{"value":"Trust Account Receipt"}'),
    (v_ver, 'strings.registration_label', 'string_bundle', null,
     '{"value":"ABN"}');

  raise notice 'au pack version 2026.08.20 installed (id %) — not yet active', v_ver;
end $$;
