-- 0047 — a matter is findable by the people and numbers a firm actually
-- knows it by.
--
-- The matter's search entry carried only its number, title and summary
-- (0016). Real firms' matter titles often carry NO client name (migrated
-- titles are often bare file references), and the prior-system
-- number (0043) was displayed but not searchable — so typing a client's
-- name, or the number the firm used for years, found nothing. The matter's
-- search entry now carries, in its body: the prior-system reference, the
-- client's current name, and the summary. When a client's name changes,
-- every matter naming them re-indexes.
--
-- Re-indexing writes the search entry DIRECTLY (search_upsert): the matter
-- rows themselves are never touched, so the matter guards, corpus sync and
-- register stay out of it — a search entry is derived presentation, not a
-- record change.

create or replace function deedbox.matter_search_body(p_matter deedbox.matter)
returns text language sql stable as $$
  select trim(coalesce(p_matter.prior_reference, '') || ' '
              || coalesce((select p.display_name from deedbox.party p
                            where p.id = p_matter.client_party), '') || ' '
              || coalesce(p_matter.summary, ''));
$$;

create or replace function deedbox.matter_search_sync() returns trigger
language plpgsql as $$
begin
  perform deedbox.search_upsert('matter', new.id,
    new.matter_number || ' ' || new.title,
    deedbox.matter_search_body(new),
    new.id);
  return null;
end $$;

-- A client's name is part of every one of their matters' search entries.
-- Name changes arrive on party_name rows and on the party row's own
-- display_name; both re-index the party's matters directly.
create or replace function deedbox.party_matters_reindex(p_party bigint)
returns void language plpgsql as $$
declare m deedbox.matter;
begin
  for m in select * from deedbox.matter where client_party = p_party loop
    perform deedbox.search_upsert('matter', m.id,
      m.matter_number || ' ' || m.title, deedbox.matter_search_body(m), m.id);
  end loop;
end $$;

create or replace function deedbox.party_matters_search_sync() returns trigger
language plpgsql as $$
begin
  perform deedbox.party_matters_reindex(new.party);
  return null;
end $$;

drop trigger if exists party_matters_search_sync on deedbox.party_name;
create trigger party_matters_search_sync after insert or update on deedbox.party_name
for each row execute function deedbox.party_matters_search_sync();

create or replace function deedbox.party_display_matters_sync() returns trigger
language plpgsql as $$
begin
  if new.display_name is distinct from old.display_name then
    perform deedbox.party_matters_reindex(new.id);
  end if;
  return null;
end $$;

drop trigger if exists party_display_matters_sync on deedbox.party;
create trigger party_display_matters_sync after update on deedbox.party
for each row execute function deedbox.party_display_matters_sync();

-- Re-index every existing matter under the new rule, directly.
select deedbox.search_upsert('matter', m.id,
         m.matter_number || ' ' || m.title, deedbox.matter_search_body(m), m.id)
  from deedbox.matter m;
