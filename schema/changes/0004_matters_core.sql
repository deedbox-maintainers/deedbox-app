-- 0004_matters_core — parties, names, practice areas, matters (status machine),
-- matter parties, restriction rows, and the last-guardian invariant enforced
-- uniformly on every write path that could break it. The visibility predicate +
-- row-security mirror land in 0005 (they read these tables).
--
-- Implementation notes:
--   * Closed-matter read-only enforcement uses the session flag
--     deedbox.edit_closed = 'on' (set by the operations layer after checking
--     matter.edit_closed), the same pattern as the explicit money-grant flag.
--   * Reopen's mandatory reason is enforced by the reopen operation (which
--     writes the registered event); the schema enforces transition legality.

begin;

------------------------------------------------------------------------------
-- Parties, names, contact points, addresses.
------------------------------------------------------------------------------
create table deedbox.party (
    id bigint generated always as identity primary key,
    kind text not null check (kind in ('person','organisation')),
    display_name text not null,
    primary_phone text,
    primary_email text,
    state text not null default 'active' check (state in ('active','merged')),
    merged_into bigint references deedbox.party(id),
    portal_login text,
    notes text,
    deleted_at timestamptz,
    deleted_by bigint,
    check ((state = 'merged') = (merged_into is not null))
);
grant select, insert, update on deedbox.party to deedbox_app;

create table deedbox.party_name (
    id bigint generated always as identity primary key,
    party bigint not null references deedbox.party(id),
    name_kind text not null check (name_kind in ('current','former','also_known_as','trading')),
    full_name text not null,
    given_names text,
    family_name text,
    org_name text
);
create unique index party_current_name_unique on deedbox.party_name (party) where name_kind = 'current';
grant select, insert, update on deedbox.party_name to deedbox_app;

create or replace function deedbox.party_name_guard() returns trigger
language plpgsql as $$
begin
  if tg_op = 'DELETE' then
    raise exception 'party names are demoted, never deleted';
  end if;
  -- renaming demotes the old current row to former (append, never overwrite):
  -- inserting a new current row demotes any existing current one.
  if tg_op = 'INSERT' and new.name_kind = 'current' then
    update deedbox.party_name set name_kind = 'former'
     where party = new.party and name_kind = 'current';
    update deedbox.party set display_name = new.full_name where id = new.party;
  end if;
  return new;
end $$;
create trigger party_name_guard before insert or delete on deedbox.party_name
for each row execute function deedbox.party_name_guard();

create table deedbox.contact_point (
    id bigint generated always as identity primary key,
    party bigint not null references deedbox.party(id),
    kind text not null check (kind in ('phone','email')),
    value text not null,
    label text,
    is_primary boolean not null default false,
    deleted_at timestamptz,
    deleted_by bigint
);
create unique index contact_point_primary_unique
  on deedbox.contact_point (party, kind) where is_primary and deleted_at is null;
grant select, insert, update on deedbox.contact_point to deedbox_app;

create table deedbox.postal_address (
    id bigint generated always as identity primary key,
    party bigint not null references deedbox.party(id),
    kind text not null default 'postal' check (kind in ('postal','street','billing','other')),
    lines text, locality text, region text, postcode text, country text,
    current boolean not null default true,
    deleted_at timestamptz,
    deleted_by bigint
);
grant select, insert, update on deedbox.postal_address to deedbox_app;

------------------------------------------------------------------------------
-- Practice areas + relatable pairs.
------------------------------------------------------------------------------
create table deedbox.practice_area (
    id bigint generated always as identity primary key,
    name text not null,
    active boolean not null default true,
    require_conflict_resolution boolean not null default false
);
create unique index practice_area_name_unique on deedbox.practice_area (name) where active;
create table deedbox.practice_area_relatable (
    area_a bigint not null references deedbox.practice_area(id),
    area_b bigint not null references deedbox.practice_area(id),
    allowed boolean not null,
    primary key (area_a, area_b)
);
grant select, insert, update on deedbox.practice_area, deedbox.practice_area_relatable to deedbox_app;

------------------------------------------------------------------------------
-- Matter — the hub, with its status machine.
------------------------------------------------------------------------------
create table deedbox.matter (
    id bigint generated always as identity primary key,
    matter_number text not null unique,
    title text not null,
    client_party bigint not null references deedbox.party(id),
    responsible_lawyer bigint not null references deedbox.staff_member(id),
    office bigint not null references deedbox.office(id),
    practice_area bigint not null references deedbox.practice_area(id),
    jurisdiction text,
    status text not null default 'open' check (status in ('open','on_hold','closed','archived')),
    opened_date date not null default current_date,
    closed_date date,
    summary text,
    origin_note text,
    restricted boolean not null default false,
    billing_hold boolean not null default false,
    check ((status in ('closed','archived')) = (closed_date is not null))
);
create index matter_client_idx on deedbox.matter (client_party);
create index matter_lawyer_idx on deedbox.matter (responsible_lawyer);
grant select, insert, update on deedbox.matter to deedbox_app;

