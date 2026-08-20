-- 0036_assistant — the help assistant's home: the help knowledge base
-- (engine-shipped + firm-authored articles with derived retrieval chunks),
-- the lexical search function with its honest matched/lex outputs (the
-- confidence floor the orchestrator builds on), append-only support
-- telemetry (conversations, messages, knowledge gaps, feedback), and the
-- assistant.manage capability. The model call itself is an app seam; the
-- knowledge base stands alone without it.
--
-- Engine articles (origin 'engine', firm NULL) are release content: seeded
-- here, UPDATE-refused by trigger, replaced wholesale by upgrades
-- (delete + reinsert as the deployment role; chunks cascade). Firm articles
-- (origin 'firm', firm NOT NULL) are authored in the app.

begin;

------------------------------------------------------------------------------
-- The knowledge base.
------------------------------------------------------------------------------
create table deedbox.assistant_article (
    id bigint generated always as identity primary key,
    origin text not null check (origin in ('engine','firm')),
    firm bigint references deedbox.firm(id),
    slug text not null,
    title text not null,
    summary text not null,
    module text not null,
    body text not null default '',
    steps jsonb not null default '[]',
    warnings text,
    routes text[] not null default '{}',
    related text[] not null default '{}',
    needs_capability text references deedbox.capability(key),
    status text not null default 'draft' check (status in ('draft','published','retired')),
    product_version text,
    last_verified date,
    created_at timestamptz not null default now(),
    created_by bigint references deedbox.staff_member(id),
    updated_at timestamptz not null default now(),
    search tsvector generated always as
      (to_tsvector('english', title || ' ' || summary || ' ' || body)) stored,
    check ((origin = 'engine') = (firm is null))
);
create unique index assistant_article_engine_slug
  on deedbox.assistant_article (slug) where firm is null;
create unique index assistant_article_firm_slug
  on deedbox.assistant_article (firm, slug) where firm is not null;
create index assistant_article_search on deedbox.assistant_article using gin (search);
create index assistant_article_title_trgm
  on deedbox.assistant_article using gin (title extensions.gin_trgm_ops);
grant select, insert, update on deedbox.assistant_article to deedbox_app;

create or replace function deedbox.assistant_article_guard() returns trigger
language plpgsql as $$
begin
  if old.origin = 'engine' then
    raise exception 'engine help articles are replaced by upgrades, never edited';
  end if;
  if new.origin is distinct from old.origin
     or new.firm is distinct from old.firm
     or new.slug is distinct from old.slug then
    raise exception 'a help article''s identity (origin, firm, slug) is immutable';
  end if;
  new.updated_at = now();
  return new;
end $$;
create trigger assistant_article_guard before update on deedbox.assistant_article
for each row execute function deedbox.assistant_article_guard();

-- Retrieval units, DERIVED from their article on every save (delete +
-- reinsert) — not evidence, so the app may rebuild them freely.
create table deedbox.assistant_chunk (
    id bigint generated always as identity primary key,
    article bigint not null references deedbox.assistant_article(id) on delete cascade,
    chunk_index integer not null,
    heading text,
    content text not null,
    routes text[] not null default '{}',
    search tsvector generated always as
      (to_tsvector('english', coalesce(heading,'') || ' ' || content)) stored,
    unique (article, chunk_index)
);
create index assistant_chunk_search on deedbox.assistant_chunk using gin (search);
create index assistant_chunk_content_trgm
  on deedbox.assistant_chunk using gin (content extensions.gin_trgm_ops);
grant select, insert, delete on deedbox.assistant_chunk to deedbox_app;

------------------------------------------------------------------------------
-- Support telemetry — append-only through grants. Product telemetry, not
-- evidence: asks emit no register entries by design.
------------------------------------------------------------------------------
create table deedbox.assistant_conversation (
    id bigint generated always as identity primary key,
    firm bigint not null references deedbox.firm(id),
    staff bigint not null references deedbox.staff_member(id),
    entry_route text,
    started_at timestamptz not null default now()
);
create index assistant_conversation_staff on deedbox.assistant_conversation (staff, started_at desc);
grant select, insert on deedbox.assistant_conversation to deedbox_app;

