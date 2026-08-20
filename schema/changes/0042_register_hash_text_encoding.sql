-- 0042: the register's hash chain must hash the TEXT it was given, not
-- attempt to decode it as escaped binary.
--
-- The chain hashed its canonical line with `canonical::bytea`. Casting text
-- to bytea uses postgres's *escape* input format, which reads backslash
-- sequences as encodings rather than as characters. Two consequences, both
-- real:
--
--   * AVAILABILITY. The canonical line embeds `detail::text`, and a JSON
--     document renders an embedded double quote as `\"`. `\"` is not a valid
--     escape, so the cast raises `invalid input syntax for type bytea` and
--     the register write fails — which means the whole operation fails, since
--     every operation ends by writing its register entry. A party whose name
--     carries a nickname in quotation marks, a matter title quoting a phrase,
--     a narrative quoting what someone said: each of them broke the audit
--     chain. Ordinary text, in other words — found by replaying a real
--     archive rather than by any test, because no fixture had ever used a
--     name with a quotation mark in it.
--
--   * INTEGRITY. Where a backslash sequence IS a valid escape, the cast
--     silently decodes it, so distinct canonical lines can produce identical
--     bytes — `'A'::bytea = '\101'::bytea` is true. A chain whose purpose is
--     to be tamper-evident must not have a collision that cheap.
--
-- `convert_to(canonical, 'UTF8')` is the encoding-safe conversion: it takes
-- the characters as characters. For every canonical line that hashes today
-- the two agree byte for byte, so this preserves the hash of everything the
-- old expression could already handle; it only changes lines the old
-- expression refused or misread.
--
-- Both the writer and the verifier change together — a verifier computing a
-- different recipe from the writer would report every entry as broken.

begin;

-- the writer (0003's definition, unchanged but for the conversion)
create or replace function deedbox.register_entry_before_insert() returns trigger
security definer set search_path = deedbox, pg_temp
language plpgsql as $$
declare
  head deedbox.register_chain_head%rowtype;
  kind_row deedbox.register_event_kind%rowtype;
  canonical text;
begin
  select * into kind_row from deedbox.register_event_kind where kind = new.event_kind;
  if kind_row.privileged_required then
    new.privileged := true;
  end if;
  if new.privileged then
    if new.detail is null or not (new.detail ? 'before') or not (new.detail ? 'after') then
      raise exception 'privileged register write refused: detail must carry before and after values (kind %)', new.event_kind;
    end if;
  end if;
  if kind_row.reason_required and (new.reason is null or btrim(new.reason) = '') then
    raise exception 'register write refused: kind % requires a reason', new.event_kind;
  end if;
  if kind_row.matter_link = 'required' and new.matter is null then
    raise exception 'register write refused: kind % requires a matter link', new.event_kind;
  end if;
  if kind_row.matter_link = 'forbidden' and new.matter is not null then
    raise exception 'register write refused: kind % forbids a matter link', new.event_kind;
  end if;
  select * into head from deedbox.register_chain_head where firm = new.firm for update;
  if not found then
    insert into deedbox.register_chain_head (firm) values (new.firm) returning * into head;
  end if;
  new.seq := nextval('deedbox.register_seq');
  new.prev_hash := head.last_hash;
  canonical := concat_ws('|',
      head.last_hash, new.firm::text, new.seq::text, new.occurred_at::text,
      new.actor_kind, coalesce(new.actor::text,''), new.event_kind,
      new.subject_type, new.subject::text, coalesce(new.matter::text,''),
      new.privileged::text, coalesce(new.detail::text,''),
      coalesce(new.reason,''), coalesce(new.artefact,''));
  new.entry_hash := encode(sha256(convert_to(canonical, 'UTF8')), 'hex');
  update deedbox.register_chain_head
     set last_seq = new.seq, last_hash = new.entry_hash
   where firm = new.firm;
  return new;
end $$;

-- the verifier (0027's definition, unchanged but for the conversion)
create or replace function deedbox.register_verify_chain_detail(p_firm bigint, p_from_seq bigint)
returns table(breaks bigint, first_bad_seq bigint, last_seq bigint)
language plpgsql stable as $$
declare
  prev text;
  rec record;
  canonical text;
begin
  breaks := 0; first_bad_seq := null; last_seq := p_from_seq;
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
    if rec.entry_hash is distinct from encode(sha256(convert_to(canonical, 'UTF8')), 'hex') then
      breaks := breaks + 1;
      if first_bad_seq is null then first_bad_seq := rec.seq; end if;
    end if;
    prev := rec.entry_hash;
    last_seq := rec.seq;
  end loop;
  return next;
end $$;

commit;
