-- 0058 — the firm gains a trading identity, and pack activation gains its
-- two missing refusals.
--
-- IDENTITY. Client-facing documents printed the firm's name and nothing
-- else: no trading address, no registration identifier, no legal name where
-- it differs from the display name — yet a compliant letter or bill needs
-- all three, with nowhere to record them. Three blank text settings give
-- the facts one home:
--
--   firm.legal_name            the entity name where it differs from the display name
--   firm.trading_address       the address outbound documents carry
--   firm.registration_number   the firm's registration identifier
--
-- What the registration number is CALLED is the country's business — the
-- pack declares strings.registration_label (e.g. a national business-number
-- label); the engine's neutral fallback is "Registration no.". All three
-- default blank: a document renders an identity line only when the firm has
-- recorded it (all-or-nothing per field, never assembled).
--
-- PACK GUARDS. deedbox.activate_pack accepted any (pack, version) pair — a
-- version belonging to a DIFFERENT pack activated silently, registering as
-- success. The function
-- now refuses a mismatched pair, and a nonexistent version, with typed
-- messages, before anything changes. The OTHER wall — the caller's firm
-- must be bound to the pack being activated — already lives where the
-- caller's identity is known: the activation operation
-- (lib/ops/config/packs.ts, 'wrong_pack'). It stays there; this function is
-- principal-blind and must not guess the firm.

insert into deedbox.setting_definition (key, value_type, neutral_default, allowed_values, description) values
('firm.legal_name', 'text', '""', null,
 'The firm''s legal entity name, where it differs from the display name. '
 'Rendered on outbound documents when set; blank = not rendered.'),
('firm.trading_address', 'text', '""', null,
 'The firm''s trading address as outbound documents should carry it, on one '
 'line or several. Rendered when set; blank = not rendered.'),
('firm.registration_number', 'text', '""', null,
 'The firm''s registration identifier. Its label comes from the country '
 'pack (strings.registration_label), falling back to "Registration no.". '
 'Rendered on outbound documents when set; blank = not rendered.');

-- Activation with its refusals. Same body as 0024's otherwise — including
-- 0024's SECURITY DEFINER posture and pinned search path (the app role holds
-- only SELECT on country_pack; dropping the posture would re-open the defect
-- 0024 fixed). CREATE OR REPLACE preserves the existing grants (never
-- drop-and-recreate a granted routine — the platform's default grants would
-- come back with it).
create or replace function deedbox.activate_pack(p_pack bigint, p_version bigint,
                                                 p_actor_kind text, p_actor bigint)
returns void
security definer set search_path = deedbox, pg_temp
language plpgsql as $$
declare bad bigint; old_version bigint; f bigint; v_pack_of_version bigint;
begin
  select pack into v_pack_of_version from deedbox.pack_version where id = p_version;
  if v_pack_of_version is null then
    raise exception 'pack refused at activation: version % does not exist', p_version;
  end if;
  if v_pack_of_version <> p_pack then
    raise exception 'pack refused at activation: version % belongs to a different pack', p_version;
  end if;
  select count(*) into bad
    from deedbox.pack_declaration d
    left join deedbox.rule_point rp
      on rp.key = d.rule_point
      or (rp.key = 'strings.*' and d.rule_point like 'strings.%')
   where d.pack_version = p_version
     and (rp.key is null or not (d.kind::text = any (rp.permitted_kinds)));
  if bad > 0 then
    raise exception 'pack refused at activation: % invalid declaration(s)', bad;
  end if;
  select active_version into old_version from deedbox.country_pack where id = p_pack;
  update deedbox.country_pack set active_version = p_version where id = p_pack;
  select id into f from deedbox.firm limit 1;
  if f is not null then
    insert into deedbox.register_entry
      (firm, actor_kind, actor, event_kind, subject_type, subject, privileged, detail)
    values (f, p_actor_kind, p_actor, 'pack.activated', 'country_pack', p_pack, true,
            jsonb_build_object('before', jsonb_build_object('active_version', old_version),
                               'after',  jsonb_build_object('active_version', p_version)));
  end if;
end $$;
