-- 0007_identity_completion — the identity layer completed: party links, the
-- system-maintained match keys behind duplicate detection and search,
-- permanent duplicate decisions, the merge record riding the bulk-operation
-- machinery (landed here as its record layer), conflict checks and
-- resolutions with the snapshot-name companion, the duplicate-check
-- service, the contact-point → party mirror the foundation promises, and
-- the party soft-delete eligibility rule.
--
-- Implementation notes:
--   * Match keys re-aim at the ACTIVE end of a merge chain: a key row's
--     party is resolved through merged_into at rebuild time, so re-keying
--     the absorbed party's names onto the survivor is what the ordinary
--     rebuild does when the merge operation calls it — one mechanism, no
--     special case. Contact-key rows exist for active parties only.
--   * Fuzzy name matching: trigram similarity ≥ 0.4 on the folded key, or
--     an exact double-metaphone hit — thresholds recorded here, tuned
--     against the reference dataset when the app layer lands.
--   * The party soft-delete eligibility check covers this domain's own
--     party-bearing columns (matter.client_party, matter_party, party_link,
--     intake prospect/party rows, custom party_link values). Billing's and
--     money's manifests extend the same guard when those domains land.
--   * The merge/undo OPERATIONS (manifest-driven repoint, portal disable,
--     bulk reversal) are app-layer, later stages; the record tables land
--     now with their transition discipline so nothing can be recorded
--     out of shape.
--   * unaccent and fuzzystrmatch install into the extensions schema, same
--     as pg_trgm in 0006; all calls are schema-qualified.

begin;

create extension if not exists unaccent with schema extensions;
create extension if not exists fuzzystrmatch with schema extensions;

