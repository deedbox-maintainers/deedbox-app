-- 0029_private_layer_completion — the private-layer tables brought up to
-- their intended shape, plus what the provisioning machinery needs. The 0002
-- substrate shipped a skeleton nothing consumed until now: the namespace
-- prefix was wrong (firm_ vs the reserved pl_), the lifecycle was a boolean
-- where the intended lifecycle is registered → suspended → retired with
-- retired terminal, the database principal and declared jobs/mounts had no
-- home, and only four of the seven shipped extension points existed (one
-- under the wrong key). No deployment ever held rows in these tables, so the
-- reshape is a straight correction.
--
-- Also here, because provisioning cannot exist without them:
-- - - pl_views: the ISSUED VIEW SET — the only thing a private namespace's
--   database principal can ever read. Views run with their owner's rights
--   (so row security on base tables does not double-filter) while the
--   visibility predicate inside them reads the CALLER's session context —
--   views compiled with the visibility predicate bound to the session actor
--   context the platform sets. Absent context fails closed to zero rows. The
--   v1 catalogue is deliberately small (matters, matter parties, the
--   extension-point catalogue); it grows by numbered change when a real
--   package needs more.
-- - The provisioning functions (security definer, owner-privileged): they
--   create, rotate, revoke, regrant and freeze the pl_ login roles. Every
--   one refuses to touch a role outside the reserved pl_ prefix — the app
--   role must never be able to aim role commands at anything real.
--   Provisioning also creates the layer's OWN isolated schema (named after
--   the principal, owned by it): the home where private tables are
--   retained read-frozen. Product migrations never touch it; retirement
--   freezes it by disabling login while the deployment role keeps reading
--   it for the full export.

begin;

------------------------------------------------------------------------------
-- private_namespace: the corrected shape.
------------------------------------------------------------------------------
alter table deedbox.private_namespace drop constraint private_namespace_namespace_check;
alter table deedbox.private_namespace add constraint private_namespace_namespace_check
  check (namespace ~ '^pl_[a-z_]*$' and length(namespace) between 3 and 30);

alter table deedbox.private_namespace drop column suspended;
alter table deedbox.private_namespace
  add column state text not null default 'registered'
    check (state in ('registered','suspended','retired')),
  add column db_principal text not null,
  add column declared_jobs jsonb,
  add column declared_mounts jsonb;
alter table deedbox.private_namespace add constraint private_namespace_principal_check
  check (db_principal ~ '^pl_[a-z0-9_]+$');

create or replace function deedbox.private_namespace_guard() returns trigger
language plpgsql as $$
begin
  if tg_op = 'DELETE' then
    raise exception 'a namespace is never deleted; retire it';
  end if;
  if old.state = 'retired' then
    raise exception 'a retired namespace is terminal';
  end if;
  if new.namespace is distinct from old.namespace
     or new.db_principal is distinct from old.db_principal then
    raise exception 'a namespace and its principal are its identity; register a new one';
  end if;
  return new;
end $$;
create trigger private_namespace_guard before update or delete on deedbox.private_namespace
for each row execute function deedbox.private_namespace_guard();

------------------------------------------------------------------------------
-- ui_extension_point: deprecation fields + the shipped seven.
------------------------------------------------------------------------------
alter table deedbox.ui_extension_point
  add column deprecated_at timestamptz,
  add column earliest_retirement date;

update deedbox.ui_extension_point
   set point_key = 'report.menu_entry', location = 'report menu entry'
 where point_key = 'report.menu';

insert into deedbox.ui_extension_point (point_key, location, contract_version) values
  ('intake.side_panel','intake side panel','1.0'),
  ('matter.action_menu_entry','matter action menu entry','1.0'),
  ('global.nav_entry','global navigation entry','1.0');

------------------------------------------------------------------------------
-- The issued view set (v1 catalogue). Owner rights read the base tables;
-- deedbox.visible() reads the calling session's principal context and fails
-- closed, so every row served obeys the predicate of the actor the
-- platform stamped on the connection.
------------------------------------------------------------------------------
create schema pl_views;

-- The predicate crossing: a view applies its OWNER's rights to tables, but
-- FUNCTIONS inside a view execute as the CALLER — and the planner inlines a
-- plain SQL wrapper, exposing deedbox.* names the principal must not
-- resolve. This definer wrapper (never inlined, internals run as owner)
-- carries the predicate across the boundary while current_setting still
-- reads the CALLER's stamped session context.
create function pl_views.visible(p_matter bigint) returns boolean
language sql stable security definer set search_path = deedbox, pg_catalog as $$
  select deedbox.visible(p_matter);
$$;
revoke all on function pl_views.visible(bigint) from public;

create view pl_views.visible_matters as
  select m.id, m.matter_number, m.title, m.status, m.practice_area, m.office,
         m.responsible_lawyer, m.opened_date
    from deedbox.matter m
   where pl_views.visible(m.id);

