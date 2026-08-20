-- 0003_security_principals — capabilities, roles, staff, sessions, devices,
-- MFA, auth policy, anomaly machinery, examiner grants, payload keys,
-- resilience + control documents; register catalogue hardened to its
-- final form.
--
-- Deferred to stage 3 (they reference the matter table): the restriction
-- rows, the last-guardian coverage guard on staff/role writes, the
-- visibility predicate and its row-security mirror.
--
-- Implementation notes:
--   * matter.status_changed's reopen-only reason requirement is enforced by
--     the matter domain's reopen operation (kind-level flag stays false).
--   * money-authorisation capability rows require the explicit-grant session
--     flag (deedbox.explicit_money_grant = 'on'), the schema half of the
--     distinct confirmation step.
--   * Default role-capability grants below are the shipped seed matrix,
--     adjustable by releases within the safe bounds.

begin;

------------------------------------------------------------------------------
-- Register event-kind catalogue hardened (namespace, reason, matter-link,
-- timeline flags) + final privileged/reason markings.
------------------------------------------------------------------------------
alter table deedbox.register_event_kind
  add column namespace text generated always as (split_part(kind, '.', 1)) stored,
  add column reason_required boolean not null default false,
  add column matter_link text not null default 'optional'
    check (matter_link in ('required','optional','forbidden')),
  add column timeline_eligible boolean not null default false,
  add column since_version text not null default '0.1';

update deedbox.register_event_kind set privileged_required = true where kind in
 ('money.payment_authorised','restriction.changed','permission.changed','role.changed',
  'auth_policy.changed','staff.deactivated','staff.reactivated','export.performed',
  'merge.executed','key.issued','key.revoked','examiner.granted','examiner.revoked',
  'register.erased','setting.changed','pack.activated','namespace.changed');
update deedbox.register_event_kind set reason_required = true where kind in
 ('restriction.changed','bulk.reversed','import.batch_reversed','examiner.revoked','register.erased');
update deedbox.register_event_kind set timeline_eligible = true where kind in
 ('record.created','record.changed','record.soft_deleted','record.restored',
  'matter.status_changed','matter.close_approved','bill.issued','bill.state_changed',
  'money.transaction_posted','money.payment_authorised','restriction.changed',
  'merge.executed','reminder.contact_made','master_data.changed');
update deedbox.register_event_kind set matter_link = 'required' where kind in
 ('matter.status_changed','matter.close_approved','restricted.read');

create or replace function deedbox.register_entry_before_insert() returns trigger
security definer set search_path = deedbox, pg_temp
language plpgsql as $$
declare
  head deedbox.register_chain_head%rowtype;
  kind_row deedbox.register_event_kind%rowtype;
  canonical text;
begin
  select * into kind_row from deedbox.register_event_kind where kind = new.event_kind;
  if kind_row.privileged_required then
    new.privileged := true;
  end if;
  if new.privileged then
    if new.detail is null or not (new.detail ? 'before') or not (new.detail ? 'after') then
      raise exception 'privileged register write refused: detail must carry before and after values (kind %)', new.event_kind;
    end if;
  end if;
  if kind_row.reason_required and (new.reason is null or btrim(new.reason) = '') then
    raise exception 'register write refused: kind % requires a reason', new.event_kind;
  end if;
  if kind_row.matter_link = 'required' and new.matter is null then
    raise exception 'register write refused: kind % requires a matter link', new.event_kind;
  end if;
  if kind_row.matter_link = 'forbidden' and new.matter is not null then
    raise exception 'register write refused: kind % forbids a matter link', new.event_kind;
  end if;
  select * into head from deedbox.register_chain_head where firm = new.firm for update;
  if not found then
    insert into deedbox.register_chain_head (firm) values (new.firm) returning * into head;
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

