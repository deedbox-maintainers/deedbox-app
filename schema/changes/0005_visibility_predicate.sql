-- 0005_visibility_predicate — the single visibility predicate and its
-- row-security mirror on matter, plus matter_staffing, which the
-- predicate's assignment scope reads.
--
-- Mechanics:
--   * The operations layer sets per-request context: deedbox.principal_kind
--     ('staff' | 'portal_client' | 'system_job' | 'integration_key' |
--     'examiner') and deedbox.principal_id. Absent context FAILS CLOSED.
--   * matter_visible() is security definer so the policy's own reads bypass
--     row security (breaking recursion); the policy applies to deedbox_app.
--   * The deployment role owns the tables and is not subject to the policy;
--     the running product never uses it.

begin;

------------------------------------------------------------------------------
-- matter_staffing (assignment-scope input; the write operation and its
-- re-resolution hook arrive with the workflow slices).
------------------------------------------------------------------------------
create table deedbox.matter_staffing (
    id bigint generated always as identity primary key,
    matter bigint not null references deedbox.matter(id),
    staff bigint not null references deedbox.staff_member(id),
    role_on_matter text not null check (role_on_matter in ('responsible_lawyer','assisting')),
    from_at timestamptz not null default now(),
    to_at timestamptz
);
create unique index matter_staffing_one_responsible
  on deedbox.matter_staffing (matter) where role_on_matter = 'responsible_lawyer' and to_at is null;
create index matter_staffing_staff_idx on deedbox.matter_staffing (staff) where to_at is null;
grant select, insert, update on deedbox.matter_staffing to deedbox_app;

------------------------------------------------------------------------------
-- The single predicate. Blocks first; restriction; firm policy; portal rule.
------------------------------------------------------------------------------
create or replace function deedbox.matter_visible(p_kind text, p_principal bigint, p_matter bigint)
returns boolean
security definer set search_path = deedbox, pg_temp
language plpgsql stable as $$
declare
  m deedbox.matter%rowtype;
  s deedbox.staff_member%rowtype;
  scope text;
begin
  if p_kind is null or p_principal is null or p_matter is null then
    return false;                                   -- fail closed
  end if;
  select * into m from deedbox.matter where id = p_matter;
  if not found then return false; end if;

  if p_kind = 'system_job' then
    return true;                                    -- named jobs run firm-wide
  end if;

  if p_kind = 'portal_client' then
    if m.restricted then return false; end if;      -- never restricted matters
    return exists (
      select 1 from deedbox.matter_party mp
       where mp.matter = p_matter and mp.party = p_principal
         and mp.portal_access and mp.deleted_at is null);
  end if;

  if p_kind <> 'staff' then
    return false;                                   -- examiners and keys read no matters
  end if;

  select * into s from deedbox.staff_member where id = p_principal;
  if not found or not s.active then return false; end if;

  -- 1. Blocks first: on restricted and unrestricted matters alike, defeating
  --    every grant, role membership and administrator status.
  if exists (select 1 from deedbox.matter_restriction_block b
              where b.matter = p_matter and b.staff = p_principal) then
    return false;
  end if;

  -- 2. Restriction: an active grant naming the staff member or their role.
  if m.restricted then
    return exists (
      select 1 from deedbox.matter_restriction_grant g
       where g.matter = p_matter
         and ((g.grantee_kind = 'staff' and g.grantee = p_principal)
           or (g.grantee_kind = 'role'  and g.grantee = s.role)));
  end if;

  -- 3. Firm policy for unrestricted matters.
  scope := coalesce(deedbox.current_setting_value('visibility.staff_scope') #>> '{}', 'all_staff');
  if scope = 'all_staff' then
    return true;
  elsif scope = 'office' then
    return m.office = s.office;
  elsif scope = 'assignment' then
    return m.responsible_lawyer = p_principal
        or exists (select 1 from deedbox.matter_staffing st
                    where st.matter = p_matter and st.staff = p_principal and st.to_at is null);
  end if;
  return false;
end $$;
grant execute on function deedbox.matter_visible(text, bigint, bigint) to deedbox_app;

-- Convenience: the current request principal's verdict on a matter.
create or replace function deedbox.visible(p_matter bigint)
returns boolean language sql stable as $$
  select deedbox.matter_visible(
    current_setting('deedbox.principal_kind', true),
    nullif(current_setting('deedbox.principal_id', true), '')::bigint,
    p_matter);
$$;
grant execute on function deedbox.visible(bigint) to deedbox_app;

------------------------------------------------------------------------------
-- The row-security mirror: even a raw query path obeys the predicate.
------------------------------------------------------------------------------
alter table deedbox.matter enable row level security;

create policy matter_visibility on deedbox.matter
  for select to deedbox_app
  using (deedbox.visible(id));

-- Writes remain governed by grants + the operations layer's checks; the
-- select policy is the invisibility guarantee. Insert/update rows must still
-- satisfy the select policy to be returned.
create policy matter_write on deedbox.matter
  for insert to deedbox_app with check (true);
create policy matter_update on deedbox.matter
  for update to deedbox_app using (deedbox.visible(id));

commit;