create table deedbox.assistant_message (
    id bigint generated always as identity primary key,
    conversation bigint not null references deedbox.assistant_conversation(id),
    role text not null check (role in ('user','assistant')),
    content text not null,
    route text,
    retrieved_slugs text[] not null default '{}',
    confidence text check (confidence in ('high','medium','low','none')),
    was_refusal boolean not null default false,
    guardrail_flags text[] not null default '{}',
    model text,
    latency_ms integer,
    created_at timestamptz not null default now()
);
create index assistant_message_conversation on deedbox.assistant_message (conversation, id);
grant select, insert on deedbox.assistant_message to deedbox_app;

create table deedbox.assistant_gap (
    id bigint generated always as identity primary key,
    firm bigint not null references deedbox.firm(id),
    question text not null,
    route text,
    staff bigint references deedbox.staff_member(id),
    retrieved_slugs text[] not null default '{}',
    confidence text check (confidence in ('high','medium','low','none')),
    message bigint references deedbox.assistant_message(id),
    status text not null default 'open' check (status in ('open','reviewed','resolved')),
    created_at timestamptz not null default now()
);
create index assistant_gap_status on deedbox.assistant_gap (firm, status, created_at desc);
grant select, insert, update on deedbox.assistant_gap to deedbox_app;

create table deedbox.assistant_feedback (
    id bigint generated always as identity primary key,
    message bigint not null references deedbox.assistant_message(id),
    staff bigint not null references deedbox.staff_member(id),
    rating text not null check (rating in ('up','down','wrong','needs_detail')),
    note text,
    created_at timestamptz not null default now()
);
create index assistant_feedback_message on deedbox.assistant_feedback (message);
grant select, insert on deedbox.assistant_feedback to deedbox_app;

------------------------------------------------------------------------------
-- Retrieval. Route patterns use ':param' segments ('/matters/:id') and
-- prefix semantics ('/billing' boosts everything under it). language sql
-- validates references at creation — both functions are defined AFTER the
-- tables they read; extension calls are schema-qualified so the app role's
-- search_path never matters.
------------------------------------------------------------------------------
create function deedbox.assistant_route_matches(pattern text, actual text)
returns boolean language sql immutable as $$
  select case
    when pattern is null or actual is null then false
    when pattern = actual then true
    when actual like pattern || '/%' then true
    when pattern like '%:%' then
      actual ~ ('^' || regexp_replace(pattern, ':[a-zA-Z_]+', '[^/]+', 'g') || '$')
    else false
  end;
$$;

create function deedbox.assistant_search(
    p_firm bigint, p_query text, p_route text default null, p_limit integer default 8)
returns table (
    chunk_id bigint, article_id bigint, slug text, title text, module text,
    needs_capability text, heading text, content text, routes text[],
    score double precision, lex double precision, matched boolean)
language sql stable as $$
  with q as (
    select nullif(replace(plainto_tsquery('english', coalesce(p_query,''))::text, '&', '|'), '')::tsquery as tsq,
           lower(coalesce(p_query,'')) as raw
  ),
  scored as (
    select
      c.id as chunk_id,
      a.id as article_id,
      a.slug,
      a.title,
      a.module,
      a.needs_capability,
      c.heading,
      c.content,
      coalesce(nullif(c.routes,'{}'), a.routes) as routes,
      (
        coalesce(ts_rank_cd(c.search, q.tsq), 0) * 4.0
        + greatest(
            extensions.similarity(lower(a.title), q.raw),
            extensions.similarity(lower(coalesce(c.heading,'')), q.raw)
          ) * 1.5
      )::double precision as lex,
      case
        when p_route is not null and (
             p_route = any(coalesce(nullif(c.routes,'{}'), a.routes))
          or exists (select 1 from unnest(coalesce(nullif(c.routes,'{}'), a.routes)) r
                     where deedbox.assistant_route_matches(r, p_route))
        ) then 2.5 else 0.0 end as route_boost,
      coalesce(c.search @@ q.tsq or a.search @@ q.tsq, false) as matched
    from deedbox.assistant_chunk c
    join deedbox.assistant_article a on a.id = c.article, q
    where a.status = 'published'
      and (a.origin = 'engine' or a.firm = p_firm)
      and (
           c.search @@ q.tsq
        or a.search @@ q.tsq
        or extensions.similarity(lower(a.title), q.raw) > 0.25
        or (p_route is not null and p_route = any(a.routes))
      )
  )
  select chunk_id, article_id, slug, title, module, needs_capability, heading,
         content, routes, (lex + route_boost) as score, lex, matched
  from scored
  order by (lex + route_boost) desc
  limit greatest(1, least(p_limit, 20));
