-- 0062: a key may be allowed to READ document templates — per key, off by
-- default, templates only.
--
-- Integration keys accept records; they read nothing. That stays the rule.
-- Some firms authorise an outside tool to fill the firm's OWN precedents on
-- its behalf — that tool needs to list the firm's document templates and
-- fetch a file, and nothing else. So the key record gains one narrow,
-- deliberately-named switch. It is not, and can never become, a general
-- read flag: the door it opens serves template metadata and template files
-- only. Flipping it is an ordinary recorded change on the key; the key
-- guard already leaves non-identity columns changeable on live keys and
-- refuses every change on revoked ones.
--
-- Idempotent article seed: skips a slug the engine set already carries.

alter table deedbox.integration_key
  add column templates_read boolean not null default false;

create or replace function pg_temp.seed_article(
    p_slug text, p_title text, p_summary text, p_module text,
    p_steps jsonb, p_warning text, p_routes text[], p_related text[],
    p_needs text default null)
returns void language plpgsql as $$
declare
  aid bigint;
  chunk text;
  i integer;
begin
  if exists (select 1 from deedbox.assistant_article where firm is null and slug = p_slug) then
    raise notice 'engine article % already present -- skipped', p_slug;
    return;
  end if;
  insert into deedbox.assistant_article
    (origin, firm, slug, title, summary, module, steps, warnings, routes,
     related, needs_capability, status, product_version, last_verified)
  values
    ('engine', null, p_slug, p_title, p_summary, p_module, p_steps, p_warning,
     p_routes, p_related, p_needs, 'published', 'v1', current_date)
  returning id into aid;
  chunk := p_summary;
  if jsonb_array_length(p_steps) > 0 then
    chunk := chunk || chr(10) || 'Steps:';
    for i in 0 .. jsonb_array_length(p_steps) - 1 loop
      chunk := chunk || chr(10) || (i + 1)::text || '. ' || (p_steps ->> i);
    end loop;
  end if;
  if p_warning is not null then
    chunk := chunk || chr(10) || 'Note: ' || p_warning;
  end if;
  insert into deedbox.assistant_chunk (article, chunk_index, heading, content, routes)
  values (aid, 0, p_title, chunk, p_routes);
end $$;

select pg_temp.seed_article(
  $kbs$template-reading-for-keys$kbs$, $kbt$Letting an outside tool read your document templates$kbt$,
  $kbm$Integration keys accept records and read nothing — unless a firm administrator switches on template reading for a specific key. What the switch opens, what it never opens, and where it lives.$kbm$,
  $kbo$configuration$kbo$,
  $kbj$["Integration keys accept records from outside systems and read nothing. If the firm wants an authorised tool to fetch its document templates — for example, to fill one of the firm's own precedents on its behalf — that is a separate switch on the key, off unless someone turns it on.", "Open Settings, then Integration keys, and open the key the tool uses.", "In the Template reading panel, switch template reading on. The change is recorded against the key.", "With the switch on, the tool can list the firm's ACTIVE templates and fetch their files — and nothing else: no matters, no clients, no money, no staff, no documents on matters.", "Switch it off the same way at any time. The key keeps accepting records either way.", "Every template read is recorded against the key and appears in the key's activity export."]$kbj$::jsonb,
  $kbw$The switch is per key and off by default. It covers document templates only — it is not, and cannot become, general read access. If an outside tool reports that template reading is not switched on, this switch is what it means; a firm administrator flips it on the key's own screen.$kbw$,
  array[$kbr$/settings/keys$kbr$, $kbr$/settings/keys/:id$kbr$]::text[],
  '{}'::text[],
  $kbn$keys.manage$kbn$);
