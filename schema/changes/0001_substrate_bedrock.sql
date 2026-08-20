-- 0001_substrate_bedrock — firm, settings, register spine, enforcement posture.
-- The pack tables ship here as shells; their full declarations arrive in 0002.
-- Runs as the deployment role. The application role (deedbox_app) receives
-- exactly the grants below and nothing else.
--
-- Implementation notes:
--   * firm.operating_currency is immutable from insert (rather than
--     immutable after the first money record) until the money stage ships
--     the record-based guard.
--   * Operation-level reason requirements (reopen, write-off, reversal,
--     transfer, restriction lift) are enforced by the owning operations in
--     later stages; the substrate enforces the privileged before/after rule
--     mechanically now.

begin;

------------------------------------------------------------------------------
-- Roles: deployment/app separation.
------------------------------------------------------------------------------
do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'deedbox_app') then
    create role deedbox_app nologin;
  end if;
end $$;

create schema if not exists deedbox;
grant usage on schema deedbox to deedbox_app;

------------------------------------------------------------------------------
-- Shells: country_pack / pack_version (full declarations arrive in 0002).
------------------------------------------------------------------------------
create table deedbox.country_pack (
    id bigint generated always as identity primary key,
    code text not null unique,
    name text not null,
    active_version bigint  -- fk added below (circular with pack_version)
);

create table deedbox.pack_version (
    id bigint generated always as identity primary key,
    pack bigint not null references deedbox.country_pack(id),
    version text not null,
    released_at timestamptz not null default now(),
    unique (pack, version)
);

alter table deedbox.country_pack
  add constraint country_pack_active_version_fk
  foreign key (active_version) references deedbox.pack_version(id)
  deferrable initially deferred;

grant select on deedbox.country_pack, deedbox.pack_version to deedbox_app;

------------------------------------------------------------------------------
-- firm — one row per installation.
------------------------------------------------------------------------------
create table deedbox.firm (
    id bigint generated always as identity primary key,
    name text not null,
    operating_currency text not null check (char_length(operating_currency) = 3),
    timezone text not null,
    country_pack bigint not null references deedbox.country_pack(id),
    created_at timestamptz not null default now()
);

create or replace function deedbox.firm_guard() returns trigger
language plpgsql as $$
begin
  if tg_op = 'DELETE' then
    raise exception 'firm rows are never deleted';
  end if;
  if new.operating_currency is distinct from old.operating_currency then
    raise exception 'operating_currency is immutable';
  end if;
  return new;
end $$;

create trigger firm_guard before update or delete on deedbox.firm
for each row execute function deedbox.firm_guard();

grant select, update on deedbox.firm to deedbox_app;  -- timezone/name via privileged registered operation; currency+delete blocked by trigger

------------------------------------------------------------------------------
-- setting_definition — the shipped catalogue (seeded below, app read-only).
------------------------------------------------------------------------------
create type deedbox.setting_value_type as enum
  ('boolean','integer','money','text','choice','duration_days','percentage','doc','decimal');

create table deedbox.setting_definition (
    id bigint generated always as identity primary key,
    key text not null unique,
    value_type deedbox.setting_value_type not null,
    neutral_default jsonb not null,
    allowed_values jsonb,
    description text not null
);
grant select on deedbox.setting_definition to deedbox_app;