$$;

------------------------------------------------------------------------------
-- Catalogue extensions.
------------------------------------------------------------------------------
insert into deedbox.capability (key, description, grantable_to_firm_roles) values
  ('assistant.manage',
   'Author and publish the firm''s own help articles, review the assistant''s knowledge gaps and feedback.',
   true);
insert into deedbox.role_capability (role, capability)
  select id, 'assistant.manage' from deedbox.role where system_key = 'administrator';

insert into deedbox.deletion_policy (entity_type, mode) values
  ('assistant_article', 'hard_delete_allowed'),
  ('assistant_chunk', 'hard_delete_allowed'),
  ('assistant_conversation', 'hard_delete_allowed'),
  ('assistant_message', 'hard_delete_allowed'),
  ('assistant_gap', 'hard_delete_allowed'),
  ('assistant_feedback', 'hard_delete_allowed');

commit;

------------------------------------------------------------------------------
-- The engine starter knowledge base. Release content, exactly like the
-- report-key catalogue: every claim below describes THIS application's
-- shipped screens (nav labels and routes verified against the layout at
-- build time). Replaced wholesale on upgrade: delete where origin='engine',
-- reinsert (chunks cascade).
------------------------------------------------------------------------------
begin;

create or replace function pg_temp.seed_article(
    p_slug text, p_title text, p_summary text, p_module text,
    p_steps jsonb, p_warning text, p_routes text[], p_needs text default null)
returns void language plpgsql as $$
declare
  aid bigint;
  chunk text;
  i integer;
begin
  insert into deedbox.assistant_article
    (origin, firm, slug, title, summary, module, steps, warnings, routes,
     needs_capability, status, product_version, last_verified)
  values
    ('engine', null, p_slug, p_title, p_summary, p_module, p_steps, p_warning,
     p_routes, p_needs, 'published', 'v1', current_date)
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
  'getting-started', 'Getting started', 'What the application is and how to find your way around for the first time.', 'general',
  '["Sign in with your work email at the sign-in page.","Use the left-hand menu to reach each area: Work, Client money, Billing, Reports, Security and Configuration.","Sections you cannot use are simply not shown; the menu reflects your own permissions.","Your name at the top right opens your account page; the Sign out button sits beside it.","Help, in the Work section, opens this assistant and the help articles."]'::jsonb,
  'What you see in the menu depends on the permissions your role grants. If a section is missing, your role does not have access to it.',
  array['/']);

select pg_temp.seed_article(
  'finding-a-matter', 'Finding and opening a matter', 'Using the matter list, filters and global search to reach a matter.', 'matters',
  '["Open Work, then Matters to see the matter list.","Filter the list by status or use the list search box.","Or open Work, then Search, and type any words: matter titles, party names, notes and document contents are all searched.","Select the matter to open its page."]'::jsonb,
  'You only see the matters your visibility allows. If a matter you expect is missing, ask an administrator about your assignment or office scope.',
  array['/matters','/search']);

select pg_temp.seed_article(
  'creating-a-matter', 'Creating a new matter', 'Opening a new matter directly, and what the required fields mean.', 'matters',
  '["Open Work, then Matters, and choose New matter.","Pick the client. If the person or organisation is not there yet, add them under People and organisations first.","Choose the practice area and the responsible lawyer, and give the matter a title.","If a duplicate-looking client appears, the application shows a review dialog: check the candidates before creating anyway.","Save. The matter number is allocated automatically from the firm numbering settings."]'::jsonb,
  'The assistant cannot open the matter for you. Matters can also arrive through Intake: an intake record is converted into a matter once accepted.',
  array['/matters/new','/matters']);

select pg_temp.seed_article(
  'intake', 'Intake: new enquiries before they become matters', 'Recording enquiries on the intake board and converting an accepted one into a matter.', 'matters',
  '["Open Work, then Intake to see the board, arranged by stage.","Add an enquiry as a new intake record and fill in what you know.","Move the record between stages as it progresses.","When accepted, use Convert on the record: the matter is created and the intake becomes terminal.","A converted intake keeps its record; the outcome can be noted on unconverted ones."]'::jsonb,
  'Conversion needs the intake.convert permission. Duplicate-looking parties surface a review dialog before anything is created.',
  array['/intake']);