-- Deletion-policy rows the final catalogue names beyond 0001's seed.
insert into deedbox.deletion_policy (entity_type, mode) values
('money_receipt','never_deletable'),('money_payment','never_deletable'),
('conflict_resolution','never_deletable'),('statutory_register_entry','never_deletable'),
('intake_party','soft_delete'),('party_link','soft_delete'),
('matter_party','soft_delete'),('matter_relation','soft_delete')
on conflict (entity_type) do nothing;

------------------------------------------------------------------------------
-- 2.1 capability — the 47-key catalogue with safe-bounds metadata.
------------------------------------------------------------------------------
create table deedbox.capability (
    key text primary key,
    description text not null default '',
    grantable_to_firm_roles boolean not null default true,
    external_role_permitted boolean not null default false,
    money_authorisation boolean not null default false,
    admin_floor boolean not null default false
);
grant select on deedbox.capability to deedbox_app;

insert into deedbox.capability (key, grantable_to_firm_roles, money_authorisation, admin_floor) values
('see_firm_money',true,false,false),('see_cost_rates',true,false,false),
('money.receive',true,true,false),('money.authorise_payment',true,true,false),
('money.authorise_second',true,true,false),('money.certify_reconciliation',true,true,false),
('money.certify_close',true,true,false),('money.apply_held_funds',true,true,false),
('bill.issue',true,false,false),('bill.approve',true,false,false),
('matter.close',true,false,false),('matter.reopen',true,false,false),
('matter.edit_closed',true,false,false),('restriction.manage',true,false,false),
('merge.execute',true,false,false),('report.firm_financial',true,false,false),
('report.own_figures',true,false,false),('export.full',true,false,false),
('register.read',true,false,true),('import.execute',true,false,false),
('import.reverse',true,false,false),('keys.manage',true,false,false),
('roles.manage',true,false,false),('deleted.restore',true,false,false),
('conflict.run',true,false,false),('intake.convert',true,false,false),
('security.administer',true,false,true),('session.terminate_others',true,false,false),
('money.record_payment',true,false,false),('money.manage_earmarks',true,false,false),
('money.manage_entitlements',true,false,false),('money.manage_accounts',true,false,false),
('money.manage_dormancy',true,false,false),('money.manage_incidents',true,false,false),
('money.issue_statements',true,false,false),('money.examination_export',true,false,false),
('money.grant_examiner',true,false,false),
('settings.manage',true,false,false),('pack.activate',false,false,false),
('numbering.manage',true,false,false),('lists.manage',true,false,false),
('fields.manage',true,false,false),('templates.manage',true,false,false),
('private_layer.manage',false,false,false),
('workflow.manage',true,false,false),('report.schedule_manage',true,false,false),
('reminders.manage',true,false,false);

------------------------------------------------------------------------------
-- 2.5/2.6 role + role_capability with safe-bounds enforcement.
------------------------------------------------------------------------------
create table deedbox.role (
    id bigint generated always as identity primary key,
    name text not null,
    system_key text unique check (system_key in ('administrator','accounts','lawyer','support_staff','portal_client')),
    external boolean not null default false,
    active boolean not null default true
);
create unique index role_name_unique on deedbox.role (name) where active;
grant select, insert, update on deedbox.role to deedbox_app;

create table deedbox.role_capability (
    role bigint not null references deedbox.role(id),
    capability text not null references deedbox.capability(key),
    scope text not null default 'firm_wide' check (scope in ('firm_wide','own_figures_only','none')),
    primary key (role, capability)
);
grant select, insert, update, delete on deedbox.role_capability to deedbox_app;

