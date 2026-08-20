-- 0027_anomaly_and_chain_jobs — the schema half of security's anomaly
-- evaluation and its chain verifier:
--   * the app role gains write on anomaly_cursor (it was select-only — the
--     recorded gap), guarded FORWARD-ONLY so a compromised app role can
--     neither rewind a cursor to re-raise history nor is a cursor ever
--     silently moved backwards;
--   * anomaly_rule's key list gains 'chain_break' with a seeded rule row —
--     the chain verifier demands an anomaly alert on a detected break, and
--     the event-kind enum had no key for it (a gap found by implementation);
--   * the canonical hash recipe moves into ONE richer verifier,
--     register_verify_chain_detail(firm, from_seq) → (breaks, first_bad_seq,
--     last_seq), supporting checkpoint walks; the original
--     register_verify_chain(firm) becomes a thin wrapper so every existing
--     caller and suite stands unchanged and the recipe has one home.

begin;

grant insert, update on deedbox.anomaly_cursor to deedbox_app;

create or replace function deedbox.anomaly_cursor_forward_only() returns trigger
language plpgsql as $$
begin
  if new.rule is distinct from old.rule then
    raise exception 'a cursor belongs to its rule';
  end if;
  if new.last_seq < old.last_seq then
    raise exception 'an anomaly cursor only moves forward (% -> % refused)', old.last_seq, new.last_seq;
  end if;
  return new;
end $$;
create trigger anomaly_cursor_forward_only before update on deedbox.anomaly_cursor
for each row execute function deedbox.anomaly_cursor_forward_only();

alter table deedbox.anomaly_rule drop constraint anomaly_rule_key_check;
alter table deedbox.anomaly_rule add constraint anomaly_rule_key_check check (key in
  ('repeated_sign_in_failure','large_export','permission_escalation',
   'private_layer_violation','chain_break'));
insert into deedbox.anomaly_rule (key, threshold) values ('chain_break','{"any":true}');

create or replace function deedbox.register_verify_chain_detail(p_firm bigint, p_from_seq bigint)
returns table(breaks bigint, first_bad_seq bigint, last_seq bigint)
language plpgsql stable as $$
declare
  prev text;
  rec record;
  canonical text;
begin
  breaks := 0; first_bad_seq := null; last_seq := p_from_seq;
  -- the starting link: the entry the checkpoint names, or genesis
  if p_from_seq <= 0 then
    prev := 'genesis';
  else
    select re.entry_hash into prev from deedbox.register_entry re
     where re.firm = p_firm and re.seq = p_from_seq;
    if not found then
      prev := 'genesis';
    end if;
  end if;
  for rec in
    select * from deedbox.register_entry
     where firm = p_firm and seq > p_from_seq order by seq
  loop
    if rec.prev_hash is distinct from prev then
      breaks := breaks + 1;
      if first_bad_seq is null then first_bad_seq := rec.seq; end if;
    end if;
    canonical := concat_ws('|',
        rec.prev_hash, rec.firm::text, rec.seq::text, rec.occurred_at::text,
        rec.actor_kind, coalesce(rec.actor::text,''), rec.event_kind,
        rec.subject_type, rec.subject::text, coalesce(rec.matter::text,''),
        rec.privileged::text, coalesce(rec.detail::text,''),
        coalesce(rec.reason,''), coalesce(rec.artefact,''));
    if rec.entry_hash is distinct from encode(sha256(canonical::bytea), 'hex') then
      breaks := breaks + 1;
      if first_bad_seq is null then first_bad_seq := rec.seq; end if;
    end if;
    prev := rec.entry_hash;
    last_seq := rec.seq;
  end loop;
  return next;
end $$;
grant execute on function deedbox.register_verify_chain_detail(bigint, bigint) to deedbox_app;

-- the original signature becomes a wrapper: one recipe home, no caller changes
create or replace function deedbox.register_verify_chain(p_firm bigint)
returns bigint language sql stable as $$
  select breaks from deedbox.register_verify_chain_detail(p_firm, 0)
$$;

commit;
