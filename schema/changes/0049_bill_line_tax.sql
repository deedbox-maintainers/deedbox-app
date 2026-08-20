-- 0049 — a bill's tax is computed from the declared rule, never assumed to be
-- zero.
--
-- The design has always said it: "tax per line from billing.tax, evaluated at
-- line creation and re-verified at issue" — a bill line's tax_treatment key
-- names one of the active pack's `billing.tax` declarations, and each
-- declaration carries the computation. What shipped stored the key and wrote
-- the tax as zero: no code anywhere evaluated the rule, so every bill drafted
-- in the product issued with a Tax column reading 0.00 on every line. Bills
-- brought in by the import paths were unaffected — they carry the source
-- system's own tax figures verbatim, and keep doing so.
--
-- This change gives the rule its evaluator. A `billing.tax` enumeration
-- declaration is keyed by the treatment (`discriminator`) and carries in its
-- body a `rate` — the fraction of the line amount that is tax
-- (`{"label":"GST","rate":0.10}`); a declared key without a rate, an
-- undeclared key, or a firm with no active pack all evaluate to zero — the
-- catalogue's neutral default ("no additional rule"), so no installation's
-- behaviour changes until its pack declares otherwise. The application layer
-- evaluates the rule at line creation, at every amount change (write-downs),
-- at submission for approval and at issue: the rule in force at issue
-- governs; a group approved under a different rule is refused and returns to
-- draft rather than issuing a total nobody approved.

create or replace function deedbox.tax_rate(p_firm bigint, p_key text)
returns numeric language sql stable as $$
  select coalesce((
    select (d.body ->> 'rate')::numeric
      from deedbox.pack_declaration d
      join deedbox.firm f on f.id = p_firm
      join deedbox.country_pack cp on cp.id = f.country_pack
     where d.pack_version = cp.active_version
       and d.rule_point = 'billing.tax'
       and d.discriminator = p_key
     limit 1), 0);
$$;
grant execute on function deedbox.tax_rate(bigint, text) to deedbox_app;

-- The tax on one line: the amount times the rate, to the cent (half-up, the
-- rounding every money figure in the engine uses).
create or replace function deedbox.line_tax(p_firm bigint, p_amount numeric, p_key text)
returns numeric language sql stable as $$
  select round(coalesce(p_amount, 0) * deedbox.tax_rate(p_firm, p_key), 2);
$$;
grant execute on function deedbox.line_tax(bigint, numeric, text) to deedbox_app;