create view pl_views.visible_matter_parties as
  select mp.id, mp.matter, mp.party, mp.capacity, mp.portal_access, p.display_name
    from deedbox.matter_party mp
    join deedbox.party p on p.id = mp.party
   where mp.deleted_at is null
     and pl_views.visible(mp.matter);

create view pl_views.extension_points as
  select point_key, location, contract_version, deprecation_state
    from deedbox.ui_extension_point;

------------------------------------------------------------------------------
-- Provisioning (security definer; the owner holds CREATEROLE). Every
-- function refuses roles outside the reserved pl_ prefix, so the app role
-- can only ever manage the private layer's own principals.
------------------------------------------------------------------------------
create or replace function deedbox.private_layer_assert_pl(p_role text) returns void
language plpgsql as $$
begin
  if p_role !~ '^pl_[a-z0-9_]{1,60}$' then
    raise exception 'private-layer principals live under the reserved pl_ prefix';
  end if;
end $$;

create or replace function deedbox.private_layer_provision(p_role text, p_secret text)
returns void language plpgsql security definer set search_path = deedbox, pg_catalog as $$
begin
  perform deedbox.private_layer_assert_pl(p_role);
  if length(coalesce(p_secret, '')) < 24 then
    raise exception 'the principal secret must be at least 24 characters';
  end if;
  if exists (select 1 from pg_catalog.pg_roles where rolname = p_role) then
    raise exception 'a role named % already exists', p_role;
  end if;
  execute format('create role %I login noinherit password %L', p_role, p_secret);
  execute format('grant usage on schema pl_views to %I', p_role);
  execute format('grant select on all tables in schema pl_views to %I', p_role);
  execute format('grant execute on all functions in schema pl_views to %I', p_role);
  -- the layer's OWN home (private tables retained read-frozen): an
  -- isolated schema the principal owns and product migrations never touch.
  -- Retirement freezes it by revoking login; the deployment role can still
  -- read it for the full export. Creating a schema OWNED BY another role
  -- demands momentary membership in it (SET ROLE rights), so the definer
  -- grants itself the just-created role, creates the schema, and lets go.
  execute format('grant %I to current_user', p_role);
  execute format('create schema %I authorization %I', p_role, p_role);
  execute format('revoke %I from current_user', p_role);
end $$;

create or replace function deedbox.private_layer_rotate(p_role text, p_secret text)
returns void language plpgsql security definer set search_path = deedbox, pg_catalog as $$
begin
  perform deedbox.private_layer_assert_pl(p_role);
  if length(coalesce(p_secret, '')) < 24 then
    raise exception 'the principal secret must be at least 24 characters';
  end if;
  if not exists (select 1 from pg_catalog.pg_roles where rolname = p_role) then
    raise exception 'no role named %', p_role;
  end if;
  execute format('alter role %I password %L', p_role, p_secret);
end $$;

create or replace function deedbox.private_layer_revoke(p_role text, p_disable_login boolean)
returns void language plpgsql security definer set search_path = deedbox, pg_catalog as $$
begin
  perform deedbox.private_layer_assert_pl(p_role);
  if not exists (select 1 from pg_catalog.pg_roles where rolname = p_role) then
    raise exception 'no role named %', p_role;
  end if;
  execute format('revoke select on all tables in schema pl_views from %I', p_role);
  execute format('revoke execute on all functions in schema pl_views from %I', p_role);
  execute format('revoke usage on schema pl_views from %I', p_role);
  if p_disable_login then
    execute format('alter role %I nologin', p_role);
  end if;
end $$;

create or replace function deedbox.private_layer_regrant(p_role text)
returns void language plpgsql security definer set search_path = deedbox, pg_catalog as $$
begin
  perform deedbox.private_layer_assert_pl(p_role);
  if not exists (select 1 from pg_catalog.pg_roles where rolname = p_role) then
    raise exception 'no role named %', p_role;
  end if;
  execute format('alter role %I login', p_role);
  execute format('grant usage on schema pl_views to %I', p_role);
  execute format('grant select on all tables in schema pl_views to %I', p_role);
  execute format('grant execute on all functions in schema pl_views to %I', p_role);
end $$;

revoke all on function deedbox.private_layer_provision(text, text) from public;
revoke all on function deedbox.private_layer_rotate(text, text) from public;
revoke all on function deedbox.private_layer_revoke(text, boolean) from public;
revoke all on function deedbox.private_layer_regrant(text) from public;
grant execute on function deedbox.private_layer_provision(text, text) to deedbox_app;
grant execute on function deedbox.private_layer_rotate(text, text) to deedbox_app;
grant execute on function deedbox.private_layer_revoke(text, boolean) to deedbox_app;
grant execute on function deedbox.private_layer_regrant(text) to deedbox_app;

commit;
