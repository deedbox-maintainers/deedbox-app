-- Tests for 0045_import_text_index_management. Run as deployment role AFTER
-- the full chain. Proves the drop captures-and-removes exactly the three
-- text-search trigram indexes (party-name matching untouched), reads and
-- writes keep working indexless, the rebuild restores byte-identical
-- definitions and clears the hold, both directions are idempotent, the app
-- role cannot reach the lever, and drift states refuse loudly.

begin;

grant deedbox_app to current_user;

create temporary table t0045_expected (index_name text primary key, index_def text not null) on commit drop;

do $$
declare
  trgm_before integer;
  trgm_after integer;
  n integer;
  captured integer;
begin
  -- T1 the chain's resting state: all three present, hold empty; remember
  --    their catalogue definitions and the schema's trigram-index count.
  insert into t0045_expected (index_name, index_def)
  select c.relname, pg_get_indexdef(i.indexrelid)
    from pg_index i
    join pg_class c on c.oid = i.indexrelid
    join pg_namespace ns on ns.oid = c.relnamespace
   where ns.nspname = 'deedbox'
     and c.relname in ('registered_text_trgm','search_index_title_trgm','search_index_body_trgm');
  get diagnostics captured = row_count;
  if captured <> 3 then
    raise exception 'T1 FAILED: expected the three text indexes in the chain, found %', captured;
  end if;
  select count(*) into n from deedbox.import_text_index_hold;
  if n <> 0 then
    raise exception 'T1 FAILED: the hold is not empty at rest (% rows)', n;
  end if;
  select count(*) into trgm_before from pg_indexes
   where schemaname = 'deedbox' and indexdef like '%gin_trgm_ops%';

  -- T2 drop: exactly three captured and removed; the hold carries their
  --    definitions verbatim; the party-name and conflict trigram indexes
  --    (0007) survive untouched.
  select deedbox.import_text_indexes_drop() into n;
  if n <> 3 then
    raise exception 'T2 FAILED: drop reported % indexes, expected 3', n;
  end if;
  select count(*) into trgm_after from pg_indexes
   where schemaname = 'deedbox' and indexdef like '%gin_trgm_ops%';
  if trgm_after <> trgm_before - 3 then
    raise exception 'T2 FAILED: trigram count went % -> %, expected exactly three fewer', trgm_before, trgm_after;
  end if;
  select count(*) into n from t0045_expected e
   where exists (select 1 from pg_indexes p
                  where p.schemaname = 'deedbox' and p.indexname = e.index_name);
  if n <> 0 then
    raise exception 'T2 FAILED: % of the three indexes still present after drop', n;
  end if;
  select count(*) into n
    from deedbox.import_text_index_hold h
    join t0045_expected e on e.index_name = h.index_name and e.index_def = h.index_def;
  if n <> 3 then
    raise exception 'T2 FAILED: the hold does not carry the three definitions verbatim (% match)', n;
  end if;
  if not exists (select 1 from pg_indexes
                  where schemaname = 'deedbox' and tablename = 'party_match_key'
                    and indexdef like '%gin_trgm_ops%') then
    raise exception 'T2 FAILED: the party-name match index was taken down — the duplicate check depends on it';
  end if;
  if not exists (select 1 from pg_indexes
                  where schemaname = 'deedbox' and tablename = 'conflict_snapshot_name'
                    and indexdef like '%gin_trgm_ops%') then
    raise exception 'T2 FAILED: the conflict-snapshot name index was taken down';
  end if;

  -- T3 indexless operation: the stores still accept writes and answer reads.
  perform deedbox.search_upsert('note', 990045, 'indexless probe title', 'indexless probe body text', null, null);
  if not exists (select 1 from deedbox.search_index
                  where entry_type = 'note' and source = 990045
                    and body ilike '%indexless probe body%') then
    raise exception 'T3 FAILED: a search row written indexless did not come back by text';
  end if;
  perform deedbox.corpus_upsert('tests', 'probe_0045', 'p1', 'indexless corpus probe content', null, null);
  if not exists (select 1 from deedbox.registered_text
                  where source_module = 'tests' and source_type = 'probe_0045'
                    and content ilike '%indexless corpus probe%' and superseded_at is null) then
    raise exception 'T3 FAILED: a corpus row written indexless did not come back by text';
  end if;

  -- T4 drop again: a no-op, not an error; the hold is unchanged.
  select deedbox.import_text_indexes_drop() into n;
  if n <> 0 then
    raise exception 'T4 FAILED: a second drop reported % indexes, expected 0', n;
  end if;
  select count(*) into n from deedbox.import_text_index_hold;
  if n <> 3 then
    raise exception 'T4 FAILED: the hold changed on a no-op drop (% rows)', n;
  end if;

  -- T5 rebuild: all three come back with definitions identical to the
  --    catalogue's originals, and the hold is cleared.
  select deedbox.import_text_indexes_rebuild() into n;
  if n <> 3 then
    raise exception 'T5 FAILED: rebuild reported % indexes, expected 3', n;
  end if;
  select count(*) into n
    from t0045_expected e
    join pg_index i on true
    join pg_class c on c.oid = i.indexrelid and c.relname = e.index_name
    join pg_namespace ns on ns.oid = c.relnamespace and ns.nspname = 'deedbox'
   where pg_get_indexdef(i.indexrelid) = e.index_def;
  if n <> 3 then
    raise exception 'T5 FAILED: rebuilt definitions do not equal the originals (% of 3 match)', n;
  end if;
  select count(*) into n from deedbox.import_text_index_hold;
  if n <> 0 then
    raise exception 'T5 FAILED: the hold still carries % rows after rebuild', n;
  end if;

  -- T6 rebuild again: a no-op, not an error.
  select deedbox.import_text_indexes_rebuild() into n;
  if n <> 0 then
    raise exception 'T6 FAILED: a second rebuild reported % indexes, expected 0', n;
  end if;

  -- T7 the app role cannot reach the lever.
  begin
    set local role deedbox_app;
    perform deedbox.import_text_indexes_drop();
    reset role;
    raise exception 'T7 FAILED: the app role executed the drop lever';
  exception when others then
    reset role;
    if sqlerrm not like '%permission denied%' then raise; end if;
  end;

  -- T8 drift refuses loudly: an index missing with no hold row is schema
  --    drift, never silently papered over.
  execute 'drop index deedbox.search_index_body_trgm';
  begin
    perform deedbox.import_text_indexes_drop();
    raise exception 'T8 FAILED: drop accepted a neither-present-nor-held index';
  exception when others then
    if sqlerrm not like '%neither present nor held%' then raise; end if;
  end;
end $$;

rollback;