insert into deedbox.setting_definition (key, value_type, neutral_default, allowed_values, description) values
('matter.close_requires_approval','boolean','false',null,'Whether closing a matter requires an approval step.'),
('matter.close_condition_unbilled','choice','"warn"','["warn","block"]','Close-request behaviour when unbilled work remains.'),
('matter.close_condition_outstanding','choice','"warn"','["warn","block"]','Close-request behaviour when bills remain outstanding.'),
('matter.close_condition_held_funds','choice','"block"','["warn","block"]','Close-REQUEST behaviour when client money remains held: warn permits submitting the request; block refuses even the request. Execution is always stopped by the hard ledger-zero guard regardless.'),
('matter.relations_absent_means_allowed','boolean','true',null,'Whether an absent relatable-areas pair row means the relation is allowed.'),
('bill.approval_required','boolean','false',null,'Whether bills pass an approval step before issue.'),
('billing.default_terms_days','integer','14',null,'Default payment terms in days for new bills.'),
('billing.interest_schedule','choice','"on_demand"','["on_demand","daily","monthly"]','Interest accrual schedule; on_demand means charges are computed when a user asks.'),
('time.unit_minutes','integer','6',null,'The firm''s time recording unit in minutes.'),
('money.dual_authorisation_threshold','money','null',null,'Amount at or above which a second authoriser is required; absent means no firm threshold (pack compulsion still applies).'),
('money.default_client_account','choice','null',null,'Default client-money account for the receipt form; absent means the form asks. Allowed values resolve at runtime to active pooled accounts.'),
('money.stale_review_alert_days','integer','30',null,'Days before stale instruments raise a review alert.'),
('arrangement.missed_grace_days','integer','0',null,'Grace days before an unpaid instalment counts as missed.'),
('topup.auto_issue','boolean','false',null,'Whether top-up requests issue automatically or await confirmation.'),
('topup.attach_to_next_bill_default','boolean','false',null,'Seed value for new funds policies'' attach-to-next-bill flag.'),
('budget.default_thresholds','doc','[50,80,100]',null,'Default alert thresholds (percentages) seeded onto budgets when the user supplies none.'),
('estimate.default_thresholds','doc','[50,80,100]',null,'Default alert thresholds (percentages) seeded onto estimates when the user supplies none.'),
('visibility.staff_scope','choice','"all_staff"','["all_staff","office","assignment"]','Staff visibility policy for unrestricted matters.'),
('undo.bulk_window_days','integer','7',null,'Reversibility window for bulk runs, in days.'),
('softdelete.retention_days','integer','90',null,'Default restore window for soft-deleted records, in days.'),
('statement.allocation_order','choice','"oldest_first"','["oldest_first","newest_first"]','One-action statement allocation order; oldest_first orders by due date, tie-broken by issue date then bill number.'),
('intake.enabled','boolean','true',null,'Whether the intake capability is enabled.'),
('conflict.required_before_open','boolean','false',null,'Whether matter opening requires a resolved conflict check.'),
('conflict.required_before_convert','boolean','false',null,'Whether intake conversion requires a resolved conflict check.'),
('conflict.restricted_match_contact','choice','"role"','["named_staff","role","firm_name_only"]','Whom a restricted conflict match names to ask; the role value resolves to holders of restriction.manage. An optional staff login accompanies named_staff.'),
('portal.financial_visibility','choice','"bills_and_statements"','["none","bills_and_statements","bills_statements_and_held_money"]','What financial information portal clients see.'),
('channel.bill_destination','choice','"office"','["office","client_money"]','Where a bill''s channel payment lands; read only where the pack''s routing declaration names firm_setting or is silent.'),
('auth.session_idle_minutes','integer','60',null,'Idle minutes before a session times out.'),
('auth.session_absolute_hours','integer','24',null,'Absolute session lifetime in hours.'),
('auth.device_trust_days','integer','90',null,'Days a passed step-up keeps a device trusted.'),
('auth.step_up_freshness_minutes','integer','10',null,'Maximum age of a step-up for dual-control approvals, in minutes.'),
('reporting.dashboard_period','choice','"calendar_month"','["calendar_month","calendar_quarter","calendar_year","rolling_30"]','Default dashboard period.'),
('keydates.critical_horizon_days','integer','30',null,'Horizon of the firm-wide critical dates view, in days.'),
('staff.available_hours_per_week','decimal','40',null,'Firm-wide available hours per week, feeding derived staff rates.');

------------------------------------------------------------------------------
-- firm_setting — insert-only, effective-dated history.
------------------------------------------------------------------------------
create table deedbox.firm_setting (
    id bigint generated always as identity primary key,
    definition bigint not null references deedbox.setting_definition(id),
    value jsonb not null,
    effective_from timestamptz not null default now(),
    created_at timestamptz not null default now(),
    unique (definition, effective_from)
);

create or replace function deedbox.refuse_mutation() returns trigger
language plpgsql as $$
begin
  raise exception '% rows are append-only: % refused', tg_table_name, tg_op;
end $$;

create trigger firm_setting_append_only
before update or delete on deedbox.firm_setting
for each row execute function deedbox.refuse_mutation();

grant select, insert on deedbox.firm_setting to deedbox_app;

-- The one read path: latest effective row at-or-before now, else neutral default.
create or replace function deedbox.current_setting_value(p_key text)
returns jsonb language sql stable as $$
  select coalesce(
    (select fs.value
       from deedbox.firm_setting fs
       join deedbox.setting_definition sd on sd.id = fs.definition
      where sd.key = p_key and fs.effective_from <= now()
      order by fs.effective_from desc limit 1),
    (select sd.neutral_default from deedbox.setting_definition sd where sd.key = p_key)
  );
$$;
grant execute on function deedbox.current_setting_value(text) to deedbox_app;

