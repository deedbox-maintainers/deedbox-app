-- Tests for 0049_bill_line_tax. Run as deployment role AFTER the full chain.
-- The evaluator of the `billing.tax` rule: zero until a firm's active pack
-- declares a rate for the key; the declared rate thereafter, firm-scoped, to
-- the cent. The application suite (billing-tax.test) pins where the
-- evaluator is applied — creation, write-down, submission, issue.

begin;

insert into deedbox.country_pack (code, name) values ('AU-TAX','Australia (tax suite)');
insert into deedbox.firm (name, operating_currency, timezone, country_pack)
  select 'Tax Test Firm','AUD','Australia/Sydney', id from deedbox.country_pack where code = 'AU-TAX';

do $$
declare
  f1 bigint; f2 bigint; cp1 bigint; cp2 bigint; v1 bigint; v2 bigint; v3 bigint; r numeric;
begin
  select id into cp1 from deedbox.country_pack where code = 'AU-TAX';
  select id into f1 from deedbox.firm where country_pack = cp1;

  -- T1 no active pack version: every key evaluates to zero (the neutral default)
  if deedbox.tax_rate(f1, 'standard') <> 0 then
    raise exception 'T1 FAILED: rate without a pack read %, wanted 0', deedbox.tax_rate(f1, 'standard');
  end if;
  if deedbox.line_tax(f1, 1000.00, 'standard') <> 0 then
    raise exception 'T1 FAILED: line tax without a pack was not zero';
  end if;

  -- T2 a version declaring the keys: standard carries a rate, gst_free none
  insert into deedbox.pack_version (pack, version) values (cp1, '2026.1') returning id into v1;
  insert into deedbox.pack_declaration (pack_version, rule_point, kind, discriminator, body) values
    (v1, 'billing.tax', 'enumeration', 'standard', '{"label":"GST","rate":0.10}'),
    (v1, 'billing.tax', 'enumeration', 'gst_free', '{"label":"GST-free"}');
  -- not yet active: still zero
  if deedbox.tax_rate(f1, 'standard') <> 0 then
    raise exception 'T2 FAILED: an inactive version governed';
  end if;
  update deedbox.country_pack set active_version = v1 where id = cp1;
  r := deedbox.tax_rate(f1, 'standard');
  if r <> 0.10 then
    raise exception 'T2 FAILED: standard rate read %, wanted 0.10', r;
  end if;
  if deedbox.tax_rate(f1, 'gst_free') <> 0 then
    raise exception 'T2 FAILED: a declared key without a rate did not evaluate to zero';
  end if;
  if deedbox.tax_rate(f1, 'no_such_key') <> 0 then
    raise exception 'T2 FAILED: an undeclared key did not evaluate to zero';
  end if;

  -- T3 line tax is the amount times the rate, to the cent, half-up
  if deedbox.line_tax(f1, 123.45, 'standard') <> 12.35 then
    raise exception 'T3 FAILED: 123.45 at 10%% gave %, wanted 12.35', deedbox.line_tax(f1, 123.45, 'standard');
  end if;
  if deedbox.line_tax(f1, 400.00, 'standard') <> 40.00 then
    raise exception 'T3 FAILED: 400.00 at 10%% gave %', deedbox.line_tax(f1, 400.00, 'standard');
  end if;
  if deedbox.line_tax(f1, 400.00, 'gst_free') <> 0 then
    raise exception 'T3 FAILED: a gst_free line carried tax';
  end if;
  if deedbox.line_tax(f1, null, 'standard') <> 0 then
    raise exception 'T3 FAILED: a null amount did not evaluate to zero';
  end if;

  -- T4 firm-scoped: another firm on another pack sees its own rate only
  insert into deedbox.country_pack (code, name) values ('ZZ-TAX','Elsewhere (tax suite)') returning id into cp2;
  insert into deedbox.firm (name, operating_currency, timezone, country_pack)
    values ('Other Firm','NZD','Pacific/Auckland', cp2) returning id into f2;
  insert into deedbox.pack_version (pack, version) values (cp2, '2026.1') returning id into v2;
  insert into deedbox.pack_declaration (pack_version, rule_point, kind, discriminator, body) values
    (v2, 'billing.tax', 'enumeration', 'standard', '{"label":"Tax","rate":0.15}');
  update deedbox.country_pack set active_version = v2 where id = cp2;
  if deedbox.tax_rate(f1, 'standard') <> 0.10 or deedbox.tax_rate(f2, 'standard') <> 0.15 then
    raise exception 'T4 FAILED: rates leaked across firms (% / %)',
      deedbox.tax_rate(f1, 'standard'), deedbox.tax_rate(f2, 'standard');
  end if;

  -- T5 a later version governs the moment it is activated
  insert into deedbox.pack_version (pack, version) values (cp1, '2026.2') returning id into v3;
  insert into deedbox.pack_declaration (pack_version, rule_point, kind, discriminator, body) values
    (v3, 'billing.tax', 'enumeration', 'standard', '{"label":"GST","rate":0.20}');
  update deedbox.country_pack set active_version = v3 where id = cp1;
  if deedbox.tax_rate(f1, 'standard') <> 0.20 then
    raise exception 'T5 FAILED: the newly active version did not govern';
  end if;
end $$;

rollback;