select pg_temp.seed_article(
  'parties', 'People and organisations', 'The shared directory of clients and other parties, duplicate review and merging.', 'parties',
  '["Open Work, then People and organisations.","Search by name; the profile shows all name forms, linked matters and merge history.","Add a person or organisation with the add form; a duplicate check runs first and shows candidates.","Deferred duplicates sit in the Duplicate review queue for later decisions.","Merging two records starts with a dry run: the screen shows exactly what will move before you commit, and a merge can be undone while its window is open."]'::jsonb,
  'Merges are recorded and reversible only until a touched record changes. The assistant cannot merge or edit records for you.',
  array['/parties','/parties/review']);

select pg_temp.seed_article(
  'conflict-checks', 'Running a conflict check', 'Searching names across parties, past names and matter text before taking on work.', 'matters',
  '["Open Work, then Conflict checks.","Enter the names to check: the search covers current and past party names, close matches and matter text.","Review the hits; restricted matters appear as existence-only entries telling you whom to ask.","Save the run: the result is kept as an immutable snapshot on the conflict register."]'::jsonb,
  'Whether a conflict exists is a professional judgment; the application records the search and its results. Running checks needs the conflict.run permission.',
  array['/conflicts'], 'conflict.run');

select pg_temp.seed_article(
  'matter-hub', 'The matter page', 'What lives on a matter: timeline, notes, parties, staffing, and the tabs for billing, money, documents, email and workflow.', 'matters',
  '["Open the matter from the list or search.","The overview shows the timeline (drawn from the permanent register), notes, parties, staffing and custom fields.","Tabs along the page open Billing (work in progress and bills), Money (client money ledgers), Documents, Email and Workflow.","Close a matter from its Close action: the screen shows the financial position and warns or blocks on open money.","A closed matter is read-only; reopening restores it, and holds or archiving are available from the status controls."]'::jsonb,
  'Closing may require an approval from a second person, depending on firm settings. Restriction (limiting who can see the matter) is managed from the restriction panel.',
  array['/matters/:id']);

select pg_temp.seed_article(
  'recording-time', 'Recording time', 'Time entries, running timers and the suggested-time queue.', 'billing',
  '["Open Billing, then My time, to add entries: pick the matter, category, duration and narrative.","Use a timer when you prefer: start it, work, stop it, and save the entry it made.","Suggested time (from activity signals) waits in its own queue: accept a suggestion to turn it into a real entry, or dismiss it.","Entries stay editable while unbilled; once on an issued bill the value is fixed, though the narrative stays writable."]'::jsonb,
  'Deleting is only possible while an entry is unbilled. Written-off entries are permanent records.',
  array['/billing']);

select pg_temp.seed_article(
  'billing-a-matter', 'Drafting and issuing a bill', 'From work-in-progress to a draft bill to an issued bill, including approvals and billing runs.', 'billing',
  '["Open the matter, then its Billing tab, to see unbilled work.","Tick the items to bill and create the draft; payer shares split the draft into sibling bills automatically.","Edit the draft: remove items, apply write-downs, and submit for approval if the firm requires it.","Issue the bill: the number is allocated, the date and terms come from firm settings, and the rendered bill is stored exactly as issued.","For many matters at once, use Billing, then Billing runs: the run drafts and issues per matter and itemises everything it honestly excluded."]'::jsonb,
  'Issuing needs the bill.issue permission, and approval-required firms refuse a direct issue while approval is pending. An issued bill never changes; corrections use credit notes.',
  array['/matters/:id/billing','/billing/runs']);

select pg_temp.seed_article(
  'payments-and-unpaid', 'Recording payments and chasing unpaid bills', 'The payment workbench, allocation, the unpaid register, credits and write-offs.', 'billing',
  '["Open Billing, then Payments, to record a payment and allocate it to bills in the same act.","Unallocated money stays visible on its own tab until you allocate it.","The Unpaid bills register lists what is outstanding; a bill page shows its full journal: issue, payments, credits, interest and disputes.","Credit notes and write-offs are raised from the bill page and are capped at what is outstanding.","Statements (Billing, then Statements) send a client a snapshot of their position."]'::jsonb,
  'Allocations never exceed a payment or a bill outstanding: the engine refuses the excess. Reversals are recorded as their own entries, never edits.',
  array['/billing/payments','/billing/unpaid']);

