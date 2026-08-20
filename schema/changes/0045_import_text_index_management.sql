-- 0045 — import text-index management.
--
-- Archive-scale imports proved that maintaining the trigram text indexes one
-- record at a time does not scale: each inserted document pays an incremental
-- GIN update over an ever-growing index, the cost rises with the loaded
-- corpus, and once the working set outgrows memory every insert pays cold
-- disk reads until statements start timing out. The standard bulk-load
-- treatment is to take the text indexes down for the load and build them
-- once at the end — an index build is a single sort-based pass, not tens of
-- thousands of incremental updates.
--
-- This change gives the import machinery a sanctioned lever for exactly
-- that, so no operator ever hand-issues DDL around the engine:
--
--   * deedbox.import_text_index_hold — where a dropped index's definition
--     waits, captured verbatim from the catalogue at drop time. The
--     definitions are never written out by hand anywhere else, so a future
--     change to 0006/0016 index definitions cannot drift from what rebuild
--     recreates.
--   * deedbox.import_text_indexes_drop()    — capture + drop the three
--     text-search indexes (corpus content, search title, search body).
--   * deedbox.import_text_indexes_rebuild() — recreate each held index from
--     its captured definition and clear the hold.
--
-- Scope is deliberately exact: ONLY the three pure text-search trigram
-- indexes. The party-name match key index (0007) stays — the duplicate
-- check reads it on every imported client. Constraint-backing indexes
-- (primary keys, unique keys) are never touched: writes stay guarded
-- throughout the load, and dry/real determinism is unaffected because
-- index presence changes no row that any statement writes.
--
-- Both functions are owner-only operational tools: execute is revoked from
-- public and never granted to the app role. They are called by the
-- migration operator on the admin connection, in the same standing as
-- applying a schema change. They deliberately write no register entries —
-- like a schema application, they are infrastructure, not a record event.
--
-- Idempotence and drift honesty: dropping twice is a no-op; rebuilding
-- twice is a no-op; but an index that is neither present nor held, or held
-- AND present at once, is schema drift and refuses loudly rather than
-- guessing.

begin;

create table deedbox.import_text_index_hold (
    index_name text primary key,
    index_def text not null,
    dropped_at timestamptz not null default now()
);
-- No grants: the hold is the migration operator's, like the functions.

create or replace function deedbox.import_text_indexes_drop()
returns integer language plpgsql as $fn$
declare
  names constant text[] :=
    array['registered_text_trgm','search_index_title_trgm','search_index_body_trgm'];
  n text;
  def text;
  held boolean;
  dropped integer := 0;
begin
  foreach n in array names loop
    select pg_get_indexdef(i.indexrelid) into def
      from pg_index i
      join pg_class c on c.oid = i.indexrelid
      join pg_namespace ns on ns.oid = c.relnamespace
     where ns.nspname = 'deedbox' and c.relname = n;
    select exists (select 1 from deedbox.import_text_index_hold h where h.index_name = n)
      into held;
    if def is not null and held then
      raise exception 'import text index % is both present and held — schema drift, resolve by hand', n;
    end if;
    if def is null and not held then
      raise exception 'import text index % is neither present nor held — schema drift, resolve by hand', n;
    end if;
    if def is not null then
      insert into deedbox.import_text_index_hold (index_name, index_def) values (n, def);
      execute format('drop index deedbox.%I', n);
      dropped := dropped + 1;
    end if;
    -- def null + held: already down, waiting for rebuild — a no-op.
  end loop;
  return dropped;
end $fn$;

create or replace function deedbox.import_text_indexes_rebuild()
returns integer language plpgsql as $fn$
declare
  h record;
  present boolean;
  rebuilt integer := 0;
begin
  for h in select index_name, index_def from deedbox.import_text_index_hold order by index_name loop
    select exists (
      select 1 from pg_index i
        join pg_class c on c.oid = i.indexrelid
        join pg_namespace ns on ns.oid = c.relnamespace
       where ns.nspname = 'deedbox' and c.relname = h.index_name)
      into present;
    if present then
      raise exception 'held index % already exists — schema drift, resolve by hand', h.index_name;
    end if;
    execute h.index_def;
    delete from deedbox.import_text_index_hold where index_name = h.index_name;
    rebuilt := rebuilt + 1;
  end loop;
  return rebuilt;
end $fn$;

revoke execute on function deedbox.import_text_indexes_drop() from public;
revoke execute on function deedbox.import_text_indexes_rebuild() from public;

commit;