------------------------------------------------------------------------------
-- The register event-kind catalogue (closed, shipped, firm-scopeless).
------------------------------------------------------------------------------
create table deedbox.register_event_kind (
    kind text primary key,
    privileged_required boolean not null default false,
    description text not null default ''
);
grant select on deedbox.register_event_kind to deedbox_app;

insert into deedbox.register_event_kind (kind, privileged_required) values
('record.created',false),('record.changed',false),('record.soft_deleted',false),('record.restored',false),
('matter.status_changed',false),('matter.close_approved',false),
('bill.issued',false),('bill.state_changed',false),
('money.payment_authorised',true),('money.transaction_posted',false),('money.refusal_recorded',false),
('master_data.changed',false),
('restriction.changed',true),('permission.changed',true),('role.changed',true),
('signin.succeeded',false),('signin.failed',false),('signin.step_up',false),('signin.step_up_failed',false),
('session.ended',false),('mfa.enrolled',false),('mfa.removed',false),('auth_policy.changed',false),
('staff.deactivated',false),('staff.reactivated',false),
('export.performed',false),('restricted.read',false),
('merge.executed',true),
('bulk.committed',false),('bulk.reversed',false),
('import.batch_applied',false),('import.batch_reversed',false),
('key.used',false),('key.issued',false),('key.revoked',false),
('examiner.granted',false),('examiner.revoked',false),('examiner.read',false),
('anomaly.raised',false),('anomaly.acknowledged',false),
('chain.verified',false),('chain.break_detected',false),
('resilience.recorded',false),('register.erased',false),
('reminder.contact_made',false),
('setting.changed',false),('pack.installed',false),('pack.activated',false),
('numbering.format_changed',false),('list.changed',false),('field.changed',false),
('template.changed',false),('namespace.changed',true),('extension.point_changed',false);

------------------------------------------------------------------------------
-- register_entry + per-firm hash chain, chain-head locking, enforcement.
------------------------------------------------------------------------------
create table deedbox.register_chain_head (
    firm bigint primary key references deedbox.firm(id),
    last_seq bigint not null default 0,
    last_hash text not null default 'genesis'
);
-- The app role never touches the chain head directly; the register trigger
-- (security definer) maintains it. No grants to deedbox_app.

create sequence deedbox.register_seq;

create table deedbox.register_entry (
    id bigint generated always as identity primary key,
    firm bigint not null references deedbox.firm(id),
    seq bigint not null unique,
    occurred_at timestamptz not null default now(),
    actor_kind text not null check (actor_kind in ('staff','portal_client','integration_key','examiner','system_job')),
    actor bigint,
    session_ref bigint,
    event_kind text not null references deedbox.register_event_kind(kind),
    subject_type text not null,
    subject bigint not null,
    matter bigint,
    privileged boolean not null default false,
    detail jsonb,
    reason text,
    bulk_operation bigint,
    artefact text,
    payload_key_ref text,
    prev_hash text not null,
    entry_hash text not null
);

create index register_entry_matter_idx on deedbox.register_entry (matter) where matter is not null;
create index register_entry_kind_idx on deedbox.register_entry (event_kind);
create index register_entry_subject_idx on deedbox.register_entry (subject_type, subject);

create or replace function deedbox.register_entry_before_insert() returns trigger
security definer set search_path = deedbox, pg_temp
language plpgsql as $$
declare
  head deedbox.register_chain_head%rowtype;
  kind_row deedbox.register_event_kind%rowtype;
  canonical text;
begin
  select * into kind_row from deedbox.register_event_kind where kind = new.event_kind;
  -- privileged events must carry full before and after values; the write is
  -- physically refused without them.
  if kind_row.privileged_required then
    new.privileged := true;
  end if;
  if new.privileged then
    if new.detail is null
       or not (new.detail ? 'before')
       or not (new.detail ? 'after') then
      raise exception 'privileged register write refused: detail must carry before and after values (kind %)', new.event_kind;
    end if;
  end if;
  -- chain head locked LAST in the canonical lock order of any writing
  -- transaction; serialises hash computation per firm.
  select * into head from deedbox.register_chain_head where firm = new.firm for update;
  if not found then
    insert into deedbox.register_chain_head (firm) values (new.firm)
    returning * into head;
  end if;
  new.seq := nextval('deedbox.register_seq');
  new.prev_hash := head.last_hash;
  canonical := concat_ws('|',
      head.last_hash, new.firm::text, new.seq::text, new.occurred_at::text,
      new.actor_kind, coalesce(new.actor::text,''), new.event_kind,
      new.subject_type, new.subject::text, coalesce(new.matter::text,''),
      new.privileged::text, coalesce(new.detail::text,''),
      coalesce(new.reason,''), coalesce(new.artefact,''));
  new.entry_hash := encode(sha256(canonical::bytea), 'hex');
  update deedbox.register_chain_head
     set last_seq = new.seq, last_hash = new.entry_hash
   where firm = new.firm;
  return new;
