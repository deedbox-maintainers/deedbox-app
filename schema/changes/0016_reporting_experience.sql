-- 0016_reporting_experience — the reporting catalogue and the experience
-- layer: shipped report definitions (seeded with the full catalogue's
-- identity and flags), saved reports, schedules with per-recipient
-- predicate delivery, the artefact store, outbound messages, the one
-- sanctioned position cache, recents and pins, the search index with its
-- synchronous feeders, performance targets and staff groups, and the
-- bulk-operation item's reversal outcome columns. The report ENGINE (query
-- builders, rendering, scheduling jobs, the position-cache recompute/verify
-- jobs, outbound dispatch) is app-layer over these rows.
--
-- Implementation notes:
--   * The shipped-definition seed carries each definition's key, category,
--     tile group, schedulability, own-figures support and visibility roles;
--     the column/filter/aggregation docs hold structured summaries — the
--     release-owned query builders bind to the keys, so the catalogue's
--     identity is schema-fixed while its rendering evolves with releases.
--   * Search-index party rows key on the party NAME row (one index row
--     per name of every kind) — (entry_type, source) stays unique.
--   * Target uniqueness includes subject_kind (staff and group ids share
--     a number space).

begin;

------------------------------------------------------------------------------
-- The shipped report catalogue.
------------------------------------------------------------------------------
create table deedbox.report_definition (
    id bigint generated always as identity primary key,
    key text not null unique,
    title text not null,
    base_record_set jsonb not null,
    default_columns jsonb not null,
    available_filters jsonb not null,
    aggregation jsonb not null,
    derived_rate_formulas jsonb,
    visibility_roles jsonb not null,
    own_figures_scope_supported boolean not null default false,
    category text not null check (category in ('standard_report','firm_tile','personal_tile','view_source')),
    tile_group text,
    schedulable boolean not null default true
);
grant select on deedbox.report_definition to deedbox_app;

insert into deedbox.report_definition
  (key, title, base_record_set, default_columns, available_filters, aggregation,
   visibility_roles, own_figures_scope_supported, category, tile_group, schedulable) values
