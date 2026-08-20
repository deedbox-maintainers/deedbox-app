-- Australian country pack — version 2026.08.19: the billing.tax rule.
--
-- A country pack is a set of typed declarations against the engine's rule
-- points (schema change 0002); the engine consults the firm's ACTIVE pack
-- version and applies the neutral default wherever the pack is silent. This
-- version declares the two tax treatments an Australian practice bills with:
--
--   standard   GST at 10% of the line amount — taxable supplies
--   gst_free   no GST on the line
--
-- Installing this file records the pack version and its declarations; it
-- ACTIVATES nothing. Activation is a separate, registered, privileged act —
-- the application's "activate pack version" operation (capability
-- pack.activate), or deedbox.activate_pack(...) run by the installer with a
-- named actor — and it takes effect the moment it lands: bills drafted from
-- then on carry tax per line at these rates; drafts already open pick the
-- rule up at submission or issue (schema change 0049).
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

  select id into v_ver from deedbox.pack_version where pack = v_pack and version = '2026.08.19';
  if v_ver is not null then
    raise notice 'au pack version 2026.08.19 already installed (id %)', v_ver;
    return;
  end if;

  insert into deedbox.pack_version (pack, version) values (v_pack, '2026.08.19') returning id into v_ver;

  insert into deedbox.pack_declaration (pack_version, rule_point, kind, discriminator, body) values
    (v_ver, 'billing.tax', 'enumeration', 'standard',
     '{"label":"GST","rate":0.10,"description":"Goods and services tax at 10% of the line amount."}'),
    (v_ver, 'billing.tax', 'enumeration', 'gst_free',
     '{"label":"GST-free","rate":0,"description":"No GST on this line."}');

  raise notice 'au pack version 2026.08.19 installed (id %) — not yet active', v_ver;
end $$;
