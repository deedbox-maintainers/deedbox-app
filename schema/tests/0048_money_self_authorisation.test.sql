-- Tests for 0048_money_self_authorisation. Run as deployment role AFTER the
-- full chain. The setting exists in the catalogue with the shipped-safe
-- neutral default (off), reads false until a firm turns it on, and turns on
-- through the ordinary append-only setting machinery. The behavioural walls
-- it governs are pinned in the application suite (self-authorisation.test);
-- this suite pins the catalogue row and the read path.

begin;

do $$
declare
  v jsonb;
begin
  -- T1 the definition exists, boolean, defaulting to off
  perform 1 from deedbox.setting_definition
    where key = 'money.self_authorisation' and value_type = 'boolean'
      and neutral_default = 'false'::jsonb;
  if not found then
    raise exception 'T1 FAILED: the setting definition is missing or wrongly shaped';
  end if;

  -- T2 unset, the current value reads the neutral default: false
  v := deedbox.current_setting_value('money.self_authorisation');
  if v is distinct from 'false'::jsonb then
    raise exception 'T2 FAILED: unset value read %, wanted false', v;
  end if;

  -- T3 a firm turns it on through the ordinary append-only machinery.
  -- now() is transaction-frozen, so the two history rows this suite writes
  -- carry explicit distinct moments or they collide on the
  -- (definition, effective_from) uniqueness — found by this suite's own
  -- first run.
  insert into deedbox.firm_setting (definition, value, effective_from)
    select id, 'true'::jsonb, now() - interval '1 minute' from deedbox.setting_definition
     where key = 'money.self_authorisation';
  v := deedbox.current_setting_value('money.self_authorisation');
  if v is distinct from 'true'::jsonb then
    raise exception 'T3 FAILED: the setting did not read back on (%)', v;
  end if;

  -- T4 and off again, history preserved (two rows, latest wins)
  insert into deedbox.firm_setting (definition, value)
    select id, 'false'::jsonb from deedbox.setting_definition
     where key = 'money.self_authorisation';
  v := deedbox.current_setting_value('money.self_authorisation');
  if v is distinct from 'false'::jsonb then
    raise exception 'T4 FAILED: the setting did not read back off (%)', v;
  end if;
  perform 1 from (
    select count(*) as n from deedbox.firm_setting fs
      join deedbox.setting_definition sd on sd.id = fs.definition
     where sd.key = 'money.self_authorisation'
  ) x where x.n = 2;
  if not found then
    raise exception 'T4 FAILED: the append-only history does not hold both rows';
  end if;
end $$;

rollback;