('matter_list_financials','report.matter_list_financials','{"base":"matters under predicate"}','[]','[]','{}','["administrator","accounts"]',true,'standard_report',null,true),
('unbilled_work_aged','report.unbilled_work_aged','{"base":"unbilled items"}','[]','[]','{"sum":"value"}','["administrator","accounts"]',true,'standard_report',null,true),
('aged_receivables','report.aged_receivables','{"base":"issued bills outstanding"}','[]','[]','{"sum":"outstanding by age band"}','["administrator","accounts"]',true,'standard_report',null,true),
('billing_activity','report.billing_activity','{"base":"bill journal entries"}','[]','[]','{}','["administrator","accounts"]',true,'standard_report',null,true),
('client_money_receipts_payments','report.client_money_receipts_payments','{"base":"money ledger lines"}','[]','[]','{}','["administrator","accounts"]',false,'standard_report',null,true),
('ledger_listings','report.ledger_listings','{"base":"ledgers of every kind"}','[]','[]','{"sum":"available"}','["administrator","accounts"]',false,'standard_report',null,true),
('refusal_register','report.refusal_register','{"base":"refused operations"}','[]','[]','{}','["administrator","accounts"]',false,'standard_report',null,true),
('deficiency_incidents','report.deficiency_incidents','{"base":"incidents"}','[]','[]','{}','["administrator","accounts"]',false,'standard_report',null,true),
('matter_profitability','report.matter_profitability','{"base":"matters with measures"}','[]','[]','{}','["administrator","accounts"]',false,'standard_report',null,true),
('practice_area_profitability','report.practice_area_profitability','{"base":"R8 grouped by area"}','[]','[]','{}','["administrator","accounts"]',false,'standard_report',null,true),
('staff_performance','report.staff_performance','{"base":"active staff"}','[]','[]','{}','["administrator","accounts"]',true,'standard_report',null,true),
('tile_matters_opened','tile.matters_opened','{"count":"matters opened in period"}','[]','[]','{"count":true}','["administrator","accounts"]',false,'firm_tile','firm_dashboard',false),
('tile_matters_closed','tile.matters_closed','{"count":"matters closed in period"}','[]','[]','{"count":true}','["administrator","accounts"]',false,'firm_tile','firm_dashboard',false),
('tile_unbilled_work','tile.unbilled_work','{"sum":"R2 value"}','[]','[]','{"sum":true}','["administrator","accounts"]',false,'firm_tile','firm_dashboard',false),
('tile_outstanding_by_age','tile.outstanding_by_age','{"sum":"R3 per band"}','[]','[]','{"banded":true}','["administrator","accounts"]',false,'firm_tile','firm_dashboard',false),
('tile_client_money_available','tile.client_money_available','{"sum":"available over R6"}','[]','[]','{"sum":true}','["administrator","accounts"]',false,'firm_tile','firm_dashboard',false),
('tile_billed_this_period','tile.billed_this_period','{"sum":"issue totals in period"}','[]','[]','{"sum":true}','["administrator","accounts"]',false,'firm_tile','firm_dashboard',false),
('tile_collected_this_period','tile.collected_this_period','{"sum":"allocations in period"}','[]','[]','{"sum":true}','["administrator","accounts"]',false,'firm_tile','firm_dashboard',false),
('tile_my_recorded','tile.my_recorded','{"own":"hours and value"}','[]','[]','{"sum":true}','["all_staff"]',true,'personal_tile','personal_dashboard',false),
('tile_my_billed','tile.my_billed','{"own":"attributed billed"}','[]','[]','{"sum":true}','["all_staff"]',true,'personal_tile','personal_dashboard',false),
('tile_my_collected','tile.my_collected','{"own":"attributed collected"}','[]','[]','{"sum":true}','["all_staff"]',true,'personal_tile','personal_dashboard',false),
('tile_my_targets','tile.my_targets','{"own":"targets with progress"}','[]','[]','{}','["all_staff"]',true,'personal_tile','personal_dashboard',false),
('view_critical_dates','view.critical_dates','{"view":"critical key dates"}','[]','[]','{}','["all_staff"]',false,'view_source',null,false),
('view_my_tasks','view.my_tasks','{"view":"my open tasks"}','[]','[]','{}','["all_staff"]',true,'view_source',null,false),
('view_matter_tasks','view.matter_tasks','{"view":"matter tasks"}','[]','[]','{}','["all_staff"]',false,'view_source',null,false),
('view_recompute_proposals','view.recompute_proposals','{"view":"pending date proposals"}','[]','[]','{}','["all_staff"]',false,'view_source',null,false),
('view_unpaid_bills','view.unpaid_bills','{"view":"R3"}','[]','[]','{}','["administrator","accounts"]',false,'view_source',null,false),
('view_import_batches','view.import_batches','{"view":"import batches"}','[]','[]','{}','["administrator"]',false,'view_source',null,false),
('view_key_activity','view.key_activity','{"view":"register per integration key"}','[]','[]','{}','["administrator"]',false,'view_source',null,false),
('view_export_history','view.export_history','{"view":"export.performed projection"}','[]','[]','{}','["administrator"]',false,'view_source',null,false),
('view_signin_history','view.signin_history','{"view":"sign-in register projection"}','[]','[]','{}','["administrator"]',false,'view_source',null,false);

------------------------------------------------------------------------------
-- Saved reports and schedules.
------------------------------------------------------------------------------
create table deedbox.saved_report (
    id bigint generated always as identity primary key,
    definition bigint not null references deedbox.report_definition(id),
    name text not null,
    owner bigint not null references deedbox.staff_member(id),
    shared boolean not null default false,
    columns jsonb not null,
    filters jsonb not null,
    grouping jsonb not null,
    sort jsonb not null,
    created_at timestamptz not null default now(),
    deleted_at timestamptz,
    deleted_by bigint
);
create unique index saved_report_name_unique
  on deedbox.saved_report (owner, name) where deleted_at is null;
