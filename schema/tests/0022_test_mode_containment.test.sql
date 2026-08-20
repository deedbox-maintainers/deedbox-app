-- Tests for 0022_test_mode_containment. Run as deployment role AFTER
-- 0001–0022. Proves: test parties and test intakes stay out of the corpus,
-- the search index and the duplicate-candidates dialog while identical
-- non-test rows appear in all three (the control), test custom values stay
-- out of search, and the test flag is immutable.

begin;

grant deedbox_app to current_user;

insert into deedbox.country_pack (code, name) values ('XTC','Containment Test Pack');
insert into deedbox.firm (name, operating_currency, timezone, country_pack)
  select 'Containment Test Firm','AUD','Australia/Sydney', id from deedbox.country_pack where code='XTC';

do $$
declare real_p bigint; test_p bigint; real_i bigint; test_i bigint;
        cfd bigint; n int; ok boolean;
begin
  ------------------------------------------------------------------
  -- 1. A real party and a test twin, same name/phone, notes on both.
  ------------------------------------------------------------------
  insert into deedbox.party (kind, display_name, notes)
    values ('person','Quentin Containment','real-party-note-quentin')
    returning id into real_p;
  insert into deedbox.party_name (party, name_kind, full_name)
    values (real_p, 'current', 'Quentin Containment');
  insert into deedbox.contact_point (party, kind, value, is_primary)
    values (real_p, 'phone', '0400111222', true);

  insert into deedbox.party (kind, display_name, notes, test)
    values ('person','Quentin Containment','test-party-note-quentin', true)
    returning id into test_p;
  insert into deedbox.party_name (party, name_kind, full_name)
    values (test_p, 'current', 'Quentin Containment');
  insert into deedbox.contact_point (party, kind, value, is_primary)
    values (test_p, 'phone', '0400111222', true);

  -- corpus: the real note is registered, the test note is not
  select count(*) into n from deedbox.registered_text
   where source_type = 'party_note' and source_ref = real_p::text and superseded_at is null;
  if n <> 1 then raise exception 'T1 FAIL: real party note missing from corpus'; end if;
  select count(*) into n from deedbox.registered_text
   where source_type = 'party_note' and source_ref = test_p::text;
  if n <> 0 then raise exception 'T1 FAIL: test party note entered the corpus'; end if;

  -- search index: the real name row indexed, the test name row absent
  select count(*) into n from deedbox.search_index si
   join deedbox.party_name pn on pn.id = si.source and si.entry_type = 'party'
   where pn.party = real_p;
  if n < 1 then raise exception 'T2 FAIL: real party name missing from search'; end if;
  select count(*) into n from deedbox.search_index si
   join deedbox.party_name pn on pn.id = si.source and si.entry_type = 'party'
   where pn.party = test_p;
  if n <> 0 then raise exception 'T2 FAIL: test party name entered search'; end if;

  -- duplicate candidates: the dialog sees the real twin only
  select exists (select 1 from deedbox.duplicate_candidates('Quentin Containment','0400111222',null) dc
                  where dc.party = real_p) into ok;
  if not ok then raise exception 'T3 FAIL: real party missing from candidates'; end if;
  select exists (select 1 from deedbox.duplicate_candidates('Quentin Containment','0400111222',null) dc
                  where dc.party = test_p) into ok;
  if ok then raise exception 'T3 FAIL: test party surfaced as a candidate'; end if;

  ------------------------------------------------------------------
  -- 2. A real intake and a test intake: about-text containment.
  ------------------------------------------------------------------
  insert into deedbox.intake_record (prospect_party, contact_phone, about)
    values (real_p, '0400111222', 'real enquiry about a fence dispute')
    returning id into real_i;
  insert into deedbox.intake_record (prospect_party, contact_phone, about, test_flag)
    values (test_p, '0400111222', 'test enquiry about a fence dispute', true)
    returning id into test_i;

  select count(*) into n from deedbox.registered_text
   where source_type = 'intake_about' and source_ref = real_i::text and superseded_at is null;
  if n <> 1 then raise exception 'T4 FAIL: real intake about missing from corpus'; end if;
  select count(*) into n from deedbox.registered_text
   where source_type = 'intake_about' and source_ref = test_i::text;
  if n <> 0 then raise exception 'T4 FAIL: test intake about entered the corpus'; end if;

  ------------------------------------------------------------------
  -- 3. Custom values on the test intake stay out of search.
  ------------------------------------------------------------------
  insert into deedbox.custom_field_definition (scope, key, label, data_type)
    values ('intake', 'xtc_referrer', 'Referrer', 'text') returning id into cfd;
  insert into deedbox.custom_field_value (definition, owner_type, owner, text_value)
    values (cfd, 'intake_record', real_i, 'xtc-real-referrer-value');
  insert into deedbox.custom_field_value (definition, owner_type, owner, text_value)
    values (cfd, 'intake_record', test_i, 'xtc-test-referrer-value');

  select count(*) into n from deedbox.search_index
   where entry_type = 'custom_field_value' and body like '%xtc-real-referrer%';
  if n <> 1 then raise exception 'T5 FAIL: real custom value missing from search'; end if;
  select count(*) into n from deedbox.search_index
   where entry_type = 'custom_field_value' and body like '%xtc-test-referrer%';
  if n <> 0 then raise exception 'T5 FAIL: test custom value entered search'; end if;

  ------------------------------------------------------------------
  -- 4. The test flag is immutable, both directions.
  ------------------------------------------------------------------
  begin
    update deedbox.party set test = false where id = test_p;
    raise exception 'T6 FAIL: test -> business flip was allowed';
  exception when others then
    if sqlerrm like '%T6 FAIL%' then raise; end if;
  end;
  begin
    update deedbox.party set test = true where id = real_p;
    raise exception 'T6 FAIL: business -> test flip was allowed';
  exception when others then
    if sqlerrm like '%T6 FAIL%' then raise; end if;
  end;

  raise notice '0022 containment suite: all assertions passed';
end $$;

rollback;