select pg_temp.seed_article(
  'reminders-and-arrangements', 'Payment reminders and instalment arrangements', 'The automatic reminder sequence, holds, and payment arrangements.', 'billing',
  '["An issued bill starts on the firm reminder sequence automatically.","Hold or release reminders for one bill from its page; disputes pause reminders on their own.","An arrangement (Billing, then Arrangements) sets instalments; while payments keep pace with the schedule, reminders stay quiet.","A missed instalment is recorded and the arrangement can be reactivated with a fresh schedule."]'::jsonb,
  'Reminder wording and cadence are firm configuration (reminders.manage). Reminder sends appear in the outbound message log.',
  array['/billing/reminders','/billing/arrangements'], 'reminders.manage');

select pg_temp.seed_article(
  'client-money-receipt', 'Receiving client money', 'Recording a receipt into the client account and where it shows on the matter.', 'money',
  '["Open Client money, then Record receipt.","Pick the matter, the amount, the payment method (from your country pack) and who it came from.","Save: the receipt gets its own numbered document and the money lands on the matter ledger.","The matter Money tab shows the ledger, running balances, and any earmarks holding funds for a purpose."]'::jsonb,
  'Client money can never go below zero on a ledger: the engine refuses the transaction and records the refusal permanently. Receiving needs the money.receive permission.',
  array['/money/receipt','/matters/:id/money'], 'money.receive');

select pg_temp.seed_article(
  'client-money-payment', 'Paying client money out', 'The payment ceremony: request, approval, execution, and what happens on a refusal.', 'money',
  '["Open Client money, then Payments and authorisations.","Request the payment: payee, amount, ledger and reason. The request freezes what approvers see.","Approvals follow: over the firm threshold a second approver is required, and the approver can never be the executor for transfers.","Execute once approvals are complete: the money moves and the payment document is stored.","A payment the engine refuses (for example, not enough cover) is BLOCKED and the refusal is recorded on the permanent refusal register."]'::jsonb,
  'Recording payments needs money.record_payment; authorising needs the authorisation permissions. Nothing about a refusal is ever deleted.',
  array['/money/payments'], 'money.record_payment');

select pg_temp.seed_article(
  'reconciliation-and-close', 'Reconciling and closing a period', 'Matching the bank statement, certifying the reconciliation, and the period close.', 'money',
  '["Open Client money, then the account, to reach the reconciliation workspace.","Feed in the bank statement lines and match them against the book: matches must sum to zero.","Anything unmatched becomes a typed exception that carries forward with its history until resolved.","The screen shows the statutory equation live; certify only when the remainder is zero.","Period closes (Client money, then Period closes) write the balance listing and lock the period; dormant balances have their own register and ceremony."]'::jsonb,
  'Certification is proven in the database itself: the equation, coverage and instrument transitions must all hold or the certify is refused. Needs money.manage_accounts.',
  array['/money/close','/money'], 'money.manage_accounts');

select pg_temp.seed_article(
  'documents', 'Documents on a matter', 'Folders, uploads, versions, checkout, locking, comparing and sharing.', 'documents',
  '["Open the matter, then its Documents tab.","Upload files into folders; every save is a new immutable version under the same document head.","Check a document out to signal you are working on it; locks and legal holds stop changes entirely.","A document page shows its versions: compare any two to see what changed in the text.","Share externally with a link (optionally for signature): the shared copy is pinned to the exact version disclosed."]'::jsonb,
  'Document text is extracted per version and feeds search and conflict checks automatically. Deleting is soft and restorable by an administrator.',
  array['/matters/:id/documents','/documents/:id']);

select pg_temp.seed_article(
  'document-templates', 'Document templates and generation', 'Uploading Word templates with merge tags and generating documents from them.', 'documents',
  '["Open Configuration, then Templates.","Upload a Word file whose merge tags name the fields to fill: matter, client and firm details.","Preview a template to check the tags resolve.","Generate from the matter Documents tab: pick the template and the filled document is saved as a new document on the matter."]'::jsonb,
  'Managing templates needs the templates.manage permission. Generated documents are ordinary versions: regenerate to produce a new one.',
  array['/settings/templates','/matters/:id/documents'], 'templates.manage');

select pg_temp.seed_article(
  'email-and-calendar', 'Email and calendar on a matter', 'Connecting Microsoft 365, sending as yourself, automatic filing and calendar events.', 'email',
  '["Open your account page (your name, top right) and connect Microsoft 365.","On a matter, the Email tab sends as you: the matter number in square brackets is stamped into the subject.","Replies that keep the bracketed matter number are filed onto the matter automatically by the background poll.","The sent copy is filed the moment you send.","Calendar events created from the matter land in your Microsoft calendar and are recorded on the matter."]'::jsonb,
  'Filing matches the bracketed matter number exactly; mail without it is left alone. The connection is per person and can be disconnected on the account page.',
  array['/account','/matters/:id/email']);

