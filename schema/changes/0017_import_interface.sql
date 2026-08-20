-- 0017_import_interface — the last schema slice of the core: message
-- templates (configuration-owned), the slot re-resolution proposal,
-- migrations and imports with the source-reference discipline,
-- integration keys and the structurally idempotent inbound
-- submission log — and the foreign-key closures those tables
-- unlock (intake's integration key; the reminder step's template; the
-- reminder contact's message and the dormancy contact's message).
-- This file carries the schema half only; the wizards, jobs, request
-- handlers and token validation are app-layer.
--
-- Implementation notes:
--   * message_template's token-set validation per purpose is the write
--     operation's duty (the documented token list is release content);
--     the schema fixes identity, channel-inclusive uniqueness, and the
--     pack-row read-only rule (pack rows carry their pack_version and
--     refuse firm edits).
--   * the submission log's uniqueness rule: one row per (key,
--     idempotency_key) among outcomes created/rejected; every replay
--     inserts its own duplicate_replayed row pointing at the original.
--   * With this file the schema layer of the core is closed: every
--     entity exists, guarded and tested.

begin;

------------------------------------------------------------------------------
-- message_template — configuration-owned; consumed by reminders, instalment
-- notices, statement covers.
------------------------------------------------------------------------------
create table deedbox.message_template (
    id bigint generated always as identity primary key,
    name text not null,
    channel text not null check (channel in ('email','text_message','task')),
    purpose text not null,
    subject text,
    body text not null,
    tokens_used jsonb not null,
    pack_version bigint references deedbox.pack_version(id),
    active boolean not null default true,
    created_at timestamptz not null default now()
);
create unique index message_template_name_unique
  on deedbox.message_template (name, channel) where active;
grant select, insert, update on deedbox.message_template to deedbox_app;

create or replace function deedbox.message_template_guard() returns trigger
language plpgsql as $$
begin
  if tg_op = 'DELETE' then
    raise exception 'templates are deactivated, never deleted';
  end if;
  if old.pack_version is not null then
    raise exception 'pack templates are read-only to firms; supersede via pack activation';
  end if;
  return new;
end $$;
create trigger message_template_guard before update or delete on deedbox.message_template
for each row execute function deedbox.message_template_guard();

alter table deedbox.reminder_step
  add constraint reminder_step_template_fk foreign key (template) references deedbox.message_template(id);
alter table deedbox.outbound_message
  add constraint outbound_message_template_fk foreign key (template) references deedbox.message_template(id);
alter table deedbox.reminder_contact
  add constraint reminder_contact_message_fk foreign key (outbound_message) references deedbox.outbound_message(id);
alter table deedbox.contact_attempt
  add constraint contact_attempt_message_fk foreign key (outbound_message) references deedbox.outbound_message(id);

-- the reminder step's channel must match its template's channel (the one
-- validation on the billing side, now enforceable).
create or replace function deedbox.reminder_step_template_guard() returns trigger
language plpgsql as $$
begin
  if new.template is not null then
    if (select t.channel from deedbox.message_template t where t.id = new.template) <> new.channel then
      raise exception 'a reminder step''s template must match its channel';
    end if;
  end if;
  return new;
end $$;
create trigger reminder_step_template_guard before insert or update on deedbox.reminder_step
for each row execute function deedbox.reminder_step_template_guard();

------------------------------------------------------------------------------
-- slot_reresolution_proposal — same discipline as the date proposal.
------------------------------------------------------------------------------
create table deedbox.slot_reresolution_proposal (
    id bigint generated always as identity primary key,
    matter bigint not null references deedbox.matter(id),
    trigger_facts jsonb not null,
    items jsonb not null,
    state text not null default 'pending'
      check (state in ('pending','confirmed','rejected','superseded')),
    decided_by bigint references deedbox.staff_member(id),
    decided_at timestamptz,
    applied jsonb,
    decision_note text,
    created_at timestamptz not null default now()
);
create index slot_reresolution_pending_idx on deedbox.slot_reresolution_proposal (matter) where state = 'pending';
grant select, insert, update on deedbox.slot_reresolution_proposal to deedbox_app;

