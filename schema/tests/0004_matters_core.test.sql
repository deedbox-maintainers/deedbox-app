-- Tests for 0004_matters_core. Run as deployment role AFTER 0001–0004.

begin;

insert into deedbox.country_pack (code, name) values ('AU-NSW','Australia (NSW)');
insert into deedbox.pack_version (pack, version) select id, '0.0.1' from deedbox.country_pack;
update deedbox.country_pack cp set active_version = pv.id from deedbox.pack_version pv where pv.pack = cp.id;
insert into deedbox.firm (name, operating_currency, timezone, country_pack)
  select 'Test Firm','AUD','Australia/Sydney', id from deedbox.country_pack;
insert into deedbox.office (name, code) values ('Sydney','SYD');

do $$
declare o bigint; r_admin bigint; r_lawyer bigint; s_admin bigint; s_law bigint;
        p1 bigint; pa bigint; m bigint; g bigint; num text;
begin
  select id into o from deedbox.office limit 1;
  select id into r_admin from deedbox.role where system_key='administrator';
  select id into r_lawyer from deedbox.role where system_key='lawyer';
  insert into deedbox.staff_member (person_name, login, role, office, email)
    values ('{"display":"Ada Admin"}','ada', r_admin, o, 'ada@x.test') returning id into s_admin;
  insert into deedbox.staff_member (person_name, login, role, office, email)
    values ('{"display":"Lee Lawyer"}','lee', r_lawyer, o, 'lee@x.test') returning id into s_law;

  -- 1. Party names: one current; renaming demotes, display follows.
  insert into deedbox.party (kind, display_name) values ('person','placeholder') returning id into p1;
  insert into deedbox.party_name (party, name_kind, full_name) values (p1,'current','Jo Client');
  insert into deedbox.party_name (party, name_kind, full_name) values (p1,'current','Jo Client-Smith');
  if (select count(*) from deedbox.party_name where party=p1 and name_kind='current') <> 1 then
    raise exception 'P1 more than one current name';
  end if;
  if (select display_name from deedbox.party where id=p1) <> 'Jo Client-Smith' then
    raise exception 'P2 display name did not follow the current name';
  end if;
  if (select count(*) from deedbox.party_name where party=p1 and name_kind='former') <> 1 then
    raise exception 'P3 old current was not demoted to former';
  end if;

  -- 2. Matter creation draws a gapless number; status machine enforced.
  insert into deedbox.practice_area (name) values ('Litigation') returning id into pa;
  num := deedbox.allocate_number('matter', null, current_date);
  insert into deedbox.matter (matter_number, title, client_party, responsible_lawyer, office, practice_area)
    values (num, 'Test matter', p1, s_law, o, pa) returning id into m;
  begin
    update deedbox.matter set status='archived' where id = m;   -- open -> archived is illegal
    raise exception 'illegal transition accepted';
  exception when others then
    if sqlerrm not like '%illegal matter status transition%' then raise; end if;
  end;
  -- since 0006 a close carries its approved close request (born approved here).
  insert into deedbox.matter_close_request (matter, requested_by, financial_position, condition_evaluation, state, decided_by, decided_at)
    values (m, s_admin, '{}', '{}', 'approved', s_admin, now());
  update deedbox.matter set status='closed' where id = m;
  if (select closed_date from deedbox.matter where id = m) is null then
    raise exception 'closed_date not stamped';
  end if;

  -- 3. Closed matters are read-only without the edit-closed ceremony.
  begin
    update deedbox.matter set summary='late edit' where id = m;
    raise exception 'closed matter edited without ceremony';
  exception when others then
    if sqlerrm not like '%read-only without matter.edit_closed%' then raise; end if;
  end;
  perform set_config('deedbox.edit_closed','on', true);
  update deedbox.matter set summary='sanctioned late edit' where id = m;
  perform set_config('deedbox.edit_closed','off', true);
  update deedbox.matter set status='open' where id = m;   -- reopen path (closed -> open)
  if (select closed_date from deedbox.matter where id = m) is not null then
    raise exception 'reopen left closed_date set';
  end if;

  -- 4. Restriction: first grant must include guardian coverage.
  begin
    insert into deedbox.matter_restriction_grant (matter, grantee_kind, grantee)
      values (m, 'staff', s_law);   -- lawyer role holds no restriction.manage
    raise exception 'restriction created with no guardian';
  exception when others then
    if sqlerrm not like '%no active, unblocked guardian%' then raise; end if;
  end;
  insert into deedbox.matter_restriction_grant (matter, grantee_kind, grantee)
    values (m, 'staff', s_admin) returning id into g;
  if not (select restricted from deedbox.matter where id = m) then
    raise exception 'restricted mirror not set';
  end if;
  insert into deedbox.matter_restriction_grant (matter, grantee_kind, grantee)
    values (m, 'staff', s_law);   -- fine once a guardian exists

  -- 5. Blocking the sole guardian is refused; blocking a non-guardian is fine.
  begin
    insert into deedbox.matter_restriction_block (matter, staff) values (m, s_admin);
    raise exception 'sole guardian blocked';
  exception when others then
    if sqlerrm not like '%no active, unblocked guardian%' then raise; end if;
  end;
  insert into deedbox.matter_restriction_block (matter, staff) values (m, s_law);

  -- 6. Removing the last guardian grant is refused; lifting entirely is fine.
  begin
    delete from deedbox.matter_restriction_grant where id = g;
    raise exception 'last guardian grant removed';
  exception when others then
    if sqlerrm not like '%no active, unblocked guardian%' then raise; end if;
  end;
  delete from deedbox.matter_restriction_grant where matter = m;   -- the lift: all grants at once
  if (select restricted from deedbox.matter where id = m) then
    raise exception 'lift did not clear the restricted mirror';
  end if;

  -- 7. Staff deactivation that would strand a restricted matter is refused.
  insert into deedbox.matter_restriction_grant (matter, grantee_kind, grantee)
    values (m, 'staff', s_admin);
  insert into deedbox.staff_member (person_name, login, role, office, email)
    values ('{"display":"Zoe Admin"}','zoe', r_admin, o, 'zoe@x.test');
  begin
    update deedbox.staff_member set active = false where id = s_admin;
    raise exception 'guardian deactivated leaving the matter stranded';
  exception when others then
    if sqlerrm not like '%no active, unblocked guardian%' then raise; end if;
  end;

  raise notice 'ALL 0004 MATTERS-CORE TESTS PASSED';
end $$;

rollback;