select pg_temp.seed_article(
  'client-portal', 'The client portal', 'Inviting a client, controlling which matters they see, and what the portal shows.', 'portal',
  '["Open the client under People and organisations.","In the Client portal panel, create an invite: a one-time link to send them.","The client accepts, signs in, and sees the matters where portal access is switched on.","Portal visibility per matter is the toggle on the matter Parties panel.","The portal shows matter basics and issued bills with what is outstanding; revoke an invite to end access and their sessions immediately."]'::jsonb,
  'The invite link is shown once at creation. Clients never see internal notes, documents or money screens in this version.',
  array['/parties/:id']);

select pg_temp.seed_article(
  'reports', 'Reports, schedules and targets', 'The report catalogue, the viewer, saved reports, scheduled sends and targets.', 'reports',
  '["Open Reports, then Catalogue, and run a report.","Shape it in the viewer: columns, grouping and filters; subtotals follow the grouping.","Save a shaped report to keep it; saved reports remember their columns and grouping.","Schedules send a report on a cadence: each recipient receives exactly what their own permissions allow.","Targets and groups define the figures dashboards track."]'::jsonb,
  'Firm-wide financial figures need the reporting permissions; without them reports show your own figures only.',
  array['/reports']);

select pg_temp.seed_article(
  'staff-and-roles', 'Staff, roles and security', 'Adding staff, roles and capabilities, MFA, sessions and the register.', 'security',
  '["Open Security, then Staff, to add a person: name, sign-in, role and office.","Roles and capabilities defines what each role can do; the administrator role always keeps its safety floor.","MFA enrolment and the security policy (session lengths, step-up) live in Security.","All sessions and Sign-in history show who is signed in and from where; sessions can be ended.","The Register is the permanent, hash-chained record of everything that happened."]'::jsonb,
  'Deactivating a staff member ends their sessions immediately. The last administrator can never be removed. Needs security.administer.',
  array['/security/staff','/security/roles'], 'security.administer');

select pg_temp.seed_article(
  'imports', 'Importing data', 'The import wizard, validate-only runs, real runs and reversal.', 'imports',
  '["Open Configuration, then Imports, and start a batch with the wizard.","Map the columns, then run VALIDATE-ONLY first: every record is checked and nothing at all is kept.","Run the real import once validation is clean; each record lands with its source reference.","A finished batch can be reversed while untouched: reversal unwinds newest-first and refuses if anything was changed since."]'::jsonb,
  'Imports need the import.execute permission. Money imports post real transactions under an approved import authorisation and are refused as a whole batch on any failure.',
  array['/imports'], 'import.execute');

select pg_temp.seed_article(
  'firm-settings', 'Firm configuration', 'Settings, lists, numbering, custom fields and practice areas.', 'configuration',
  '["Open Configuration, then Firm settings: every setting is effective-dated, so changes take effect from a moment and the history is kept.","Lists holds the choice lists behind pickers; shipped items are permanent, yours can be deactivated.","Numbering shows each number series; replacing a format carries the series forward, never restarting it.","Custom fields adds firm-defined fields to matters and parties.","Practice areas manages the areas and which may relate to which."]'::jsonb,
  'Configuration screens need their respective manage permissions. Nothing here can renumber or rewrite existing records.',
  array['/settings'], 'settings.manage');

select pg_temp.seed_article(
  'help-assistant', 'What this assistant can and cannot do', 'The help assistant explains the application; it can never change anything.', 'general',
  '["Ask how to do something in plain words; the assistant answers from the help articles and tells you where the screens are.","Every answer names its sources; open an article for the full steps.","The assistant cannot create, edit, send, approve, post or delete anything, and it does not read your matters or clients: it only knows these help articles.","Rate answers with the feedback buttons: unanswerable questions are collected so the firm can fill the gaps.","Browse all articles under Help."]'::jsonb,
  'Answers about whether a specific transaction is proper are professional judgments for the responsible people at the firm; the assistant only explains screens and steps.',
  array['/help']);

drop function pg_temp.seed_article(text, text, text, text, jsonb, text, text[], text);

commit;