create or replace function deedbox.matter_guard() returns trigger
language plpgsql as $$
begin
  if tg_op = 'DELETE' then
    raise exception 'matters are never deleted';
  end if;
  if new.matter_number is distinct from old.matter_number then
    raise exception 'matter_number is immutable';
  end if;
  if new.status is distinct from old.status then
    if not ( (old.status = 'open' and new.status in ('on_hold','closed'))
          or (old.status = 'on_hold' and new.status in ('open','closed'))
          or (old.status = 'closed' and new.status in ('archived','open'))
          or (old.status = 'archived' and new.status = 'open') ) then
      raise exception 'illegal matter status transition % -> %', old.status, new.status;
    end if;
    if old.status in ('closed','archived') and new.status = 'open' then
      new.closed_date := null;   -- reopen; capability + reason enforced by the operation
    end if;
    if new.status in ('closed','archived') and new.closed_date is null then
      new.closed_date := current_date;
    end if;
    if new.status in ('open','on_hold') and old.status in ('open','on_hold') then
      new.closed_date := null;
    end if;
  elsif old.status in ('closed','archived') then
    -- a closed matter is read-only except under the edit-closed ceremony;
    -- the restricted/billing_hold mirrors stay maintainable.
    if coalesce(current_setting('deedbox.edit_closed', true), '') <> 'on'
       and (new.restricted = old.restricted and new.billing_hold = old.billing_hold) then
      raise exception 'a closed matter is read-only without matter.edit_closed';
    end if;
  end if;
  return new;
end $$;
create trigger matter_guard before update or delete on deedbox.matter
for each row execute function deedbox.matter_guard();

------------------------------------------------------------------------------
-- Matter parties.
------------------------------------------------------------------------------
create table deedbox.matter_party (
    id bigint generated always as identity primary key,
    matter bigint not null references deedbox.matter(id),
    party bigint not null references deedbox.party(id),
    capacity bigint not null references deedbox.choice_item(id),
    note text,
    portal_access boolean not null default false,
    deleted_at timestamptz,
    deleted_by bigint
);
create unique index matter_party_unique
  on deedbox.matter_party (matter, party, capacity) where deleted_at is null;
grant select, insert, update on deedbox.matter_party to deedbox_app;

------------------------------------------------------------------------------
-- Restriction rows + the restricted mirror + the last-guardian invariant,
-- enforced uniformly on every write path that could break it.
------------------------------------------------------------------------------
create table deedbox.matter_restriction_grant (
    id bigint generated always as identity primary key,
    matter bigint not null references deedbox.matter(id),
    grantee_kind text not null check (grantee_kind in ('staff','role')),
    grantee bigint not null,
    unique (matter, grantee_kind, grantee)
);
create table deedbox.matter_restriction_block (
    id bigint generated always as identity primary key,
    matter bigint not null references deedbox.matter(id),
    staff bigint not null references deedbox.staff_member(id),
    unique (matter, staff)
);
create index restriction_block_staff_idx on deedbox.matter_restriction_block (staff);
grant select, insert, delete on deedbox.matter_restriction_grant to deedbox_app;
grant select, insert, delete on deedbox.matter_restriction_block to deedbox_app;

create or replace function deedbox.guardian_exists(p_matter bigint)
returns boolean language sql stable as $$
  select exists (
    select 1
      from deedbox.matter_restriction_grant g
      join deedbox.staff_member s
        on (g.grantee_kind = 'staff' and s.id = g.grantee)
        or (g.grantee_kind = 'role'  and s.role = g.grantee)
      join deedbox.role_capability rc
        on rc.role = s.role and rc.capability = 'restriction.manage' and rc.scope <> 'none'
     where g.matter = p_matter
       and s.active
       and not exists (select 1 from deedbox.matter_restriction_block b
                        where b.matter = p_matter and b.staff = s.id));
$$;

-- a_: the restricted mirror (runs before the z_ guardian check alphabetically).
create or replace function deedbox.a_restriction_mirror() returns trigger
language plpgsql as $$
declare m bigint;
begin
  m := coalesce(new.matter, old.matter);
  update deedbox.matter
     set restricted = exists (select 1 from deedbox.matter_restriction_grant g where g.matter = m)
   where id = m;
  return coalesce(new, old);
end $$;
create trigger a_restriction_mirror
after insert or delete on deedbox.matter_restriction_grant
for each row execute function deedbox.a_restriction_mirror();

-- z_: the last-guardian assertion over the FINAL state of the transaction's
-- restriction/staff/role writes.
create or replace function deedbox.z_assert_guardians() returns trigger
language plpgsql as $$
declare bad bigint;
begin
  select g.matter into bad
    from deedbox.matter_restriction_grant g
   group by g.matter
  having not deedbox.guardian_exists(g.matter)
   limit 1;
  if bad is not null then
    raise exception 'refused: matter % would retain no active, unblocked guardian holding restriction.manage', bad;
  end if;
  return null;
end $$;
create constraint trigger z_assert_guardians_grants
after insert or update or delete on deedbox.matter_restriction_grant
deferrable initially immediate for each row execute function deedbox.z_assert_guardians();
create constraint trigger z_assert_guardians_blocks
after insert or update or delete on deedbox.matter_restriction_block
deferrable initially immediate for each row execute function deedbox.z_assert_guardians();
create constraint trigger z_assert_guardians_staff
after update on deedbox.staff_member
deferrable initially immediate for each row execute function deedbox.z_assert_guardians();
create constraint trigger z_assert_guardians_role
after update on deedbox.role
deferrable initially immediate for each row execute function deedbox.z_assert_guardians();
create constraint trigger z_assert_guardians_role_caps
after update or delete on deedbox.role_capability
deferrable initially immediate for each row execute function deedbox.z_assert_guardians();

commit;
