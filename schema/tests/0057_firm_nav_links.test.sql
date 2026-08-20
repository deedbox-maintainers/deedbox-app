-- Tests for 0057_firm_nav_links. Run as deployment role AFTER the full chain.
-- The setting exists in the catalogue as text with an empty neutral default,
-- and a firm's value travels through the ordinary append-only machinery. The
-- parsing/merging behaviour is pinned in the application suite
-- (nav-links.test); this suite pins the catalogue row and the read path.

begin;

do $$
declare
  v jsonb;
begin
  -- T1 the definition exists, text, defaulting to empty
  perform 1 from deedbox.setting_definition
    where key = 'nav.firm_links' and value_type = 'text'
      and neutral_default = '""'::jsonb;
  if not found then
    raise exception 'T1 FAILED: the setting definition is missing or wrongly shaped';
  end if;

  -- T2 unset, the current value reads the neutral default: empty text
  v := deedbox.current_setting_value('nav.firm_links');
  if v is distinct from '""'::jsonb then
    raise exception 'T2 FAILED: unset value read %, wanted ""', v;
  end if;

  -- T3 a firm sets its links through the ordinary append-only machinery
  insert into deedbox.firm_setting (definition, value, effective_from)
    select id, to_jsonb('Billing | Fee splits | /fee-splits | money.manage_accounts'::text),
           now() - interval '1 minute'
      from deedbox.setting_definition where key = 'nav.firm_links';
  v := deedbox.current_setting_value('nav.firm_links');
  if v #>> '{}' is distinct from 'Billing | Fee splits | /fee-splits | money.manage_accounts' then
    raise exception 'T3 FAILED: the set value did not read back (%)', v;
  end if;
end $$;

rollback;