end $$;

create trigger register_entry_before_insert
before insert on deedbox.register_entry
for each row execute function deedbox.register_entry_before_insert();

create trigger register_entry_append_only
before update or delete on deedbox.register_entry
for each row execute function deedbox.refuse_mutation();

grant select, insert on deedbox.register_entry to deedbox_app;

-- The completeness witness: walk the chain, return the number of breaks.
create or replace function deedbox.register_verify_chain(p_firm bigint)
returns bigint language plpgsql stable as $$
declare
  prev text := 'genesis';
  rec record;
  breaks bigint := 0;
  canonical text;
begin
  for rec in
    select * from deedbox.register_entry where firm = p_firm order by seq
  loop
    if rec.prev_hash is distinct from prev then
      breaks := breaks + 1;
    end if;
    canonical := concat_ws('|',
        rec.prev_hash, rec.firm::text, rec.seq::text, rec.occurred_at::text,
        rec.actor_kind, coalesce(rec.actor::text,''), rec.event_kind,
        rec.subject_type, rec.subject::text, coalesce(rec.matter::text,''),
        rec.privileged::text, coalesce(rec.detail::text,''),
        coalesce(rec.reason,''), coalesce(rec.artefact,''));
    if rec.entry_hash is distinct from encode(sha256(canonical::bytea), 'hex') then
      breaks := breaks + 1;
    end if;
    prev := rec.entry_hash;
  end loop;
  return breaks;
end $$;
grant execute on function deedbox.register_verify_chain(bigint) to deedbox_app;

------------------------------------------------------------------------------
-- event_display_template (render-time presentation; wording is a release
-- concern, never evidence). Seeded for substrate kinds; later stages extend.
------------------------------------------------------------------------------
create table deedbox.event_display_template (
    id bigint generated always as identity primary key,
    event_kind text not null references deedbox.register_event_kind(kind),
    template_key text not null,
    timeline_kind text not null check (timeline_kind in ('note','task','key_date','financial','administrative')),
    sensitivity jsonb,
    unique (event_kind)
);
grant select on deedbox.event_display_template to deedbox_app;

insert into deedbox.event_display_template (event_kind, template_key, timeline_kind) values
('setting.changed','display.setting_changed','administrative'),
('pack.installed','display.pack_installed','administrative'),
('pack.activated','display.pack_activated','administrative'),
('numbering.format_changed','display.numbering_format_changed','administrative'),
('record.created','display.record_created','administrative'),
('record.changed','display.record_changed','administrative');

------------------------------------------------------------------------------
-- deletion_policy — per-record-type rule, seeded per the shipped catalogue.
------------------------------------------------------------------------------
create table deedbox.deletion_policy (
    entity_type text primary key,
    mode text not null check (mode in ('never_deletable','soft_delete','hard_delete_allowed')),
    restore_window_days int
);
grant select on deedbox.deletion_policy to deedbox_app;

insert into deedbox.deletion_policy (entity_type, mode) values
('register_entry','never_deletable'),('ledger_line','never_deletable'),
('money_transaction','never_deletable'),('issued_bill','never_deletable'),
('bill_journal_entry','never_deletable'),('conflict_check','never_deletable'),
('reconciliation','never_deletable'),('period_close','never_deletable'),
('party_merge','never_deletable'),('refusal','never_deletable'),
('incident','never_deletable'),('remittance','never_deletable'),
('artefact','never_deletable'),('device','never_deletable'),
('session','never_deletable'),('anomaly_alert','never_deletable'),
('examiner_grant','never_deletable'),('resilience_event','never_deletable'),
('mfa_credential','never_deletable'),
('note','soft_delete'),('task','soft_delete'),('key_date','soft_delete'),
('unbilled_time_entry','soft_delete'),('unbilled_disbursement','soft_delete'),
('intake_record','soft_delete'),('saved_report','soft_delete'),
('contact_point','soft_delete'),('postal_address','soft_delete'),
('draft_bill','hard_delete_allowed'),('timer','hard_delete_allowed'),
('party_match_key','hard_delete_allowed'),('restricted_read_marker','hard_delete_allowed'),
('step_up_challenge','hard_delete_allowed'),('recent_item','hard_delete_allowed'),
('pinned_item','hard_delete_allowed'),('search_index_row','hard_delete_allowed'),
('prepared_bulk_run','hard_delete_allowed');

commit;