create or replace function deedbox.slot_reresolution_guard() returns trigger
language plpgsql as $$
begin
  if tg_op = 'DELETE' then
    raise exception 'proposals are decided or superseded, never deleted';
  end if;
  if tg_op = 'INSERT' then
    if new.state <> 'pending' then
      raise exception 'a proposal is born pending';
    end if;
    update deedbox.slot_reresolution_proposal p set state = 'superseded'
     where p.matter = new.matter and p.state = 'pending';
    return new;
  end if;
  if old.state <> 'pending' then
    raise exception 'a decided proposal is immutable';
  end if;
  return new;
end $$;
create trigger slot_reresolution_guard before insert or update or delete on deedbox.slot_reresolution_proposal
for each row execute function deedbox.slot_reresolution_guard();

------------------------------------------------------------------------------
-- Migrations, mappings, batches, records, source references.
------------------------------------------------------------------------------
create table deedbox.migration (
    id bigint generated always as identity primary key,
    source_system text not null,
    started_at timestamptz not null default now(),
    completed_at timestamptz,
    summary jsonb,
    summary_artefact text
);
grant select, insert, update on deedbox.migration to deedbox_app;

create table deedbox.mapping_template (
    id bigint generated always as identity primary key,
    source_format_key text not null,
    record_type text not null,
    field_map jsonb not null,
    origin text not null check (origin in ('product','pack','firm')),
    name text not null,
    active boolean not null default true,
    unique (origin, source_format_key, record_type, name)
);
grant select, insert, update on deedbox.mapping_template to deedbox_app;

create or replace function deedbox.mapping_template_guard() returns trigger
language plpgsql as $$
begin
  if tg_op = 'DELETE' then
    raise exception 'mapping templates are deactivated, never deleted';
  end if;
  if old.origin in ('product','pack') then
    raise exception 'product and pack mappings are read-only to firms';
  end if;
  return new;
end $$;
create trigger mapping_template_guard before update or delete on deedbox.mapping_template
for each row execute function deedbox.mapping_template_guard();

create table deedbox.import_batch (
    id bigint generated always as identity primary key,
    migration bigint references deedbox.migration(id),
    mapping bigint references deedbox.mapping_template(id),
    record_domain text not null check (record_domain in
      ('clients','matters','bills','time','client_money_full_history','client_money_opening_balances','other')),
    mode text not null check (mode in ('validate_only','real')),
    state text not null default 'running'
      check (state in ('running','completed','refused','reversed','partially_blocked')),
    report_artefact text,
    counts jsonb not null default '{}',
    source_system text not null,
    started_at timestamptz not null default now(),
    finished_at timestamptz,
    check (state = 'running' or report_artefact is not null or state = 'refused')
);
create index import_batch_state_idx on deedbox.import_batch (state);
grant select, insert, update on deedbox.import_batch to deedbox_app;

create or replace function deedbox.import_batch_guard() returns trigger
language plpgsql as $$
begin
  if tg_op = 'DELETE' then
    raise exception 'import batches are never deleted';
  end if;
  if new.state is distinct from old.state then
    if not ( (old.state = 'running' and new.state in ('completed','refused'))
          or (old.state = 'completed' and new.state in ('reversed','partially_blocked'))
          or (old.state = 'partially_blocked' and new.state in ('reversed','partially_blocked')) ) then
      raise exception 'illegal import-batch transition % -> %', old.state, new.state;
    end if;
  elsif old.state not in ('running') then
    if new.counts is distinct from old.counts or new.report_artefact is distinct from old.report_artefact then
      raise exception 'a finished batch''s report is immutable';
    end if;
  end if;
  return new;
end $$;
create trigger import_batch_guard before update or delete on deedbox.import_batch
for each row execute function deedbox.import_batch_guard();

