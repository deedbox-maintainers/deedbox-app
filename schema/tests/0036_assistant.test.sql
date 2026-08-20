-- Tests for 0036_assistant. Run as deployment role AFTER the full chain.
-- Proves: the engine starter knowledge base ships published with chunks;
-- engine rows are UPDATE-refused and article identity is immutable; slug
-- uniqueness holds per scope (engine-global, per-firm); search finds by
-- keyword with an honest matched flag, respects status and firm scoping,
-- and the route matcher understands parameters and prefixes; telemetry
-- vocabularies are closed and messages are append-only through grants;
-- the capability and policy rows ship; chunks cascade with their article.

begin;

grant deedbox_app to current_user;

insert into deedbox.country_pack (code, name) values ('XAS','Assistant Test Pack');
insert into deedbox.firm (name, operating_currency, timezone, country_pack)
  select 'Assistant Test Firm','AUD','Australia/Sydney', id from deedbox.country_pack where code='XAS';
insert into deedbox.office (name, code) values ('AS Office','XAS1');

do $$
declare
  f bigint; f2 bigint; off bigint; rl bigint; st bigint;
  n integer; aid bigint; aid2 bigint; cid bigint; conv bigint; msg bigint;
begin
  select id into f from deedbox.firm where name = 'Assistant Test Firm';
  insert into deedbox.firm (name, operating_currency, timezone, country_pack)
    select 'Assistant Other Firm','AUD','Australia/Sydney', country_pack
      from deedbox.firm where id = f returning id into f2;
  select id into off from deedbox.office where code = 'XAS1';
  select id into rl from deedbox.role where system_key = 'administrator';
  insert into deedbox.staff_member (person_name, login, role, office, email)
    values ('{"given":"Ash","family":"Helper"}','ash.xas', rl, off, 'ash.xas@example.test')
    returning id into st;

  -- T1: the engine starter knowledge base ships: published, firm-less, chunked
  select count(*) into n from deedbox.assistant_article where origin = 'engine';
  if n < 15 then raise exception 'T1 FAIL: expected a seeded engine knowledge base, got % articles', n; end if;
  select count(*) into n from deedbox.assistant_article
   where origin = 'engine' and (status <> 'published' or firm is not null);
  if n <> 0 then raise exception 'T1 FAIL: engine articles must ship published with firm NULL'; end if;
  select count(*) into n from deedbox.assistant_article a
   where a.origin = 'engine'
     and not exists (select 1 from deedbox.assistant_chunk c where c.article = a.id);
  if n <> 0 then raise exception 'T1 FAIL: % engine articles have no retrieval chunk', n; end if;

  -- T2: the capability catalogue gained assistant.manage and the administrator holds it
  if not exists (select 1 from deedbox.capability where key = 'assistant.manage') then
    raise exception 'T2 FAIL: assistant.manage missing from the capability catalogue';
  end if;
  if not exists (select 1 from deedbox.role_capability rc
                  join deedbox.role r on r.id = rc.role
                 where r.system_key = 'administrator' and rc.capability = 'assistant.manage'
                   and rc.scope <> 'none') then
    raise exception 'T2 FAIL: the administrator does not hold assistant.manage';
  end if;

  set local role deedbox_app;
  perform set_config('deedbox.principal_kind','staff',true),
          set_config('deedbox.principal_id', st::text, true);

  -- T3: engine rows refuse UPDATE outright
  begin
    update deedbox.assistant_article set title = 'rewritten'
     where origin = 'engine' and slug = 'getting-started';
    raise exception 'T3 FAIL: engine article update accepted';
  exception when raise_exception then
    if sqlerrm like '%T3 FAIL%' then raise; end if;
  end;

  -- T4: firm authoring works; slug scopes hold (per-firm unique, cross-firm free)
  insert into deedbox.assistant_article (origin, firm, slug, title, summary, module, steps, status)
    values ('firm', f, 'zebrafish-handling', 'Handling zebrafish records',
            'How this firm records zebrafish matters in the aquarium module.', 'matters',
            '["Open the aquarium module.","Record the zebrafish."]'::jsonb, 'published')
    returning id into aid;
  insert into deedbox.assistant_chunk (article, chunk_index, heading, content, routes)
    values (aid, 0, 'Handling zebrafish records',
            'How this firm records zebrafish matters in the aquarium module.', '{}');
  begin
    insert into deedbox.assistant_article (origin, firm, slug, title, summary, module)
      values ('firm', f, 'zebrafish-handling', 'Duplicate', 'Duplicate.', 'matters');
    raise exception 'T4 FAIL: duplicate firm slug accepted';
  exception when unique_violation then null;
  end;
  insert into deedbox.assistant_article (origin, firm, slug, title, summary, module)
    values ('firm', f2, 'zebrafish-handling', 'Other firm same slug', 'Fine elsewhere.', 'matters')
    returning id into aid2;

  -- T5: article identity is immutable for firm rows too
  begin
    update deedbox.assistant_article set slug = 'renamed' where id = aid;
    raise exception 'T5 FAIL: slug change accepted';
  exception when raise_exception then
    if sqlerrm like '%T5 FAIL%' then raise; end if;
  end;

  -- T6: search — keyword hit is matched, firm-scoped, status-scoped
  select count(*) into n from deedbox.assistant_search(f, 'zebrafish', null, 8)
   where slug = 'zebrafish-handling' and matched;
  if n <> 1 then raise exception 'T6 FAIL: published firm article not found matched by its own word'; end if;
  select count(*) into n from deedbox.assistant_search(f2, 'zebrafish records aquarium', null, 8)
   where article_id = aid;
  if n <> 0 then raise exception 'T6 FAIL: another firm''s article leaked into search'; end if;
  select count(*) into n from deedbox.assistant_search(f, 'reconciling the bank statement', null, 8)
   where matched;
  if n < 1 then raise exception 'T6 FAIL: engine knowledge base not searchable'; end if;
  insert into deedbox.assistant_article (origin, firm, slug, title, summary, module, status)
    values ('firm', f, 'draft-quokka', 'Quokka drafting', 'Quokka quokka quokka.', 'matters', 'draft')
    returning id into cid;
  insert into deedbox.assistant_chunk (article, chunk_index, heading, content)
    values (cid, 0, 'Quokka drafting', 'Quokka quokka quokka.');
  select count(*) into n from deedbox.assistant_search(f, 'quokka', null, 8);
  if n <> 0 then raise exception 'T6 FAIL: a draft article is searchable'; end if;

  -- T7: the route matcher understands equality, prefixes and :params
  if not deedbox.assistant_route_matches('/matters/:id', '/matters/42') then
    raise exception 'T7 FAIL: parameter route did not match';
  end if;
  if not deedbox.assistant_route_matches('/billing', '/billing/runs') then
    raise exception 'T7 FAIL: prefix route did not match';
  end if;
  if deedbox.assistant_route_matches('/money', '/matters/42') then
    raise exception 'T7 FAIL: unrelated route matched';
  end if;

  -- T8: telemetry vocabularies are closed; messages append-only through grants
  insert into deedbox.assistant_conversation (firm, staff, entry_route)
    values (f, st, '/help') returning id into conv;
  insert into deedbox.assistant_message (conversation, role, content)
    values (conv, 'user', 'How do I reconcile?') returning id into msg;
  begin
    insert into deedbox.assistant_message (conversation, role, content)
      values (conv, 'robot', 'beep');
    raise exception 'T8 FAIL: unknown message role accepted';
  exception when check_violation then null;
  end;
  begin
    update deedbox.assistant_message set content = 'rewritten' where id = msg;
    raise exception 'T8 FAIL: message update accepted';
  exception when insufficient_privilege then null;
  end;
  begin
    insert into deedbox.assistant_feedback (message, staff, rating)
      values (msg, st, 'meh');
    raise exception 'T8 FAIL: unknown feedback rating accepted';
  exception when check_violation then null;
  end;
  insert into deedbox.assistant_gap (firm, question, staff, confidence, message)
    values (f, 'How do I reconcile?', st, 'none', msg);
  begin
    update deedbox.assistant_gap set status = 'done' where firm = f;
    raise exception 'T8 FAIL: unknown gap status accepted';
  exception when check_violation then null;
  end;
  update deedbox.assistant_gap set status = 'reviewed' where firm = f and question = 'How do I reconcile?';

  reset role;

  -- T9: policy rows ship for all six tables
  select count(*) into n from deedbox.deletion_policy
   where entity_type in ('assistant_article','assistant_chunk','assistant_conversation',
                         'assistant_message','assistant_gap','assistant_feedback');
  if n <> 6 then raise exception 'T9 FAIL: deletion-policy rows missing'; end if;

  -- T10: chunks cascade with their article (upgrade replacement path)
  insert into deedbox.assistant_article (origin, firm, slug, title, summary, module)
    values ('engine', null, 'throwaway-cascade', 'Throwaway', 'Cascade probe.', 'general')
    returning id into aid2;
  insert into deedbox.assistant_chunk (article, chunk_index, heading, content)
    values (aid2, 0, 'Throwaway', 'Cascade probe.');
  delete from deedbox.assistant_article where id = aid2;
  select count(*) into n from deedbox.assistant_chunk where article = aid2;
  if n <> 0 then raise exception 'T10 FAIL: chunks survived their article'; end if;

  raise notice '0036 suite: all assertions passed';
end $$;

rollback;