create or replace function deedbox.role_guard() returns trigger
language plpgsql as $$
begin
  if tg_op = 'DELETE' then
    raise exception 'roles are deactivated, never deleted';
  end if;
  if old.system_key is not null then
    if new.system_key is distinct from old.system_key then
      raise exception 'system_key is immutable';
    end if;
    if new.active = false then
      raise exception 'the shipped roles cannot be deactivated';
    end if;
  end if;
  if old.active and not new.active then
    if exists (select 1 from deedbox.staff_member s where s.role = old.id and s.active) then
      raise exception 'a role with active staff cannot be deactivated';
    end if;
    if old.id in (select rc.role from deedbox.role_capability rc
                   where rc.capability = 'security.administer' and rc.scope <> 'none')
       and not exists (
         select 1 from deedbox.role_capability rc join deedbox.role r on r.id = rc.role
          where rc.capability = 'security.administer' and rc.scope <> 'none'
            and r.active and r.id <> old.id) then
      raise exception 'the last active role holding security.administer cannot be deactivated';
    end if;
  end if;
  return new;
end $$;
create trigger role_guard before update or delete on deedbox.role
for each row execute function deedbox.role_guard();

create or replace function deedbox.role_capability_guard() returns trigger
language plpgsql as $$
declare cap deedbox.capability%rowtype; r deedbox.role%rowtype;
begin
  cap := null; r := null;
  if tg_op in ('INSERT','UPDATE') then
    select * into cap from deedbox.capability where key = new.capability;
    select * into r from deedbox.role where id = new.role;
    if r.external and not cap.external_role_permitted then
      raise exception 'external roles can never receive %', new.capability;
    end if;
    if cap.money_authorisation
       and coalesce(current_setting('deedbox.explicit_money_grant', true), '') <> 'on' then
      raise exception 'money-authorisation capabilities are granted only through the explicit grant operation';
    end if;
    if cap.admin_floor and r.system_key = 'administrator' and new.scope = 'none' then
      raise exception 'the administrator role may never lose %', new.capability;
    end if;
  end if;
  if tg_op in ('UPDATE','DELETE') then
    select * into cap from deedbox.capability where key = old.capability;
    select * into r from deedbox.role where id = old.role;
    if cap.admin_floor and r.system_key = 'administrator'
       and (tg_op = 'DELETE' or new.scope = 'none') then
      raise exception 'the administrator role may never lose %', old.capability;
    end if;
    if old.capability = 'security.administer' and (tg_op = 'DELETE' or new.scope = 'none')
       and not exists (
         select 1 from deedbox.role_capability rc join deedbox.role rr on rr.id = rc.role
          where rc.capability = 'security.administer' and rc.scope <> 'none'
            and rr.active and rc.role <> old.role) then
      raise exception 'the last active holder of security.administer cannot lose it';
    end if;
  end if;
  if tg_op = 'DELETE' then return old; end if;
  return new;
end $$;
create trigger role_capability_guard
before insert or update or delete on deedbox.role_capability
for each row execute function deedbox.role_capability_guard();

-- Shipped roles + the seed grant matrix (release-adjustable within safe bounds).
insert into deedbox.role (name, system_key, external) values
('Administrator','administrator',false),
('Accounts','accounts',false),
('Lawyer','lawyer',false),
('Support staff','support_staff',false),
('Portal client','portal_client',true);

select set_config('deedbox.explicit_money_grant','on', false);
insert into deedbox.role_capability (role, capability)
select r.id, c.key from deedbox.role r cross join deedbox.capability c
 where r.system_key = 'administrator' and c.grantable_to_firm_roles is not null
   and c.key <> 'report.own_figures';
insert into deedbox.role_capability (role, capability)
select r.id, c.key from deedbox.role r join deedbox.capability c on c.key in
 ('see_firm_money','money.receive','money.authorise_payment','money.authorise_second',
  'money.certify_reconciliation','money.certify_close','money.apply_held_funds',
  'money.record_payment','money.manage_earmarks','money.manage_entitlements',
  'money.manage_accounts','money.manage_dormancy','money.manage_incidents',
  'money.issue_statements','bill.issue','bill.approve','report.firm_financial',
  'register.read','reminders.manage','conflict.run')
 where r.system_key = 'accounts';
insert into deedbox.role_capability (role, capability, scope)
select r.id, c.key, case when c.key='report.own_figures' then 'own_figures_only' else 'firm_wide' end
  from deedbox.role r join deedbox.capability c on c.key in
 ('report.own_figures','conflict.run','intake.convert','matter.close','bill.issue')
 where r.system_key = 'lawyer';