create index saved_report_shared_idx on deedbox.saved_report (shared) where shared and deleted_at is null;
grant select, insert, update on deedbox.saved_report to deedbox_app;

create table deedbox.report_schedule (
    id bigint generated always as identity primary key,
    report_kind text not null check (report_kind in ('standard','saved')),
    report bigint not null,
    period jsonb not null,
    format text not null check (format in ('csv','spreadsheet','pdf')),
    active boolean not null default true,
    owner bigint not null references deedbox.staff_member(id),
    next_run_at timestamptz not null,
    last_run_at timestamptz,
    paused_reason text,
    created_at timestamptz not null default now()
);
create index report_schedule_poll_idx on deedbox.report_schedule (next_run_at) where active;
grant select, insert, update on deedbox.report_schedule to deedbox_app;

create table deedbox.schedule_recipient (
    id bigint generated always as identity primary key,
    schedule bigint not null references deedbox.report_schedule(id),
    staff bigint not null references deedbox.staff_member(id),
    delivery_address text,
    unique (schedule, staff)
);
grant select, insert, update, delete on deedbox.schedule_recipient to deedbox_app;

------------------------------------------------------------------------------
-- The artefact store and outbound messages.
------------------------------------------------------------------------------
create table deedbox.stored_artefact (
    id bigint generated always as identity primary key,
    kind text not null,
    content_ref text not null,
    content_hash text not null,
    generated_at timestamptz not null default now(),
    content_type text not null,
    size_bytes bigint not null
);
create index stored_artefact_hash_idx on deedbox.stored_artefact (content_hash);
create index stored_artefact_kind_idx on deedbox.stored_artefact (kind, generated_at);
grant select, insert on deedbox.stored_artefact to deedbox_app;
create trigger stored_artefact_append_only before update or delete on deedbox.stored_artefact
for each row execute function deedbox.append_only_guard();

create table deedbox.outbound_message (
    id bigint generated always as identity primary key,
    channel text not null check (channel in ('email','text_message')),
    recipient text not null,
    template bigint,
    rendered_artefact text not null,
    purpose text not null,
    related_type text,
    related bigint,
    state text not null default 'queued' check (state in ('queued','sent','failed')),
    sent_at timestamptz,
    failed_reason text,
    retry_of bigint references deedbox.outbound_message(id),
    queued_at timestamptz not null default now(),
    check ((state = 'sent') <= (sent_at is not null)),
    check ((state = 'failed') <= (failed_reason is not null))
);
create index outbound_message_dispatch_idx on deedbox.outbound_message (queued_at) where state = 'queued';
create index outbound_message_related_idx on deedbox.outbound_message (related_type, related);
grant select, insert, update on deedbox.outbound_message to deedbox_app;

create or replace function deedbox.outbound_message_guard() returns trigger
language plpgsql as $$
begin
  if tg_op = 'DELETE' then
    raise exception 'outbound messages are never deleted';
  end if;
  if old.state <> 'queued' then
    raise exception 'a sent or failed message is immutable; a retry is a new row';
  end if;
  if new.state = 'queued'
     and (new.recipient is distinct from old.recipient
          or new.rendered_artefact is distinct from old.rendered_artefact
          or new.channel is distinct from old.channel) then
    raise exception 'a queued message''s content is fixed; requeue a fresh one';
  end if;
  return new;
end $$;
create trigger outbound_message_guard before update or delete on deedbox.outbound_message
for each row execute function deedbox.outbound_message_guard();

------------------------------------------------------------------------------
-- The one sanctioned cache.
------------------------------------------------------------------------------
create table deedbox.matter_position_cache (
    matter bigint primary key references deedbox.matter(id),
    unbilled_value numeric(14,2) not null,
    outstanding_value numeric(14,2) not null,
    held_available numeric(14,2) not null,
    as_at_register_seq bigint not null
);
create index matter_position_cache_frontier_idx on deedbox.matter_position_cache (as_at_register_seq);
grant select, insert, update, delete on deedbox.matter_position_cache to deedbox_app;

