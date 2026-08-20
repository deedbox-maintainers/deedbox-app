-- 0006_matters_completion — the matters domain completed: the text corpus with
-- synchronous core-writer registration, matter close requests with the born-approved
-- path and the close-position single-home rule, notes, matter relations, intake, and
-- the automatic client matter-party row ("two views of one fact"). Covers the
-- client-change discipline and the row-level mechanics; the operations' register
-- emission and workflow calls are app-layer, later stages.
--
-- Implementation notes:
--   * Core-writer corpus registration (matter title/summary/origin note, note
--     bodies, intake about/notes, party notes) is enforced by TRIGGERS on the owning
--     tables — the "same transaction" guarantee is mechanical, not a code-discipline
--     promise. External modules' registration interface (auth, rate limits) is an
--     app-layer operation over the same corpus_upsert/corpus_withdraw functions.
--   * Intake corpus rows carry party = prospect_party (the record's natural
--     ref); matter stays null (the record predates any matter).
--   * The close-position rule is enforced structurally: a matter
--     cannot reach closed from open/on_hold unless EXACTLY ONE approved close request
--     whose decided_at equals the closing transaction's timestamp exists, and no
--     pending request remains. Close operations must therefore stamp decided_at with
--     now() in the closing transaction. The money-side hard guard (ledger zero,
--     instruments, earmarks) arrives with the client-money stage and will bolt onto
--     the same close path.
--   * Approver separation binds approved and rejected decisions (decider acts);
--     withdrawal is exempt — withdrawal is sanctioned "by requester".
--   * Matters are born open (the only entry transition is (create) → open). The
--     import domain will carry its own sanctioned path for history loads when it
--     arrives.
--   * intake_record.source_integration_key is a bare column for now; the FK
--     lands with the inbound-interface domain.
--   * The intake.enabled gate is enforced at insert (no new approach can be recorded
--     while intake is off); surface/operation gating of existing rows is the app
--     layer's duty.
--   * Corpus erasure (privacy.erasure, payload-key destruction) ships with the
--     erasure operation in a later change file, which will amend the immutability
--     guard; until then corpus rows admit exactly one mutation — the supersede
--     transition.
--   * pg_trgm is installed into the `extensions` schema (the platform's convention);
--     the corpus trigram index is built with the qualified operator class.
--   * A matter close is also refused while any OTHER pending close request
--     remains undecided — the position must have exactly one home.

begin;

create extension if not exists pg_trgm with schema extensions;

------------------------------------------------------------------------------
-- registered_text — the universal searchable text corpus.
-- Insert-plus-supersede, never edited; one current row per source key.
------------------------------------------------------------------------------
create table deedbox.registered_text (
    id bigint generated always as identity primary key,
    source_module text not null,
    source_type text not null,
    source_ref text not null,
    matter bigint references deedbox.matter(id),
    party bigint references deedbox.party(id),
    content text not null,
    registered_at timestamptz not null default now(),
    superseded_at timestamptz
);
create unique index registered_text_current_unique
  on deedbox.registered_text (source_module, source_type, source_ref)
  where superseded_at is null;
create index registered_text_matter_idx on deedbox.registered_text (matter);
create index registered_text_party_idx on deedbox.registered_text (party);
create index registered_text_trgm
  on deedbox.registered_text using gin (content extensions.gin_trgm_ops);
grant select, insert, update on deedbox.registered_text to deedbox_app;

create or replace function deedbox.registered_text_guard() returns trigger
language plpgsql as $$
begin
  if tg_op = 'DELETE' then
    raise exception 'corpus rows are never deleted (supersede instead)';
  end if;
  -- the single sanctioned mutation: current -> superseded, nothing else moves.
  if old.superseded_at is not null then
    raise exception 'a superseded corpus row is immutable';
  end if;
  if new.superseded_at is null
     or new.source_module is distinct from old.source_module
     or new.source_type   is distinct from old.source_type
     or new.source_ref    is distinct from old.source_ref
     or new.matter        is distinct from old.matter
     or new.party         is distinct from old.party
     or new.content       is distinct from old.content
     or new.registered_at is distinct from old.registered_at then
    raise exception 'corpus rows admit exactly one mutation: setting superseded_at';
  end if;
  return new;
end $$;
create trigger registered_text_guard before update or delete on deedbox.registered_text
for each row execute function deedbox.registered_text_guard();

-- The registration interface's write half. Idempotent: identical current
-- content is a no-op. An upsert supersedes the old row and inserts the new.
create or replace function deedbox.corpus_upsert(
    p_module text, p_type text, p_ref text, p_content text,
    p_matter bigint default null, p_party bigint default null)
returns void language plpgsql as $$
declare cur deedbox.registered_text%rowtype;
begin
  select * into cur from deedbox.registered_text rt
   where rt.source_module = p_module and rt.source_type = p_type
     and rt.source_ref = p_ref and rt.superseded_at is null;
  if found then
    if cur.content = p_content
       and cur.matter is not distinct from p_matter
       and cur.party  is not distinct from p_party then
      return;                      -- identical re-registration: no-op
    end if;
    update deedbox.registered_text set superseded_at = now() where id = cur.id;
  end if;
  insert into deedbox.registered_text (source_module, source_type, source_ref, matter, party, content)
  values (p_module, p_type, p_ref, p_matter, p_party, p_content);
end $$;

-- A source deletion supersedes without replacement.
create or replace function deedbox.corpus_withdraw(p_module text, p_type text, p_ref text)
returns void language plpgsql as $$
begin
  update deedbox.registered_text set superseded_at = now()
   where source_module = p_module and source_type = p_type
     and source_ref = p_ref and superseded_at is null;
end $$;

------------------------------------------------------------------------------
-- matter_close_request — the close procedure's approval object.
------------------------------------------------------------------------------
create table deedbox.matter_close_request (
    id bigint generated always as identity primary key,
    matter bigint not null references deedbox.matter(id),
    requested_by bigint not null references deedbox.staff_member(id),
    financial_position jsonb not null,
    condition_evaluation jsonb not null,
    state text not null default 'pending'
      check (state in ('pending','approved','rejected','withdrawn')),
    decided_by bigint references deedbox.staff_member(id),
    decided_at timestamptz,
    decision_note text,
    created_at timestamptz not null default now()
);
create unique index close_request_one_pending
  on deedbox.matter_close_request (matter) where state = 'pending';
create index close_request_matter_idx on deedbox.matter_close_request (matter);
grant select, insert, update on deedbox.matter_close_request to deedbox_app;

create or replace function deedbox.close_request_guard() returns trigger
language plpgsql as $$
begin
  if tg_op = 'DELETE' then
    raise exception 'close requests are a permanent record and are never deleted';
  end if;
  if tg_op = 'INSERT' then
    if new.state = 'pending' then
      if new.decided_by is not null or new.decided_at is not null then
        raise exception 'a pending close request carries no decision';
      end if;
    elsif new.state = 'approved' then
      -- the born-approved path: approval setting off, the closer decides.
      if new.decided_by is null or new.decided_at is null then
        raise exception 'a born-approved close request must carry decided_by and decided_at';
      end if;
    else
      raise exception 'a close request is created pending or born approved, never %', new.state;
    end if;
    return new;
  end if;
  -- UPDATE: only pending rows move; approved/rejected/withdrawn are terminal.
  if old.state <> 'pending' then
    raise exception 'a decided close request is immutable';
  end if;
  if new.matter is distinct from old.matter
     or new.requested_by is distinct from old.requested_by
     or new.financial_position is distinct from old.financial_position
     or new.condition_evaluation is distinct from old.condition_evaluation
     or new.created_at is distinct from old.created_at then
    raise exception 'only the decision fields of a pending close request may change';
  end if;
  if new.state = 'pending' then
    raise exception 'a pending close request changes only by being decided';
  end if;
  if new.decided_by is null or new.decided_at is null then
    raise exception 'a decision must record who and when';
  end if;
  if new.state in ('approved','rejected') and new.decided_by = new.requested_by then
    raise exception 'the requester never decides their own close request';
  end if;
  if new.state = 'rejected' and (new.decision_note is null or new.decision_note = '') then
    raise exception 'a rejection must carry a decision note';
  end if;
  return new;
end $$;
create trigger close_request_guard before insert or update or delete on deedbox.matter_close_request
for each row execute function deedbox.close_request_guard();

-- Invariant 19 (close position single home), enforced structurally: a matter
-- reaching closed carries exactly one approved close request decided in the
-- closing transaction, and no undecided request remains.
create or replace function deedbox.z_assert_close_position() returns trigger
language plpgsql as $$
declare fresh int; stale int;
begin
  select count(*) into fresh from deedbox.matter_close_request r
   where r.matter = new.id and r.state = 'approved' and r.decided_at = now();
  if fresh <> 1 then
    raise exception 'a matter close requires exactly one approved close request decided in the closing transaction (found %)', fresh;
  end if;
  select count(*) into stale from deedbox.matter_close_request r
   where r.matter = new.id and r.state = 'pending';
  if stale <> 0 then
    raise exception 'a matter cannot close while a close request remains pending';
  end if;
  return null;
end $$;
create constraint trigger z_assert_close_position
after update on deedbox.matter
deferrable initially immediate
for each row when (new.status = 'closed' and old.status in ('open','on_hold'))
execute function deedbox.z_assert_close_position();

------------------------------------------------------------------------------
-- Matter completion: matters are born open; the client-party discipline; the
-- automatic client matter-party row ("two views of one fact" — the
-- matter.client_party column is authoritative and the row follows it
-- transactionally).
------------------------------------------------------------------------------
create or replace function deedbox.matter_born_open() returns trigger
language plpgsql as $$
begin
  if new.status <> 'open' then
    raise exception 'matters are created open; % is not a creation state', new.status;
  end if;
  return new;
end $$;
create trigger matter_born_open before insert on deedbox.matter
for each row execute function deedbox.matter_born_open();

-- Validation half (before): the client must be an active, unmerged party;
-- a client change is only lawful on an open or on-hold matter.
create or replace function deedbox.matter_client_guard() returns trigger
language plpgsql as $$
declare p deedbox.party%rowtype;
begin
  if tg_op = 'UPDATE' and new.client_party is not distinct from old.client_party then
    return new;
  end if;
  if tg_op = 'UPDATE' and old.status in ('closed','archived') then
    raise exception 'the client may be changed only on an open or on-hold matter';
  end if;
  select * into p from deedbox.party where id = new.client_party;
  if p.state <> 'active' or p.deleted_at is not null then
    raise exception 'a matter client must be an active party (never merged or deleted)';
  end if;
  return new;
end $$;
create trigger matter_client_guard before insert or update on deedbox.matter
for each row execute function deedbox.matter_client_guard();

create or replace function deedbox.client_capacity_item() returns bigint
language sql stable as $$
  select ci.id from deedbox.choice_item ci
  join deedbox.choice_list cl on cl.id = ci.list
  where cl.purpose_key = 'matter_party_capacities' and ci.shipped_key = 'client';
$$;

-- Maintenance half (after): the client matter-party row follows the column.
create or replace function deedbox.matter_client_row_maintain() returns trigger
language plpgsql as $$
declare cap_client bigint; cap_related bigint;
begin
  cap_client := deedbox.client_capacity_item();
  if tg_op = 'UPDATE' and new.client_party is not distinct from old.client_party then
    return null;
  end if;
  if tg_op = 'UPDATE' then
    -- the old client's client-capacity row ends; the old client remains a
    -- matter party as related_party unless removed deliberately.
    update deedbox.matter_party
       set deleted_at = now()
     where matter = new.id and party = old.client_party
       and capacity = cap_client and deleted_at is null;
    select ci.id into cap_related from deedbox.choice_item ci
      join deedbox.choice_list cl on cl.id = ci.list
     where cl.purpose_key = 'matter_party_capacities' and ci.shipped_key = 'related_party';
    if not exists (select 1 from deedbox.matter_party mp
                    where mp.matter = new.id and mp.party = old.client_party
                      and mp.capacity = cap_related and mp.deleted_at is null) then
      insert into deedbox.matter_party (matter, party, capacity)
      values (new.id, old.client_party, cap_related);
    end if;
  end if;
  if not exists (select 1 from deedbox.matter_party mp
                  where mp.matter = new.id and mp.party = new.client_party
                    and mp.capacity = cap_client and mp.deleted_at is null) then
    insert into deedbox.matter_party (matter, party, capacity)
    values (new.id, new.client_party, cap_client);
  end if;
  return null;
end $$;
create trigger matter_client_row_maintain after insert or update on deedbox.matter
for each row execute function deedbox.matter_client_row_maintain();

-- The client row cannot be removed or forged directly: it follows the matter.
create or replace function deedbox.matter_party_client_guard() returns trigger
language plpgsql as $$
declare cap_client bigint; m_client bigint;
begin
  cap_client := deedbox.client_capacity_item();
  if tg_op = 'INSERT' then
    if new.capacity = cap_client then
      select client_party into m_client from deedbox.matter where id = new.matter;
      if new.party <> m_client then
        raise exception 'the client row follows matter.client_party; another party cannot hold the client capacity';
      end if;
    end if;
    return new;
  end if;
  -- UPDATE: refuse ending or re-aiming the live client row out from under the
  -- authoritative column (the client-change trigger's own end is lawful
  -- because by then the column already names the successor).
  if old.capacity = cap_client and old.deleted_at is null then
    select client_party into m_client from deedbox.matter where id = old.matter;
    if old.party = m_client
       and (new.deleted_at is not null
            or new.party is distinct from old.party
            or new.capacity is distinct from old.capacity) then
      raise exception 'the client row follows matter.client_party and cannot be removed or altered directly';
    end if;
  end if;
  return new;
end $$;
create trigger matter_party_client_guard before insert or update on deedbox.matter_party
for each row execute function deedbox.matter_party_client_guard();

------------------------------------------------------------------------------
-- note — free text on a matter, intake record or party.
------------------------------------------------------------------------------
create table deedbox.note (
    id bigint generated always as identity primary key,
    owner_type text not null check (owner_type in ('matter','intake_record','party')),
    owner bigint not null,
    body text not null,
    noted_at timestamptz not null default now(),
    created_at timestamptz not null default now(),
    deleted_at timestamptz,
    deleted_by bigint
);
create index note_owner_idx on deedbox.note (owner_type, owner);
grant select, insert, update on deedbox.note to deedbox_app;

create or replace function deedbox.note_owner_guard() returns trigger
language plpgsql as $$
declare ok boolean;
begin
  if tg_op = 'UPDATE' and (new.owner_type is distinct from old.owner_type
                           or new.owner is distinct from old.owner) then
    raise exception 'a note never moves to another owner';
  end if;
  if tg_op = 'INSERT' then
    if new.owner_type = 'matter' then
      select exists (select 1 from deedbox.matter m where m.id = new.owner) into ok;
    elsif new.owner_type = 'intake_record' then
      select exists (select 1 from deedbox.intake_record ir where ir.id = new.owner) into ok;
    else
      select exists (select 1 from deedbox.party p where p.id = new.owner) into ok;
    end if;
    if not ok then
      raise exception 'note owner % % does not exist', new.owner_type, new.owner;
    end if;
  end if;
  return new;
end $$;
-- (trigger created below, after intake_record exists, so the guard can see it)

create or replace function deedbox.note_corpus_sync() returns trigger
language plpgsql as $$
declare m bigint; p bigint;
begin
  if new.deleted_at is not null then
    if tg_op = 'INSERT' or old.deleted_at is null then
      perform deedbox.corpus_withdraw('core', 'note', new.id::text);
    end if;
    return null;
  end if;
  m := case when new.owner_type = 'matter' then new.owner end;
  p := case when new.owner_type = 'party' then new.owner end;
  perform deedbox.corpus_upsert('core', 'note', new.id::text, new.body, m, p);
  return null;
end $$;
create trigger note_corpus_sync after insert or update on deedbox.note
for each row execute function deedbox.note_corpus_sync();

------------------------------------------------------------------------------
-- matter_relation — a labelled link between matters, stored canonically.
------------------------------------------------------------------------------
create table deedbox.matter_relation (
    id bigint generated always as identity primary key,
    matter_a bigint not null references deedbox.matter(id),
    matter_b bigint not null references deedbox.matter(id),
    label bigint not null references deedbox.choice_item(id),
    carried_parties boolean not null default false,
    created_at timestamptz not null default now(),
    deleted_at timestamptz,
    deleted_by bigint,
    check (matter_a < matter_b)
);
create unique index matter_relation_unique
  on deedbox.matter_relation (matter_a, matter_b, label) where deleted_at is null;
create index matter_relation_a_idx on deedbox.matter_relation (matter_a);
create index matter_relation_b_idx on deedbox.matter_relation (matter_b);
grant select, insert, update on deedbox.matter_relation to deedbox_app;

create or replace function deedbox.matter_relation_guard() returns trigger
language plpgsql as $$
declare t bigint; area_x bigint; area_y bigint; verdict boolean;
begin
  if tg_op = 'UPDATE' then
    -- relation rows are insert + soft-delete/restore; ends and label never move.
    if new.matter_a is distinct from old.matter_a
       or new.matter_b is distinct from old.matter_b
       or new.label is distinct from old.label then
      raise exception 'a matter relation never re-aims; remove it and relate afresh';
    end if;
    return new;
  end if;
  if new.matter_a = new.matter_b then
    raise exception 'a matter cannot relate to itself';
  end if;
  if new.matter_a > new.matter_b then          -- canonical: lower id first
    t := new.matter_a; new.matter_a := new.matter_b; new.matter_b := t;
  end if;
  select m.practice_area into area_x from deedbox.matter m where m.id = new.matter_a;
  select m.practice_area into area_y from deedbox.matter m where m.id = new.matter_b;
  select bool_and(r.allowed) into verdict
    from deedbox.practice_area_relatable r
   where (r.area_a = area_x and r.area_b = area_y)
      or (r.area_a = area_y and r.area_b = area_x);
  if verdict is null then                       -- absent pair: the setting decides
    verdict := (deedbox.current_setting_value('matter.relations_absent_means_allowed') = 'true'::jsonb);
  end if;
  if not verdict then
    raise exception 'matters in these practice areas may not be related';
  end if;
  return new;
end $$;
create trigger matter_relation_guard before insert or update on deedbox.matter_relation
for each row execute function deedbox.matter_relation_guard();

------------------------------------------------------------------------------
-- intake_stage — firm-defined ordered stages.
------------------------------------------------------------------------------
create table deedbox.intake_stage (
    id bigint generated always as identity primary key,
    name text not null,
    position int not null,
    active boolean not null default true,
    created_at timestamptz not null default now()
);
create unique index intake_stage_name_unique on deedbox.intake_stage (name) where active;
create unique index intake_stage_position_unique on deedbox.intake_stage (position) where active;
grant select, insert, update on deedbox.intake_stage to deedbox_app;

------------------------------------------------------------------------------
-- intake_record — an approach from a prospective client.
------------------------------------------------------------------------------
create table deedbox.intake_record (
    id bigint generated always as identity primary key,
    prospect_party bigint not null references deedbox.party(id),
    contact_phone text not null,
    contact_email text,
    address jsonb,
    about text not null,
    notes text,
    practice_area bigint references deedbox.practice_area(id),
    stage bigint references deedbox.intake_stage(id),
    outcome_reason bigint references deedbox.choice_item(id),
    outcome_note text,
    outcome_at timestamptz,
    converted_matter bigint references deedbox.matter(id),
    source_integration_key bigint,   -- FK lands with the inbound-interface domain
    test_flag boolean not null default false,
    state text not null default 'open' check (state in ('open','converted','closed')),
    created_at timestamptz not null default now(),
    deleted_at timestamptz,
    deleted_by bigint,
    check ((state = 'converted') = (converted_matter is not null))
);
create unique index intake_converted_matter_unique
  on deedbox.intake_record (converted_matter) where converted_matter is not null;
create index intake_state_idx on deedbox.intake_record (state);
create index intake_stage_idx on deedbox.intake_record (stage);
create index intake_prospect_idx on deedbox.intake_record (prospect_party);
grant select, insert, update on deedbox.intake_record to deedbox_app;

create or replace function deedbox.intake_guard() returns trigger
language plpgsql as $$
begin
  if tg_op = 'INSERT' then
    if deedbox.current_setting_value('intake.enabled') <> 'true'::jsonb then
      raise exception 'intake is switched off for this firm';
    end if;
    if new.state <> 'open' then
      raise exception 'an intake record is created open';
    end if;
    if new.outcome_reason is not null or new.outcome_note is not null then
      new.outcome_at := coalesce(new.outcome_at, now());
    end if;
    return new;
  end if;
  -- UPDATE. A converted record is terminal: the matter carries the work,
  -- and the record and its link are permanent.
  if old.state = 'converted' then
    raise exception 'a converted intake record is immutable';
  end if;
  if new.state is distinct from old.state then
    if not ( (old.state = 'open' and new.state in ('converted','closed'))
          or (old.state = 'closed' and new.state = 'open') ) then
      raise exception 'illegal intake state transition % -> %', old.state, new.state;
    end if;
  end if;
  if new.stage is distinct from old.stage and new.stage is not null then
    if not exists (select 1 from deedbox.intake_stage s where s.id = new.stage and s.active) then
      raise exception 'an intake record can only move to an active stage';
    end if;
  end if;
  -- outcome_at follows the outcome fields.
  if (new.outcome_reason is distinct from old.outcome_reason
      or new.outcome_note is distinct from old.outcome_note) then
    new.outcome_at := case when new.outcome_reason is null and new.outcome_note is null
                           then null else now() end;
  end if;
  return new;
end $$;
create trigger intake_guard before insert or update on deedbox.intake_record
for each row execute function deedbox.intake_guard();

create or replace function deedbox.intake_corpus_sync() returns trigger
language plpgsql as $$
begin
  if new.deleted_at is not null then
    if tg_op = 'INSERT' or old.deleted_at is null then
      perform deedbox.corpus_withdraw('core', 'intake_about', new.id::text);
      perform deedbox.corpus_withdraw('core', 'intake_note', new.id::text);
    end if;
    return null;
  end if;
  perform deedbox.corpus_upsert('core', 'intake_about', new.id::text, new.about, null, new.prospect_party);
  if new.notes is null then
    perform deedbox.corpus_withdraw('core', 'intake_note', new.id::text);
  else
    perform deedbox.corpus_upsert('core', 'intake_note', new.id::text, new.notes, null, new.prospect_party);
  end if;
  return null;
end $$;
create trigger intake_corpus_sync after insert or update on deedbox.intake_record
for each row execute function deedbox.intake_corpus_sync();

-- note_owner_guard needs intake_record to exist; created here.
create trigger note_owner_guard before insert or update on deedbox.note
for each row execute function deedbox.note_owner_guard();

------------------------------------------------------------------------------
-- intake_party — named other-side and related parties as data.
------------------------------------------------------------------------------
create table deedbox.intake_party (
    id bigint generated always as identity primary key,
    intake bigint not null references deedbox.intake_record(id),
    party bigint not null references deedbox.party(id),
    capacity bigint not null references deedbox.choice_item(id),
    created_at timestamptz not null default now(),
    deleted_at timestamptz,
    deleted_by bigint
);
create unique index intake_party_unique
  on deedbox.intake_party (intake, party, capacity) where deleted_at is null;
create index intake_party_party_idx on deedbox.intake_party (party);
grant select, insert, update on deedbox.intake_party to deedbox_app;

------------------------------------------------------------------------------
-- Corpus synchronisation for the core writers that already existed:
-- matter title/summary/origin note; party notes.
------------------------------------------------------------------------------
create or replace function deedbox.matter_corpus_sync() returns trigger
language plpgsql as $$
begin
  if tg_op = 'INSERT' or new.title is distinct from old.title then
    perform deedbox.corpus_upsert('core', 'matter_title', new.id::text, new.title, new.id, null);
  end if;
  if tg_op = 'INSERT' or new.summary is distinct from old.summary then
    if new.summary is null then
      perform deedbox.corpus_withdraw('core', 'matter_summary', new.id::text);
    else
      perform deedbox.corpus_upsert('core', 'matter_summary', new.id::text, new.summary, new.id, null);
    end if;
  end if;
  if tg_op = 'INSERT' or new.origin_note is distinct from old.origin_note then
    if new.origin_note is null then
      perform deedbox.corpus_withdraw('core', 'matter_origin_note', new.id::text);
    else
      perform deedbox.corpus_upsert('core', 'matter_origin_note', new.id::text, new.origin_note, new.id, null);
    end if;
  end if;
  return null;
end $$;
create trigger matter_corpus_sync after insert or update on deedbox.matter
for each row execute function deedbox.matter_corpus_sync();

create or replace function deedbox.party_corpus_sync() returns trigger
language plpgsql as $$
begin
  if new.deleted_at is not null then
    if tg_op = 'INSERT' or old.deleted_at is null then
      perform deedbox.corpus_withdraw('core', 'party_note', new.id::text);
    end if;
    return null;
  end if;
  if tg_op = 'INSERT' or new.notes is distinct from old.notes
     or (tg_op = 'UPDATE' and old.deleted_at is not null) then
    if new.notes is null then
      perform deedbox.corpus_withdraw('core', 'party_note', new.id::text);
    else
      perform deedbox.corpus_upsert('core', 'party_note', new.id::text, new.notes, null, new.id);
    end if;
  end if;
  return null;
end $$;
create trigger party_corpus_sync after insert or update on deedbox.party
for each row execute function deedbox.party_corpus_sync();

------------------------------------------------------------------------------
-- Fast-lookup matter indexes that 0004 deferred.
------------------------------------------------------------------------------
create index matter_status_office_idx on deedbox.matter (status, office);
create index matter_practice_area_idx on deedbox.matter (practice_area);
create index matter_restricted_idx on deedbox.matter (restricted) where restricted;
create index matter_opened_idx on deedbox.matter (opened_date);
create index matter_closed_idx on deedbox.matter (closed_date);

commit;