create table deedbox.import_record (
    id bigint generated always as identity primary key,
    batch bigint not null references deedbox.import_batch(id),
    source_ref text not null,
    disposition text not null check (disposition in ('accepted','accepted_with_warning','refused','updated')),
    message text,
    target_type text,
    target bigint,
    unique (batch, source_ref)
);
create index import_record_report_idx on deedbox.import_record (batch, disposition);
create index import_record_target_idx on deedbox.import_record (target_type, target);
grant select, insert on deedbox.import_record to deedbox_app;
create trigger import_record_append_only before update or delete on deedbox.import_record
for each row execute function deedbox.append_only_guard();

create table deedbox.source_reference (
    id bigint generated always as identity primary key,
    source_system text not null,
    source_ref text not null,
    target_type text not null,
    target bigint not null,
    created_at timestamptz not null default now(),
    unique (source_system, source_ref, target_type)
);
create index source_reference_target_idx on deedbox.source_reference (target_type, target);
grant select, insert, update on deedbox.source_reference to deedbox_app;

------------------------------------------------------------------------------
-- Integration keys and the structurally idempotent submission log.
------------------------------------------------------------------------------
create table deedbox.integration_key (
    id bigint generated always as identity primary key,
    label text not null,
    secret_hash text not null,
    issued_by bigint not null references deedbox.staff_member(id),
    issued_at timestamptz not null default now(),
    last_used_at timestamptz,
    revoked_at timestamptz,
    rate_limit jsonb not null default '{"per_minute":60,"per_day":5000}',
    test_mode boolean not null default false,
    payload_versions jsonb not null default '["1"]',
    key_display text not null unique
);
create index integration_key_active_idx on deedbox.integration_key (id) where revoked_at is null;
grant select, insert, update on deedbox.integration_key to deedbox_app;

create or replace function deedbox.integration_key_guard() returns trigger
language plpgsql as $$
begin
  if tg_op = 'DELETE' then
    raise exception 'keys are revoked, never deleted';
  end if;
  if old.revoked_at is not null then
    raise exception 'a revoked key is immutable';
  end if;
  if new.secret_hash is distinct from old.secret_hash
     or new.key_display is distinct from old.key_display
     or new.test_mode is distinct from old.test_mode
     or new.issued_by is distinct from old.issued_by
     or new.issued_at is distinct from old.issued_at then
    raise exception 'a key''s identity is immutable; issue a fresh key';
  end if;
  return new;
end $$;
create trigger integration_key_guard before update or delete on deedbox.integration_key
for each row execute function deedbox.integration_key_guard();

alter table deedbox.intake_record
  add constraint intake_source_key_fk
  foreign key (source_integration_key) references deedbox.integration_key(id);

create table deedbox.inbound_submission (
    id bigint generated always as identity primary key,
    key bigint not null references deedbox.integration_key(id),
    idempotency_key text not null,
    payload_version text not null,
    payload_verbatim jsonb not null,
    received_at timestamptz not null default now(),
    outcome text not null check (outcome in ('created','duplicate_replayed','rejected')),
    created_type text not null default 'none' check (created_type in ('intake_record','matter','none')),
    created bigint,
    acknowledgement jsonb not null,
    rejection_reason text,
    original bigint references deedbox.inbound_submission(id),
    test boolean not null,
    check ((outcome = 'rejected') <= (rejection_reason is not null)),
    check ((outcome = 'duplicate_replayed') = (original is not null))
);
create unique index inbound_submission_idempotent
  on deedbox.inbound_submission (key, idempotency_key) where outcome in ('created','rejected');
create index inbound_submission_key_idx on deedbox.inbound_submission (key, received_at);
create index inbound_submission_created_idx on deedbox.inbound_submission (created_type, created);
grant select, insert on deedbox.inbound_submission to deedbox_app;
create trigger inbound_submission_append_only before update or delete on deedbox.inbound_submission
for each row execute function deedbox.append_only_guard();

commit;
