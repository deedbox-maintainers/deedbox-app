-- Tests for 0043_matter_prior_reference. Run as deployment role AFTER the
-- full chain. Proves the column stores at birth, accepts exactly one
-- back-fill when born empty, and then never moves again — a prior-system
-- reference is provenance, not an opinion.

begin;

grant deedbox_app to current_user;

insert into deedbox.country_pack (code, name) values ('XPR','Prior Ref Test Pack');
insert into deedbox.firm (name, operating_currency, timezone, country_pack)
  select 'Prior Ref Test Firm','AUD','Australia/Sydney', id
    from deedbox.country_pack where code='XPR';
insert into deedbox.office (name, code) values ('PR Office','XPR1');

do $$
declare
  off bigint; rl bigint; st bigint; pa bigint; p1 bigint; m1 bigint; m2 bigint; num text;
begin
  select id into off from deedbox.office where code = 'XPR1';
  select id into rl from deedbox.role where system_key = 'administrator';
  insert into deedbox.staff_member (person_name, login, role, office, email)
    values ('{"given":"Priya","family":"Reference"}','priya.xpr', rl, off,
            'priya.xpr@example.test')
    returning id into st;
  insert into deedbox.practice_area (name) values ('PR General') returning id into pa;
  insert into deedbox.party (kind, display_name) values ('person','PR Client') returning id into p1;
  insert into deedbox.party_name (party, name_kind, full_name) values (p1,'current','PR Client');

  -- T1 born with the reference: stored exactly as given
  num := deedbox.allocate_number('matter', null, current_date);
  insert into deedbox.matter (matter_number, title, client_party, responsible_lawyer,
                              office, practice_area, prior_reference)
    values (num, 'PR matter one', p1, st, off, pa, '11363') returning id into m1;
  perform 1 from deedbox.matter where id = m1 and prior_reference = '11363';
  if not found then
    raise exception 'T1 FAILED: the reference was not stored at insert';
  end if;

  -- T2 born without one, back-filled once — the import path's own shape
  num := deedbox.allocate_number('matter', null, current_date);
  insert into deedbox.matter (matter_number, title, client_party, responsible_lawyer,
                              office, practice_area)
    values (num, 'PR matter two', p1, st, off, pa) returning id into m2;
  update deedbox.matter set prior_reference = 'ARCH-2022/0042' where id = m2;
  perform 1 from deedbox.matter where id = m2 and prior_reference = 'ARCH-2022/0042';
  if not found then
    raise exception 'T2 FAILED: a null reference did not accept its one write';
  end if;

  -- T3 immutable once set: a change refuses with the guard's own words
  begin
    update deedbox.matter set prior_reference = 'SOMETHING-ELSE' where id = m1;
    raise exception 'T3 FAILED: a set reference accepted a change';
  exception when others then
    if sqlerrm not like '%immutable once set%' then raise; end if;
  end;

  -- T4 immutability includes erasure
  begin
    update deedbox.matter set prior_reference = null where id = m1;
    raise exception 'T4 FAILED: a set reference accepted erasure';
  exception when others then
    if sqlerrm not like '%immutable once set%' then raise; end if;
  end;

  -- T5 unrelated updates leave it standing
  update deedbox.matter set summary = 'PR summary text' where id = m1;
  perform 1 from deedbox.matter where id = m1 and prior_reference = '11363';
  if not found then
    raise exception 'T5 FAILED: an unrelated update disturbed the reference';
  end if;

  -- T6 the bounds check: an empty reference refuses at insert
  begin
    num := deedbox.allocate_number('matter', null, current_date);
    insert into deedbox.matter (matter_number, title, client_party, responsible_lawyer,
                                office, practice_area, prior_reference)
      values (num, 'PR matter three', p1, st, off, pa, '');
    raise exception 'T6 FAILED: an empty reference was accepted';
  exception when others then
    if sqlerrm not like '%violates check constraint%' then raise; end if;
  end;
end $$;

rollback;
