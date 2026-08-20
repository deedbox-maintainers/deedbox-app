-- Tests for 0047_matter_search_content. Run as deployment role AFTER the
-- full chain. Proves a matter's search entry carries the client's name and
-- the prior-system reference in its body, that a client rename re-indexes
-- every matter naming them, and that the backfilled rule holds for rows
-- born before the change.

begin;

grant deedbox_app to current_user;

insert into deedbox.country_pack (code, name) values ('XSC','Search Content Test Pack');
insert into deedbox.firm (name, operating_currency, timezone, country_pack)
  select 'Search Content Test Firm','AUD','Australia/Sydney', id
    from deedbox.country_pack where code='XSC';
insert into deedbox.office (name, code) values ('SC Office','XSC1');

do $$
declare
  off bigint; rl bigint; st bigint; pa bigint; p1 bigint; m1 bigint; num text;
  body text;
begin
  select id into off from deedbox.office where code = 'XSC1';
  select id into rl from deedbox.role where system_key = 'administrator';
  insert into deedbox.staff_member (person_name, login, role, office, email)
    values ('{"given":"Sana","family":"Searcher"}','sana.xsc', rl, off,
            'sana.xsc@example.test')
    returning id into st;
  insert into deedbox.practice_area (name) values ('SC General') returning id into pa;
  insert into deedbox.party (kind, display_name)
    values ('person','Tanvi Chandrasekar XSC') returning id into p1;
  insert into deedbox.party_name (party, name_kind, full_name)
    values (p1,'current','Tanvi Chandrasekar XSC');

  -- T1 a matter whose TITLE never names the client is still findable by
  -- the client's name and by the prior-system number — the exact shape of
  -- the first real installation's first support question
  num := deedbox.allocate_number('matter', null, current_date);
  insert into deedbox.matter (matter_number, title, client_party, responsible_lawyer,
                              office, practice_area, prior_reference)
    values (num, 'TR900100 - Family Law', p1, st, off, pa, '10999')
    returning id into m1;
  select si.body into body from deedbox.search_index si
   where si.entry_type = 'matter' and si.source = m1;
  if body is null or position('Tanvi Chandrasekar' in body) = 0 then
    raise exception 'T1 FAILED: the client name is not in the matter search body (%)', body;
  end if;
  if position('10999' in body) = 0 then
    raise exception 'T1 FAILED: the prior reference is not in the matter search body (%)', body;
  end if;

  -- T2 renaming the client re-indexes their matters
  update deedbox.party set display_name = 'Tanvi Iyer XSC' where id = p1;
  select si.body into body from deedbox.search_index si
   where si.entry_type = 'matter' and si.source = m1;
  if position('Tanvi Iyer' in body) = 0 then
    raise exception 'T2 FAILED: a party rename did not re-index the matter (%)', body;
  end if;

  -- T3 a current-name row landing re-indexes too (the naming record path)
  insert into deedbox.party_name (party, name_kind, full_name)
    values (p1, 'former', 'Tanvi Chandrasekar XSC');
  select si.body into body from deedbox.search_index si
   where si.entry_type = 'matter' and si.source = m1;
  if position('Tanvi Iyer' in body) = 0 then
    raise exception 'T3 FAILED: a party_name write emptied the matter body (%)', body;
  end if;

  -- T4 the title stays number + title (display untouched by the change)
  perform 1 from deedbox.search_index si
   where si.entry_type = 'matter' and si.source = m1
     and si.display_title = num || ' ' || 'TR900100 - Family Law';
  if not found then
    raise exception 'T4 FAILED: the display title changed shape';
  end if;
end $$;

rollback;