------------------------------------------------------------------------------
-- Recents and pins.
------------------------------------------------------------------------------
create table deedbox.recent_item (
    id bigint generated always as identity primary key,
    staff bigint not null references deedbox.staff_member(id),
    item_type text not null check (item_type in ('matter','party')),
    item bigint not null,
    last_viewed_at timestamptz not null default now(),
    unique (staff, item_type, item)
);
create index recent_item_staff_idx on deedbox.recent_item (staff, last_viewed_at desc);
grant select, insert, update, delete on deedbox.recent_item to deedbox_app;

create table deedbox.pinned_item (
    id bigint generated always as identity primary key,
    staff bigint not null references deedbox.staff_member(id),
    item_type text not null check (item_type in ('matter','party')),
    item bigint not null,
    position int not null,
    unique (staff, item_type, item),
    unique (staff, position)
);
grant select, insert, update, delete on deedbox.pinned_item to deedbox_app;

create or replace function deedbox.pinned_item_cap() returns trigger
language plpgsql as $$
begin
  if (select count(*) from deedbox.pinned_item p where p.staff = new.staff) >= 20 then
    raise exception 'twenty pins is the cap; unpin something first';
  end if;
  return new;
end $$;
create trigger pinned_item_cap before insert on deedbox.pinned_item
for each row execute function deedbox.pinned_item_cap();

------------------------------------------------------------------------------
-- The search index and its synchronous feeders.
------------------------------------------------------------------------------
create table deedbox.search_index (
    id bigint generated always as identity primary key,
    entry_type text not null check (entry_type in
      ('matter','party','note','task','key_date','time_entry','custom_field_value')),
    source bigint not null,
    matter bigint,
    owner_staff bigint,
    display_title text not null,
    body text not null,
    updated_at timestamptz not null default now(),
    unique (entry_type, source)
);
create index search_index_title_trgm on deedbox.search_index using gin (display_title extensions.gin_trgm_ops);
create index search_index_body_trgm on deedbox.search_index using gin (body extensions.gin_trgm_ops);
create index search_index_matter_idx on deedbox.search_index (matter);
grant select, insert, update, delete on deedbox.search_index to deedbox_app;

create or replace function deedbox.search_upsert(
    p_type text, p_source bigint, p_title text, p_body text,
    p_matter bigint default null, p_owner bigint default null)
returns void language plpgsql as $$
begin
  insert into deedbox.search_index (entry_type, source, matter, owner_staff, display_title, body)
  values (p_type, p_source, p_matter, p_owner, coalesce(p_title,''), coalesce(p_body,''))
  on conflict (entry_type, source) do update
    set matter = excluded.matter, owner_staff = excluded.owner_staff,
        display_title = excluded.display_title, body = excluded.body, updated_at = now();
end $$;

create or replace function deedbox.search_remove(p_type text, p_source bigint)
returns void language sql as $$
  delete from deedbox.search_index where entry_type = p_type and source = p_source;
$$;

create or replace function deedbox.matter_search_sync() returns trigger
language plpgsql as $$
begin
  perform deedbox.search_upsert('matter', new.id,
    new.matter_number || ' ' || new.title, coalesce(new.summary,''), new.id);
  return null;
end $$;
create trigger matter_search_sync after insert or update on deedbox.matter
for each row execute function deedbox.matter_search_sync();

create or replace function deedbox.party_name_search_sync() returns trigger
language plpgsql as $$
begin
  perform deedbox.search_upsert('party', new.id, new.full_name, '', null, null);
  return null;
end $$;
create trigger party_name_search_sync after insert or update on deedbox.party_name
for each row execute function deedbox.party_name_search_sync();

create or replace function deedbox.note_search_sync() returns trigger
language plpgsql as $$
begin
  if new.deleted_at is not null then
    perform deedbox.search_remove('note', new.id);
  else
    perform deedbox.search_upsert('note', new.id, left(new.body, 80), new.body,
      case when new.owner_type = 'matter' then new.owner end);
  end if;
  return null;