insert into deedbox.role_capability (role, capability)
select r.id, c.key from deedbox.role r join deedbox.capability c on c.key in
 ('conflict.run','intake.convert')
 where r.system_key = 'support_staff';
select set_config('deedbox.explicit_money_grant','off', false);

------------------------------------------------------------------------------
-- Office (staff's home; number patterns may use its code).
------------------------------------------------------------------------------
create table deedbox.office (
    id bigint generated always as identity primary key,
    name text not null,
    code text unique,
    address jsonb,
    active boolean not null default true
);
create unique index office_name_unique on deedbox.office (name) where active;
grant select, insert, update on deedbox.office to deedbox_app;

create or replace function deedbox.office_guard() returns trigger
language plpgsql as $$
begin
  if tg_op = 'DELETE' then
    raise exception 'offices are deactivated, never deleted';
  end if;
  if old.active and not new.active then
    if exists (select 1 from deedbox.number_format f
                where f.active and f.scope = old.code) then
      raise exception 'an office named by an active number format cannot be deactivated';
    end if;
  end if;
  return new;
end $$;
create trigger office_guard before update or delete on deedbox.office
for each row execute function deedbox.office_guard();

------------------------------------------------------------------------------
-- 2.7/2.8 staff + MFA credentials (with the enrolment mirror).
------------------------------------------------------------------------------
create table deedbox.staff_member (
    id bigint generated always as identity primary key,
    person_name jsonb not null,
    login text not null,
    role bigint not null references deedbox.role(id),
    office bigint not null references deedbox.office(id),
    email text not null,
    start_date date not null default current_date,
    active boolean not null default true,
    mfa_enrolled boolean not null default false,
    identity_provider_subject text unique,
    password_hash text,
    password_updated_at timestamptz,
    deactivated_at timestamptz,
    deactivated_by bigint,
    check (active = (deactivated_at is null))
);
create unique index staff_login_unique on deedbox.staff_member (lower(login));
grant select, insert, update on deedbox.staff_member to deedbox_app;

create or replace function deedbox.staff_guard() returns trigger
language plpgsql as $$
begin
  if tg_op = 'DELETE' then
    raise exception 'staff members are deactivated, never deleted';
  end if;
  if old.active and not new.active then
    -- last-active-administrator person guard; the restriction-guardian
    -- guard joins this check in stage 3.
    if exists (select 1 from deedbox.role_capability rc
                where rc.role = old.role and rc.capability = 'security.administer' and rc.scope <> 'none')
       and not exists (
         select 1 from deedbox.staff_member s
           join deedbox.role_capability rc on rc.role = s.role
          where rc.capability = 'security.administer' and rc.scope <> 'none'
            and s.active and s.id <> old.id) then
      raise exception 'the last active administrator cannot be deactivated';
    end if;
    new.deactivated_at := coalesce(new.deactivated_at, now());
    -- all the person''s sessions end in the same transaction.
    update deedbox.session
       set ended_at = now(), end_reason = 'deactivation'
     where principal_kind = 'staff' and principal = old.id and ended_at is null;
  end if;
  if not old.active and new.active then
    if not exists (select 1 from deedbox.role r where r.id = new.role and r.active) then
      raise exception 'cannot reactivate onto an inactive role';
    end if;
    new.deactivated_at := null; new.deactivated_by := null;
  end if;
  return new;
end $$;
create trigger staff_guard before update or delete on deedbox.staff_member
for each row execute function deedbox.staff_guard();

create table deedbox.mfa_credential (
    id bigint generated always as identity primary key,
    staff bigint not null references deedbox.staff_member(id),
    factor_kind text not null check (factor_kind in ('totp','security_key','recovery_code_set')),
    label text,
    secret_ref text not null,
    enrolled_at timestamptz not null default now(),
    last_used_at timestamptz,
    revoked_at timestamptz,
    revoked_by bigint
);
create unique index mfa_credential_unique
  on deedbox.mfa_credential (staff, factor_kind, coalesce(label,'')) where revoked_at is null;
grant select, insert, update on deedbox.mfa_credential to deedbox_app;

create or replace function deedbox.mfa_mirror() returns trigger
language plpgsql as $$
declare s bigint;
begin
  if tg_op = 'DELETE' then
    raise exception 'MFA credentials are revoked, never deleted';
  end if;
  s := new.staff;
  update deedbox.staff_member sm
     set mfa_enrolled = exists (
       select 1 from deedbox.mfa_credential m
        where m.staff = s and m.revoked_at is null)
   where sm.id = s;
  return new;
end $$;
create trigger mfa_mirror after insert or update on deedbox.mfa_credential
for each row execute function deedbox.mfa_mirror();
create trigger mfa_no_delete before delete on deedbox.mfa_credential
for each row execute function deedbox.mfa_mirror();

------------------------------------------------------------------------------
-- 2.9/2.10 devices + sessions.
------------------------------------------------------------------------------
create table deedbox.device (
    id bigint generated always as identity primary key,
    owner_kind text not null check (owner_kind in ('staff','portal_client','examiner')),
    owner bigint not null,
    fingerprint text not null,
    label text,
    first_seen timestamptz not null default now(),
    last_seen timestamptz not null default now(),
    trusted boolean not null default false,
    trusted_at timestamptz,
    trust_expires_at timestamptz,
    revoked_at timestamptz,
    revoked_by bigint,
    network_hint text,
    unique (owner_kind, owner, fingerprint)
);
grant select, insert, update on deedbox.device to deedbox_app;

create table deedbox.session (
    id bigint generated always as identity primary key,
    principal_kind text not null check (principal_kind in ('staff','portal_client','examiner')),
    principal bigint not null,
    device bigint not null references deedbox.device(id),
    started_at timestamptz not null default now(),
    last_seen_at timestamptz not null default now(),
    ended_at timestamptz,
    end_reason text check (end_reason in ('logout','timeout','admin_end','deactivation','device_revoked','grant_expired')),
    step_up_passed boolean not null default false,
    step_up_at timestamptz,
    examiner_grant bigint,
    check ((ended_at is null) = (end_reason is null)),
    check ((not step_up_passed) or step_up_at is not null),
    check ((principal_kind = 'examiner') = (examiner_grant is not null))
);
create index session_active_idx on deedbox.session (principal_kind, principal) where ended_at is null;
grant select, insert, update on deedbox.session to deedbox_app;

create or replace function deedbox.session_guard() returns trigger
language plpgsql as $$
begin
  if tg_op = 'DELETE' then
    raise exception 'sessions are never deleted';
  end if;
  if old.ended_at is not null then
    raise exception 'an ended session is terminal';
  end if;
  return new;
end $$;
create trigger session_guard before update or delete on deedbox.session
for each row execute function deedbox.session_guard();

------------------------------------------------------------------------------
-- 2.11 auth_policy (one row per firm).
------------------------------------------------------------------------------
create table deedbox.auth_policy (
    firm bigint primary key references deedbox.firm(id),
    mfa_scope text not null default 'off' check (mfa_scope in ('off','named_roles','all_users')),
    mfa_roles jsonb,
    idp_config jsonb,
    step_up_on_unrecognised boolean not null default true,
    step_up_email_fallback boolean not null default true,
    check ((mfa_scope = 'named_roles') = (mfa_roles is not null))
);
grant select, insert, update on deedbox.auth_policy to deedbox_app;

------------------------------------------------------------------------------
-- 2.12 anomaly rules, alerts, cursors (seeded shipped defaults).
------------------------------------------------------------------------------
create table deedbox.anomaly_rule (
    id bigint generated always as identity primary key,
    key text not null unique check (key in
      ('repeated_sign_in_failure','large_export','permission_escalation','private_layer_violation')),
    threshold jsonb not null,
    active boolean not null default true
);
insert into deedbox.anomaly_rule (key, threshold) values
('repeated_sign_in_failure','{"failures":5,"window_minutes":15}'),
('large_export','{"rows":10000,"any_restricted_matter":true}'),
('permission_escalation','{"money_authorisation_grants":true,"security_administer_grants":true,"administrator_role_changes":true}'),
('private_layer_violation','{"any":true}');

create table deedbox.anomaly_alert (
    id bigint generated always as identity primary key,
    rule bigint not null references deedbox.anomaly_rule(id),
    triggering_register_entries jsonb not null,
    summary text not null,
    raised_at timestamptz not null default now(),
    acknowledged_by bigint,
    acknowledged_at timestamptz
);
create table deedbox.anomaly_cursor (
    rule bigint primary key references deedbox.anomaly_rule(id),
    last_seq bigint not null default 0
);
grant select on deedbox.anomaly_rule to deedbox_app;
grant select, insert, update on deedbox.anomaly_alert to deedbox_app;
grant select on deedbox.anomaly_cursor to deedbox_app;

create trigger anomaly_alert_no_delete before delete on deedbox.anomaly_alert
for each row execute function deedbox.refuse_mutation();

------------------------------------------------------------------------------
-- 2.13 examiner grants.
------------------------------------------------------------------------------
create table deedbox.examiner_grant (
    id bigint generated always as identity primary key,
    examiner_name text not null,
    login text not null,
    secret_hash text not null,
    period_start date not null,
    period_end date not null,
    starts_at timestamptz not null,
    expires_at timestamptz not null,
    revoked_at timestamptz,
    revoked_by bigint,
    granted_by bigint not null references deedbox.staff_member(id),
    check (expires_at > starts_at),
    check (period_end >= period_start)
);
create unique index examiner_login_unique on deedbox.examiner_grant (login)
  where revoked_at is null;
grant select, insert, update on deedbox.examiner_grant to deedbox_app;

------------------------------------------------------------------------------
-- 2.16/2.17 payload keys (the narrowest update grant) + read-dedup markers.
------------------------------------------------------------------------------
create table deedbox.register_payload_key (
    entry bigint not null unique references deedbox.register_entry(id),
    key_cipher bytea,
    destroyed_at timestamptz,
    destroyed_by bigint
);
-- no app grants: the erasure operation (a definer function, later change file)
-- is the only writer.

create table deedbox.restricted_read_marker (
    session_ref bigint not null,
    matter bigint not null,
    surface text not null,
    primary key (session_ref, matter, surface)
);
grant select, insert, delete on deedbox.restricted_read_marker to deedbox_app;

------------------------------------------------------------------------------
-- 2.19/2.20 resilience events + control documents.
------------------------------------------------------------------------------
create table deedbox.resilience_event (
    id bigint generated always as identity primary key,
    kind text not null check (kind in ('restore_test','backup_verification')),
    environment text not null,
    started_at timestamptz not null default now(),
    completed_at timestamptz,
    outcome text not null default 'running' check (outcome in ('running','passed','failed')),
    measured_recovery_point_minutes int,
    measured_recovery_minutes int,
    artefact text,
    notes text,
    check ((outcome = 'running') = (completed_at is null))
);
create table deedbox.control_document (
    key text not null check (key in ('access_control','change_management','logging','backup','hardening_guide')),
    version text not null,
    artefact text not null,
    effective_from date not null,
    primary key (key, version)
);
grant select, insert, update on deedbox.resilience_event to deedbox_app;
grant select on deedbox.control_document to deedbox_app;

create trigger resilience_no_delete before delete on deedbox.resilience_event
for each row execute function deedbox.refuse_mutation();
create trigger control_document_no_mutation before update or delete on deedbox.control_document
for each row execute function deedbox.refuse_mutation();

commit;
