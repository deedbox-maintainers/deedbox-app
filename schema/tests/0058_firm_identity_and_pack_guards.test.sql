-- Tests for 0058_firm_identity_and_pack_guards. Run as deployment role AFTER
-- the full chain. The document rendering of the identity block is pinned in
-- the application suite (presentation.test); here: the settings exist, and
-- activation's two refusals refuse.

begin;

with cp as (
  insert into deedbox.country_pack (code, name) values ('t58a', 'Fifty-eight A') returning id
)
insert into deedbox.firm (name, operating_currency, timezone, country_pack)
select 'T58', 'AUD', 'Australia/Sydney', cp.id from cp;

do $$
declare
  n int;
  pack_a bigint;
  pack_b bigint;
  ver_a bigint;
  ver_b bigint;
  refused boolean;
begin
  -- T1: the three blank text settings exist
  select count(*) into n from deedbox.setting_definition
   where key in ('firm.legal_name', 'firm.trading_address', 'firm.registration_number')
     and value_type = 'text' and neutral_default = '""'::jsonb;
  if n <> 3 then
    raise exception 'T1 FAILED: expected the three blank firm-identity settings, found %', n;
  end if;

  select id into pack_a from deedbox.country_pack where code = 't58a';
  insert into deedbox.country_pack (code, name) values ('t58b', 'Fifty-eight B') returning id into pack_b;
  insert into deedbox.pack_version (pack, version) values (pack_a, 't58-1') returning id into ver_a;
  insert into deedbox.pack_version (pack, version) values (pack_b, 't58-1') returning id into ver_b;

  -- T2: a version belonging to a different pack refuses
  refused := false;
  begin
    perform deedbox.activate_pack(pack_a, ver_b, 'staff', null);
  exception when others then
    refused := true;
    if position('belongs to a different pack' in sqlerrm) = 0 then
      raise exception 'T2 FAILED: wrong refusal message: %', sqlerrm;
    end if;
  end;
  if not refused then
    raise exception 'T2 FAILED: activating a foreign version did not refuse';
  end if;

  -- T3: a MATCHED pair on any pack activates at this level — the firm-binding
  -- wall lives in the activation operation, which knows the caller's firm;
  -- the function is principal-blind and checks only pack/version integrity
  perform deedbox.activate_pack(pack_b, ver_b, 'staff', null);
  select count(*) into n from deedbox.country_pack where id = pack_b and active_version = ver_b;
  if n <> 1 then
    raise exception 'T3 FAILED: a matched pair on another pack did not activate at function level';
  end if;

  -- T4: the matched pair still activates AND registers pack.activated
  perform deedbox.activate_pack(pack_a, ver_a, 'staff', null);
  select count(*) into n from deedbox.country_pack where id = pack_a and active_version = ver_a;
  if n <> 1 then
    raise exception 'T4 FAILED: the matched pair did not activate';
  end if;
  select count(*) into n from deedbox.register_entry
   where event_kind = 'pack.activated' and subject_type = 'country_pack' and subject = pack_a
     and privileged and (detail->'after'->>'active_version')::bigint = ver_a;
  if n <> 1 then
    raise exception 'T4 FAILED: pack.activated register entry missing or wrong';
  end if;

  -- T5: a nonexistent version refuses honestly
  refused := false;
  begin
    perform deedbox.activate_pack(pack_a, -1, 'staff', null);
  exception when others then
    refused := true;
    if position('does not exist' in sqlerrm) = 0 then
      raise exception 'T5 FAILED: wrong refusal message: %', sqlerrm;
    end if;
  end;
  if not refused then
    raise exception 'T5 FAILED: a nonexistent version did not refuse';
  end if;
end $$;

rollback;