end $$;
create trigger note_search_sync after insert or update on deedbox.note
for each row execute function deedbox.note_search_sync();

create or replace function deedbox.task_search_sync() returns trigger
language plpgsql as $$
begin
  if new.deleted_at is not null then
    perform deedbox.search_remove('task', new.id);
  else
    perform deedbox.search_upsert('task', new.id, new.title, '',
      new.matter, case when new.matter is null then new.owner end);
  end if;
  return null;
end $$;
create trigger task_search_sync after insert or update on deedbox.task
for each row execute function deedbox.task_search_sync();

create or replace function deedbox.key_date_search_sync() returns trigger
language plpgsql as $$
begin
  if new.deleted_at is not null then
    perform deedbox.search_remove('key_date', new.id);
  else
    perform deedbox.search_upsert('key_date', new.id, new.title, '', new.matter);
  end if;
  return null;
end $$;
create trigger key_date_search_sync after insert or update on deedbox.key_date
for each row execute function deedbox.key_date_search_sync();

create or replace function deedbox.time_entry_search_sync() returns trigger
language plpgsql as $$
begin
  if new.deleted_at is not null then
    perform deedbox.search_remove('time_entry', new.id);
  else
    -- narrative only; money values never enter the index.
    perform deedbox.search_upsert('time_entry', new.id, left(new.narrative, 80), new.narrative, new.matter);
  end if;
  return null;
end $$;
create trigger time_entry_search_sync after insert or update on deedbox.time_entry
for each row execute function deedbox.time_entry_search_sync();

create or replace function deedbox.custom_value_search_sync() returns trigger
language plpgsql as $$
begin
  if new.text_value is not null then
    perform deedbox.search_upsert('custom_field_value', new.id, left(new.text_value, 80), new.text_value,
      case when new.owner_type = 'matter' then new.owner end);
  else
    perform deedbox.search_remove('custom_field_value', new.id);
  end if;
  return null;
end $$;
create trigger custom_value_search_sync after insert or update on deedbox.custom_field_value
for each row execute function deedbox.custom_value_search_sync();

------------------------------------------------------------------------------
-- Performance targets and staff groups.
------------------------------------------------------------------------------
create table deedbox.staff_group (
    id bigint generated always as identity primary key,
    name text not null,
    active boolean not null default true,
    created_at timestamptz not null default now(),
    deleted_at timestamptz,
    deleted_by bigint
);
create unique index staff_group_name_unique on deedbox.staff_group (name) where active;
create table deedbox.staff_group_member (
    id bigint generated always as identity primary key,
    "group" bigint not null references deedbox.staff_group(id),
    staff bigint not null references deedbox.staff_member(id),
    unique ("group", staff)
);
grant select, insert, update, delete on deedbox.staff_group, deedbox.staff_group_member to deedbox_app;

create table deedbox.performance_target (
    id bigint generated always as identity primary key,
    subject_kind text not null check (subject_kind in ('staff','group')),
    subject bigint not null,
    metric text not null check (metric in ('hours_worked','billable_hours','amount_billed','amount_collected')),
    amount numeric(14,2) not null,
    period_kind text not null check (period_kind in ('week','month','quarter','year','custom')),
    period_start date not null,
    period_end date,
    created_at timestamptz not null default now(),
    deleted_at timestamptz,
    deleted_by bigint,
    check ((period_kind = 'custom') = (period_end is not null))
);
create unique index performance_target_unique
  on deedbox.performance_target (subject_kind, subject, metric, period_start) where deleted_at is null;
grant select, insert, update on deedbox.performance_target to deedbox_app;

------------------------------------------------------------------------------
-- Bulk-operation completion: the reversal outcome per item.
------------------------------------------------------------------------------
alter table deedbox.bulk_operation_item
  add column reversal_outcome text check (reversal_outcome in ('reversed','blocked')),
  add column block_reason text;

commit;
