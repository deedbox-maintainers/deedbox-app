-- 0054: the office visibility wall gains its administrator carve-out.
--
-- The visibility policy (0005) offers three scopes for unrestricted matters:
-- all_staff, office, assignment. A multi-office firm whose offices are
-- separate practices (consultant firms under one roof) needs 'office' — but
-- as shipped, 'office' walled EVERYONE, including the practice managers and
-- accounts staff whose work is firm-wide. The rule such a firm actually
-- needs: administrators and accounts see the firm; everyone else sees
-- their own office. That rule is now expressible:
--
--   matter.see_all_offices — a holder sees every UNRESTRICTED matter
--   regardless of the firm's visibility scope. Shipped to administrator and
--   accounts. Restriction grants and person blocks are UNTOUCHED: a
--   restricted matter still needs its named grant, and a block still defeats
--   everything, capability included.

begin;

insert into deedbox.capability (key, description, grantable_to_firm_roles) values
  ('matter.see_all_offices',
   'See every unrestricted matter regardless of the firm''s office/assignment visibility scope.',
   true);

insert into deedbox.role_capability (role, capability)
  select id, 'matter.see_all_offices' from deedbox.role
   where system_key in ('administrator', 'accounts');

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
  --    every grant, role membership, capability and administrator status.
  if exists (select 1 from deedbox.matter_restriction_block b
              where b.matter = p_matter and b.staff = p_principal) then
    return false;
  end if;

  -- 2. Restriction: an active grant naming the staff member or their role.
  --    see_all_offices does NOT reach past a restriction.
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
  end if;

  -- the firm-wide carve-out (0054): practice management sees past the wall
  if exists (select 1 from deedbox.role_capability rc
              where rc.role = s.role
                and rc.capability = 'matter.see_all_offices'
                and rc.scope <> 'none') then
    return true;
  end if;

  if scope = 'office' then
    return m.office = s.office;
  elsif scope = 'assignment' then
    return m.responsible_lawyer = p_principal
        or exists (select 1 from deedbox.matter_staffing st
                    where st.matter = p_matter and st.staff = p_principal and st.to_at is null);
  end if;
  return false;
end $$;

commit;
