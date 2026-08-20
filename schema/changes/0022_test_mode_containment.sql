-- 0022_test_mode_containment — a schema defect found by the
-- inbound-interface tests.
--
-- PARTY carries a `test` flag — set from test-mode integration keys,
-- excluded from every business surface, retained flagged for audit —
-- and test-key records must appear on ZERO business surfaces. As
-- built, party had no test column at all, and the synchronous text-corpus
-- and search-index feeders indexed test intake records and test parties like
-- any other row — a test submission's name and enquiry text would have
-- surfaced in search, in the conflict-check trigram sweep, and in the
-- duplicate-candidates dialog.
--
-- This change adds the column and teaches the four feeders and the
-- duplicate-candidate function to skip test rows. The flag is set only at
-- creation (by the inbound interface, from the key) and is immutable, so a
-- record can never move between the test and business worlds.

begin;

alter table deedbox.party add column test boolean not null default false;

-- The flag never changes after birth: a test record cannot be promoted into
-- the business world, and a real record cannot be hidden by flagging it.
create or replace function deedbox.party_test_immutable() returns trigger
language plpgsql as $$
begin
  if new.test is distinct from old.test then
    raise exception 'a party''s test flag is set at creation and never changes';
  end if;
  return new;
end $$;
create trigger party_test_immutable before update on deedbox.party
for each row execute function deedbox.party_test_immutable();

-- Corpus feeder (0006): a test party's notes never enter the searchable
-- corpus. The flag is immutable, so no withdraw path is needed for flips.
create or replace function deedbox.party_corpus_sync() returns trigger
language plpgsql as $$
begin
  if new.test then
    return null;
  end if;
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

-- Corpus feeder (0006): a test intake's about/notes text never enters the
-- corpus (which the conflict-check trigram sweep reads).
create or replace function deedbox.intake_corpus_sync() returns trigger
language plpgsql as $$
begin
  if new.test_flag then
    return null;
  end if;
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

-- Search feeder (0016): a test party's names never enter the search index.
create or replace function deedbox.party_name_search_sync() returns trigger
language plpgsql as $$
begin
  if exists (select 1 from deedbox.party p where p.id = new.party and p.test) then
    return null;
  end if;
  perform deedbox.search_upsert('party', new.id, new.full_name, '', null, null);
  return null;
end $$;

-- Search feeder (0016): custom-field values on a test intake record never
-- enter the search index (the inbound interface lands sender extras there).
create or replace function deedbox.custom_value_search_sync() returns trigger
language plpgsql as $$
begin
  if new.owner_type = 'intake_record'
     and exists (select 1 from deedbox.intake_record i where i.id = new.owner and i.test_flag) then
    return null;
  end if;
  if new.text_value is not null then
    perform deedbox.search_upsert('custom_field_value', new.id, left(new.text_value, 80), new.text_value,
      case when new.owner_type = 'matter' then new.owner end);
  else
    perform deedbox.search_remove('custom_field_value', new.id);
  end if;
  return null;
end $$;

-- Duplicate candidates (0007): the dialog is a business surface — test
-- parties never appear as candidates.
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
   where p.state = 'active' and p.deleted_at is null and not p.test
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