------------------------------------------------------------------------------
-- Normalisation: the folded, sorted, stripped keys everything matches on.
------------------------------------------------------------------------------
create or replace function deedbox.fold_name(p text) returns text
language sql stable as $$
  -- apostrophes join (O'Brien = OBrien); other punctuation separates.
  select coalesce(array_to_string(
    (select array_agg(t order by t)
       from unnest(string_to_array(
              regexp_replace(
                regexp_replace(lower(extensions.unaccent(coalesce(p,''))), '[''’]', '', 'g'),
                '[^a-z0-9 ]', ' ', 'g'),
              ' ')) t
      where t <> ''), ' '), '');
$$;

create or replace function deedbox.phonetic_name(p text) returns text
language sql stable as $$
  select coalesce(array_to_string(
    (select array_agg(k order by k)
       from (select extensions.dmetaphone(t) k
               from unnest(string_to_array(deedbox.fold_name(p), ' ')) t
              where t <> '') x
      where k <> ''), ' '), '');
$$;

create or replace function deedbox.fold_phone(p text) returns text
language sql immutable as $$
  select nullif(regexp_replace(coalesce(p,''), '[^0-9]', '', 'g'), '');
$$;

create or replace function deedbox.fold_email(p text) returns text
language sql immutable as $$
  select nullif(lower(trim(coalesce(p,''))), '');
$$;

------------------------------------------------------------------------------
-- party_match_key — system-maintained, hard-replaceable, never evidence.
------------------------------------------------------------------------------
create table deedbox.party_match_key (
    id bigint generated always as identity primary key,
    party bigint not null references deedbox.party(id),
    source_name bigint references deedbox.party_name(id),  -- null for the contact-key row
    name_key text,
    name_phonetic text,
    phone_key text,
    email_key text
);
create index party_match_key_party_idx on deedbox.party_match_key (party);
create index party_match_key_name_trgm
  on deedbox.party_match_key using gin (name_key extensions.gin_trgm_ops);
create index party_match_key_phonetic_idx on deedbox.party_match_key (name_phonetic);
create index party_match_key_phone_idx on deedbox.party_match_key (phone_key);
create index party_match_key_email_idx on deedbox.party_match_key (email_key);
grant select, insert, update, delete on deedbox.party_match_key to deedbox_app;

-- A merged party's keys belong to the active end of its chain, so searches
-- for an absorbed name find the survivor.
create or replace function deedbox.active_end_of(p_party bigint) returns bigint
language plpgsql stable as $$
declare cur bigint := p_party; nxt bigint; hops int := 0;
begin
  loop
    select merged_into into nxt from deedbox.party where id = cur;
    exit when nxt is null;
    cur := nxt; hops := hops + 1;
    if hops > 50 then
      raise exception 'merge chain from party % does not terminate', p_party;
    end if;
  end loop;
  return cur;
end $$;

create or replace function deedbox.rebuild_party_match_keys(p_party bigint)
returns void language plpgsql as $$
declare tgt bigint; p deedbox.party%rowtype;
begin
  tgt := deedbox.active_end_of(p_party);
  delete from deedbox.party_match_key mk
   where mk.party = p_party
      or mk.source_name in (select pn.id from deedbox.party_name pn where pn.party = p_party);
  insert into deedbox.party_match_key (party, source_name, name_key, name_phonetic)
  select tgt, pn.id, deedbox.fold_name(pn.full_name), deedbox.phonetic_name(pn.full_name)
    from deedbox.party_name pn where pn.party = p_party;
  select * into p from deedbox.party where id = p_party;
  if p.state = 'active' and (p.primary_phone is not null or p.primary_email is not null) then
    insert into deedbox.party_match_key (party, phone_key, email_key)
    values (p_party, deedbox.fold_phone(p.primary_phone), deedbox.fold_email(p.primary_email));
  end if;
end $$;

create or replace function deedbox.party_name_match_key_sync() returns trigger
language plpgsql as $$
begin
  perform deedbox.rebuild_party_match_keys(new.party);
  return null;
end $$;
create trigger party_name_match_key_sync after insert or update on deedbox.party_name
for each row execute function deedbox.party_name_match_key_sync();

create or replace function deedbox.party_match_key_sync() returns trigger
language plpgsql as $$
begin
  if tg_op = 'INSERT'
     or new.primary_phone is distinct from old.primary_phone
     or new.primary_email is distinct from old.primary_email
     or new.state is distinct from old.state then
    perform deedbox.rebuild_party_match_keys(new.id);
  end if;
  return null;
end $$;
create trigger party_match_key_sync after insert or update on deedbox.party
for each row execute function deedbox.party_match_key_sync();

------------------------------------------------------------------------------
-- Contact-point mirror: the primary contact rows maintain the party's mirrors in
-- the same transaction (which in turn refreshes the contact match key).
------------------------------------------------------------------------------
create or replace function deedbox.contact_point_mirror() returns trigger
language plpgsql as $$
declare p bigint; ph text; em text;
begin
  p := coalesce(new.party, old.party);
  select cp.value into ph from deedbox.contact_point cp
   where cp.party = p and cp.kind = 'phone' and cp.is_primary and cp.deleted_at is null limit 1;
  select cp.value into em from deedbox.contact_point cp
   where cp.party = p and cp.kind = 'email' and cp.is_primary and cp.deleted_at is null limit 1;
  update deedbox.party pt set primary_phone = ph, primary_email = lower(em)
   where pt.id = p
     and (pt.primary_phone is distinct from ph or pt.primary_email is distinct from lower(em));
  return null;
end $$;
-- only writes touching a primary row move the mirror: a non-primary insert
-- never clobbers a directly-held value.
create trigger contact_point_mirror_ins after insert on deedbox.contact_point
for each row when (new.is_primary) execute function deedbox.contact_point_mirror();
create trigger contact_point_mirror_upd after update on deedbox.contact_point
for each row when (old.is_primary or new.is_primary) execute function deedbox.contact_point_mirror();

------------------------------------------------------------------------------
-- Party state guard: merged pointers are sound; soft-delete only when wholly
-- unlinked (this domain's own party-bearing columns; later domains extend).
------------------------------------------------------------------------------
create or replace function deedbox.party_state_guard() returns trigger
language plpgsql as $$
declare tgt deedbox.party%rowtype;
begin
  if new.state = 'merged'
     and (tg_op = 'INSERT' or old.state <> 'merged'
          or new.merged_into is distinct from old.merged_into) then
    if new.merged_into = new.id then
      raise exception 'a party cannot merge into itself';
    end if;
    select * into tgt from deedbox.party where id = new.merged_into;
    if tgt.state <> 'active' or tgt.deleted_at is not null then
      raise exception 'merged_into must point at an active party';
    end if;
  end if;
  if new.deleted_at is not null and (tg_op = 'INSERT' or old.deleted_at is null) then
    if exists (select 1 from deedbox.matter m where m.client_party = new.id)
       or exists (select 1 from deedbox.matter_party mp where mp.party = new.id and mp.deleted_at is null)
       or exists (select 1 from deedbox.party_link pl
                   where (pl.from_party = new.id or pl.to_party = new.id) and pl.deleted_at is null)
       or exists (select 1 from deedbox.intake_record ir
                   where ir.prospect_party = new.id and ir.deleted_at is null)
       or exists (select 1 from deedbox.intake_party ip where ip.party = new.id and ip.deleted_at is null)
       or exists (select 1 from deedbox.custom_field_value cv where cv.party_value = new.id) then
      raise exception 'a party may be soft-deleted only when wholly unlinked';
    end if;
  end if;
  return new;
end $$;
-- (trigger created below, after party_link exists, so the guard can see it)

------------------------------------------------------------------------------
-- party_link.
------------------------------------------------------------------------------
create table deedbox.party_link (
    id bigint generated always as identity primary key,
    from_party bigint not null references deedbox.party(id),
    to_party bigint not null references deedbox.party(id),
    link_kind bigint not null references deedbox.choice_item(id),
    note text,
    created_at timestamptz not null default now(),
    deleted_at timestamptz,
    deleted_by bigint,
    check (from_party <> to_party)
);
create unique index party_link_unique
  on deedbox.party_link (from_party, to_party, link_kind) where deleted_at is null;
create index party_link_from_idx on deedbox.party_link (from_party);
create index party_link_to_idx on deedbox.party_link (to_party);
grant select, insert, update on deedbox.party_link to deedbox_app;

create or replace function deedbox.party_link_guard() returns trigger
language plpgsql as $$
begin
  if tg_op = 'UPDATE' then
    if new.from_party is distinct from old.from_party
       or new.to_party is distinct from old.to_party
       or new.link_kind is distinct from old.link_kind then
      raise exception 'a party link never re-aims; remove it and link afresh';
    end if;
    return new;
  end if;
  if exists (select 1 from deedbox.party p
              where p.id in (new.from_party, new.to_party) and p.state <> 'active') then
    raise exception 'a merged party cannot be linked';
  end if;
  return new;
end $$;
create trigger party_link_guard before insert or update on deedbox.party_link
for each row execute function deedbox.party_link_guard();

create trigger party_state_guard before insert or update on deedbox.party
for each row execute function deedbox.party_state_guard();

------------------------------------------------------------------------------
-- duplicate_decision — the permanent "create anyway".
------------------------------------------------------------------------------
create table deedbox.duplicate_decision (
    id bigint generated always as identity primary key,
    created_entity_type text not null check (created_entity_type in ('party','intake_record')),
    created_entity bigint not null,
    candidates_shown jsonb not null,
    decision_mode text not null default 'interactive'
      check (decision_mode in ('interactive','integration_deferred')),
    test boolean not null default false,
    decided_by_kind text not null default 'staff'
      check (decided_by_kind in ('staff','integration_key','system_job')),
    decided_by bigint not null,
    decided_at timestamptz not null default now(),
    reviewed_by bigint references deedbox.staff_member(id),
    reviewed_at timestamptz
);
create index duplicate_decision_entity_idx
  on deedbox.duplicate_decision (created_entity_type, created_entity);
create index duplicate_decision_queue_idx
  on deedbox.duplicate_decision (decision_mode) where reviewed_at is null and not test;
grant select, insert, update on deedbox.duplicate_decision to deedbox_app;

create or replace function deedbox.duplicate_decision_guard() returns trigger
language plpgsql as $$
begin
  if tg_op = 'DELETE' then
    raise exception 'duplicate decisions are never deleted';
  end if;
  if tg_op = 'INSERT' then
    if new.reviewed_by is not null or new.reviewed_at is not null then
      raise exception 'a duplicate decision is born unreviewed';
    end if;
    return new;
  end if;
  -- the single transition: unreviewed -> reviewed, on deferred rows only.
  if old.reviewed_at is not null then
    raise exception 'a reviewed duplicate decision is immutable';
  end if;
  if old.decision_mode <> 'integration_deferred' then
    raise exception 'interactive duplicate decisions are born terminal';
  end if;
  if new.reviewed_by is null or new.reviewed_at is null then
    raise exception 'a review must record who and when';
  end if;
  if new.created_entity_type is distinct from old.created_entity_type
     or new.created_entity is distinct from old.created_entity
     or new.candidates_shown is distinct from old.candidates_shown
     or new.decision_mode is distinct from old.decision_mode
     or new.test is distinct from old.test
     or new.decided_by_kind is distinct from old.decided_by_kind
     or new.decided_by is distinct from old.decided_by
     or new.decided_at is distinct from old.decided_at then
    raise exception 'only the review fields of a duplicate decision may change';
  end if;
  return new;
end $$;
create trigger duplicate_decision_guard before insert or update or delete on deedbox.duplicate_decision
for each row execute function deedbox.duplicate_decision_guard();

------------------------------------------------------------------------------
-- The bulk-operation record layer (runners land with the operations
-- domain; the record discipline lands now so merges can be recorded).
------------------------------------------------------------------------------
create table deedbox.bulk_operation (
    id bigint generated always as identity primary key,
    operation_kind text not null,
    dry_run_summary jsonb not null,
    committed_at timestamptz,
    committed_by bigint references deedbox.staff_member(id),
    reversible_until timestamptz not null,
    reversed_at timestamptz,
    reversed_by bigint references deedbox.staff_member(id),
    created_at timestamptz not null default now()
);
grant select, insert, update on deedbox.bulk_operation to deedbox_app;

create table deedbox.bulk_operation_item (
    id bigint generated always as identity primary key,
    operation bigint not null references deedbox.bulk_operation(id),
    entity_type text not null,
    entity bigint not null,
    before jsonb not null,
    after jsonb not null
);
create index bulk_operation_item_op_idx on deedbox.bulk_operation_item (operation);
grant select, insert on deedbox.bulk_operation_item to deedbox_app;

create or replace function deedbox.bulk_operation_guard() returns trigger
language plpgsql as $$
begin
  if tg_op = 'DELETE' then
    raise exception 'bulk operation records are never deleted';
  end if;
  if tg_op = 'INSERT' then
    return new;
  end if;
  if new.operation_kind is distinct from old.operation_kind
     or new.dry_run_summary is distinct from old.dry_run_summary
     or new.reversible_until is distinct from old.reversible_until
     or new.created_at is distinct from old.created_at then
    raise exception 'a bulk operation record admits only its commit and reversal transitions';
  end if;
  if (old.committed_at is not null and (new.committed_at is distinct from old.committed_at
                                        or new.committed_by is distinct from old.committed_by))
     or (old.reversed_at is not null and (new.reversed_at is distinct from old.reversed_at
                                          or new.reversed_by is distinct from old.reversed_by)) then
    raise exception 'a recorded bulk transition is immutable';
  end if;
  if new.reversed_at is not null and new.committed_at is null then
    raise exception 'only a committed bulk operation can reverse';
  end if;
  return new;
end $$;
create trigger bulk_operation_guard before insert or update or delete on deedbox.bulk_operation
for each row execute function deedbox.bulk_operation_guard();

------------------------------------------------------------------------------
-- party_merge — the permanent merge record.
------------------------------------------------------------------------------
create table deedbox.party_merge (
    id bigint generated always as identity primary key,
    survivor bigint not null references deedbox.party(id),
    absorbed bigint not null references deedbox.party(id),
    absorbed_snapshot jsonb not null,
    repointed_links jsonb not null,
    performed_by bigint not null references deedbox.staff_member(id),
    performed_at timestamptz not null default now(),
    undone_at timestamptz,
    bulk_operation bigint not null references deedbox.bulk_operation(id),
    check (survivor <> absorbed)
);
create index party_merge_survivor_idx on deedbox.party_merge (survivor);
create index party_merge_absorbed_idx on deedbox.party_merge (absorbed);
grant select, insert, update on deedbox.party_merge to deedbox_app;

create or replace function deedbox.party_merge_guard() returns trigger
language plpgsql as $$
begin
  if tg_op = 'DELETE' then
    raise exception 'merge records are never deleted';
  end if;
  if tg_op = 'INSERT' then
    if new.undone_at is not null then
      raise exception 'a merge is not born undone';
    end if;
    return new;
  end if;
  if old.undone_at is not null then
    raise exception 'an undone merge record is immutable';
  end if;
  if new.survivor is distinct from old.survivor
     or new.absorbed is distinct from old.absorbed
     or new.absorbed_snapshot is distinct from old.absorbed_snapshot
     or new.repointed_links is distinct from old.repointed_links
     or new.performed_by is distinct from old.performed_by
     or new.performed_at is distinct from old.performed_at
     or new.bulk_operation is distinct from old.bulk_operation then
    raise exception 'a merge record admits exactly one mutation: setting undone_at';
  end if;
  if new.undone_at is null then
    raise exception 'a merge record admits exactly one mutation: setting undone_at';
  end if;
  return new;
end $$;
create trigger party_merge_guard before insert or update or delete on deedbox.party_merge
for each row execute function deedbox.party_merge_guard();

------------------------------------------------------------------------------
-- conflict_check — permanently recorded, immutable, never re-resolved —
-- with its once-written snapshot-name companion.
------------------------------------------------------------------------------
create table deedbox.conflict_check (
    id bigint generated always as identity primary key,
    run_by_kind text not null default 'staff' check (run_by_kind in ('staff','system_job')),
    run_by bigint not null,
    run_at timestamptz not null default now(),
    terms jsonb not null,
    attached_to_kind text not null default 'none'
      check (attached_to_kind in ('matter','intake_record','none')),
    attached_to bigint,
    result_snapshot jsonb not null,
    check ((attached_to_kind = 'none') = (attached_to is null))
);
create index conflict_check_attached_idx on deedbox.conflict_check (attached_to_kind, attached_to);
create index conflict_check_run_at_idx on deedbox.conflict_check (run_at);
grant select, insert, update on deedbox.conflict_check to deedbox_app;

create or replace function deedbox.conflict_check_guard() returns trigger
language plpgsql as $$
declare ok boolean;
begin
  if tg_op = 'DELETE' then
    raise exception 'conflict checks are never deleted';
  end if;
  if tg_op = 'INSERT' then
    ok := true;
  else
    -- the single sanctioned transition: attaching an unattached check.
    if old.attached_to_kind <> 'none' then
      raise exception 'a conflict check is immutable once attached';
    end if;
    if new.attached_to_kind = 'none'
       or new.run_by_kind is distinct from old.run_by_kind
       or new.run_by is distinct from old.run_by
       or new.run_at is distinct from old.run_at
       or new.terms is distinct from old.terms
       or new.result_snapshot is distinct from old.result_snapshot then
      raise exception 'a conflict check admits exactly one mutation: its attachment';
    end if;
    ok := true;
  end if;
  if new.attached_to_kind = 'matter' then
    select exists (select 1 from deedbox.matter m where m.id = new.attached_to) into ok;
  elsif new.attached_to_kind = 'intake_record' then
    select exists (select 1 from deedbox.intake_record ir where ir.id = new.attached_to) into ok;
  end if;
  if not ok then
    raise exception 'conflict check attachment target does not exist';
  end if;
  return new;
end $$;
create trigger conflict_check_guard before insert or update or delete on deedbox.conflict_check
for each row execute function deedbox.conflict_check_guard();

create table deedbox.conflict_snapshot_name (
    id bigint generated always as identity primary key,
    "check" bigint not null references deedbox.conflict_check(id),
    name_key text not null,
    name_phonetic text not null
);
create index conflict_snapshot_name_check_idx on deedbox.conflict_snapshot_name ("check");
create index conflict_snapshot_name_trgm
  on deedbox.conflict_snapshot_name using gin (name_key extensions.gin_trgm_ops);
grant select, insert on deedbox.conflict_snapshot_name to deedbox_app;

create or replace function deedbox.conflict_snapshot_name_guard() returns trigger
language plpgsql as $$
begin
  raise exception 'snapshot name rows are written once at check insert, never changed';
end $$;
create trigger conflict_snapshot_name_guard before update or delete on deedbox.conflict_snapshot_name
for each row execute function deedbox.conflict_snapshot_name_guard();

------------------------------------------------------------------------------
-- conflict_resolution — one per check, insert-only.
------------------------------------------------------------------------------
create table deedbox.conflict_resolution (
    id bigint generated always as identity primary key,
    "check" bigint not null unique references deedbox.conflict_check(id),
    resolution text not null check (resolution in ('no_conflict_found','conflict_found_action_taken')),
    action_note text,
    resolved_by bigint not null references deedbox.staff_member(id),
    resolved_at timestamptz not null default now(),
    check ((resolution = 'conflict_found_action_taken') <= (action_note is not null and action_note <> ''))
);
grant select, insert on deedbox.conflict_resolution to deedbox_app;

create or replace function deedbox.conflict_resolution_guard() returns trigger
language plpgsql as $$
begin
  raise exception 'conflict resolutions are insert-only';
end $$;
create trigger conflict_resolution_guard before update or delete on deedbox.conflict_resolution
for each row execute function deedbox.conflict_resolution_guard();

------------------------------------------------------------------------------
-- The duplicate-check service (read-only). Name + contact: fuzzy name
-- AND exact contact. Name only: exact normalised name matches, no fuzzy sweep.
------------------------------------------------------------------------------
create or replace function deedbox.duplicate_candidates(
    p_name text, p_phone text default null, p_email text default null)
returns table (party bigint) language sql stable as $$
  with input as (
    select deedbox.fold_name(p_name) nk, deedbox.phonetic_name(p_name) npk,
           deedbox.fold_phone(p_phone) pk, deedbox.fold_email(p_email) ek
  )
  select distinct mk.party
    from deedbox.party_match_key mk
    join deedbox.party p on p.id = mk.party
    cross join input i
   where p.state = 'active' and p.deleted_at is null
     and mk.name_key is not null
     and case
           when i.pk is null and i.ek is null then mk.name_key = i.nk
           else (extensions.similarity(mk.name_key, i.nk) >= 0.4
                 or (i.npk <> '' and mk.name_phonetic = i.npk))
                and exists (select 1 from deedbox.party_match_key ck
                             where ck.party = mk.party and ck.name_key is null
                               and ((i.pk is not null and ck.phone_key = i.pk)
                                 or (i.ek is not null and ck.email_key = i.ek)))
         end;
$$;

commit;
