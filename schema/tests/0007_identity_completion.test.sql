-- Tests for 0007_identity_completion. Run as deployment role AFTER 0001–0007.

begin;

insert into deedbox.country_pack (code, name) values ('AU-NSW','Australia (NSW)');
insert into deedbox.pack_version (pack, version) select id, '0.0.1' from deedbox.country_pack;
update deedbox.country_pack cp set active_version = pv.id from deedbox.pack_version pv where pv.pack = cp.id;
insert into deedbox.firm (name, operating_currency, timezone, country_pack)
  select 'Test Firm','AUD','Australia/Sydney', id from deedbox.country_pack;
insert into deedbox.office (name, code) values ('Sydney','SYD');

do $$
declare o bigint; r_admin bigint; s_admin bigint;
        p1 bigint; p2 bigint; p3 bigint; lk bigint; dd bigint; bo bigint; pm bigint;
        cc bigint; cnt int; k text; pa bigint; m1 bigint; s_law bigint; r_lawyer bigint;
begin
  select id into o from deedbox.office limit 1;
  select id into r_admin from deedbox.role where system_key='administrator';
  select id into r_lawyer from deedbox.role where system_key='lawyer';
  insert into deedbox.staff_member (person_name, login, role, office, email)
    values ('{"display":"Ada Admin"}','ada', r_admin, o, 'ada@x.test') returning id into s_admin;
  insert into deedbox.staff_member (person_name, login, role, office, email)
    values ('{"display":"Lee Lawyer"}','lee', r_lawyer, o, 'lee@x.test') returning id into s_law;

  ------------------------------------------------------------------
  -- 1. Normalisation: folding, phonetics, phones, emails.
  ------------------------------------------------------------------
  if deedbox.fold_name('  José  O''Brien-Smythe ') <> deedbox.fold_name('obrien smythe JOSE') then
    raise exception 'folding is not order/case/diacritic/punctuation stable';
  end if;
  if deedbox.fold_phone('(04) 0000-0000') <> '0400000000' then
    raise exception 'phone folding wrong: %', deedbox.fold_phone('(04) 0000-0000');
  end if;
  if deedbox.fold_email('  Jo@Example.COM ') <> 'jo@example.com' then
    raise exception 'email folding wrong';
  end if;
  if deedbox.phonetic_name('Smith') <> deedbox.phonetic_name('Smyth') then
    raise exception 'phonetic folding missed a likely misspelling';
  end if;

  ------------------------------------------------------------------
  -- 2. Match keys: one row per name of every kind + a contact row;
  --    rebuilt on renames and contact changes.
  ------------------------------------------------------------------
  insert into deedbox.party (kind, display_name, primary_phone, primary_email)
    values ('person','placeholder','0400 123 456','First@Example.com') returning id into p1;
  insert into deedbox.party_name (party, name_kind, full_name) values (p1,'current','Jo Client');
  insert into deedbox.party_name (party, name_kind, full_name) values (p1,'trading','Jo''s Conveyancing');
  select count(*) into cnt from deedbox.party_match_key mk where mk.party = p1 and mk.name_key is not null;
  if cnt <> 2 then
    raise exception 'MK1 expected a name key per name kind, found %', cnt;
  end if;
  select mk.phone_key into k from deedbox.party_match_key mk where mk.party = p1 and mk.name_key is null;
  if k <> '0400123456' then
    raise exception 'MK2 contact key not normalised: %', k;
  end if;

  -- a rename keeps the old name findable (former row keeps its key).
  insert into deedbox.party_name (party, name_kind, full_name) values (p1,'current','Jo Client-Smith');
  select count(*) into cnt from deedbox.party_match_key mk
   where mk.party = p1 and mk.name_key = deedbox.fold_name('Jo Client');
  if cnt <> 1 then
    raise exception 'MK3 former name lost its match key';
  end if;

  -- a contact-point primary change flows: contact row -> party mirror -> key.
  insert into deedbox.contact_point (party, kind, value, is_primary) values (p1,'phone','0499 999 999', false);
  update deedbox.contact_point set is_primary = true where party = p1 and value = '0499 999 999';
  if (select primary_phone from deedbox.party where id = p1) <> '0499 999 999' then
    raise exception 'MK4 party mirror did not follow the primary contact point';
  end if;
  if not exists (select 1 from deedbox.party_match_key mk
                  where mk.party = p1 and mk.phone_key = '0499999999') then
    raise exception 'MK5 contact key not rebuilt from the new primary';
  end if;

  ------------------------------------------------------------------
  -- 3. Duplicate candidates: fuzzy name AND contact; name-only is
  --    exact-normalised only.
  ------------------------------------------------------------------
  if not exists (select * from deedbox.duplicate_candidates('Jo Cleint-Smith', '0499999999', null) c where c.party = p1) then
    raise exception 'misspelt name + matching phone missed the candidate';
  end if;
  if exists (select * from deedbox.duplicate_candidates('Jo Cleint-Smith', '0400000001', 'other@x.test') c where c.party = p1) then
    raise exception 'candidate offered without any contact match';
  end if;
  if not exists (select * from deedbox.duplicate_candidates('client-smith jo', null, null) c where c.party = p1) then
    raise exception 'exact-normalised name-only entry missed';
  end if;
  if exists (select * from deedbox.duplicate_candidates('Jo Cleint-Smith', null, null) c where c.party = p1) then
    raise exception 'name-only entry fuzzy-swept';
  end if;

  ------------------------------------------------------------------
  -- 4. Party links: no self-links, no merged ends, unique live triple,
  --    never re-aimed.
  ------------------------------------------------------------------
  insert into deedbox.party (kind, display_name) values ('organisation','Acme Pty Ltd') returning id into p2;
  insert into deedbox.party_name (party, name_kind, full_name, org_name) values (p2,'current','Acme Pty Ltd','Acme Pty Ltd');
  select ci.id into lk from deedbox.choice_item ci join deedbox.choice_list cl on cl.id=ci.list
   where cl.purpose_key='party_link_kinds' and ci.shipped_key='employee';
  begin
    insert into deedbox.party_link (from_party, to_party, link_kind) values (p1, p1, lk);
    raise exception 'self-link accepted';
  exception when others then
    if sqlerrm not like '%check%' then raise; end if;
  end;
  insert into deedbox.party_link (from_party, to_party, link_kind) values (p1, p2, lk);
  begin
    insert into deedbox.party_link (from_party, to_party, link_kind) values (p1, p2, lk);
    raise exception 'duplicate live link accepted';
  exception when others then
    if sqlerrm not like '%party_link_unique%' and sqlerrm not like '%duplicate key%' then raise; end if;
  end;
  begin
    update deedbox.party_link set to_party = p1 where from_party = p1 and to_party = p2;
    raise exception 'link re-aimed';
  exception when others then
    if sqlerrm not like '%never re-aims%' then raise; end if;
  end;

  ------------------------------------------------------------------
  -- 5. Party state discipline: merge pointers sound; soft-delete only
  --    when wholly unlinked; a linked party refuses.
  ------------------------------------------------------------------
  insert into deedbox.party (kind, display_name) values ('person','Loose End') returning id into p3;
  insert into deedbox.party_name (party, name_kind, full_name) values (p3,'current','Loose End');
  begin
    update deedbox.party set state='merged', merged_into=p3 where id = p3;
    raise exception 'party merged into itself';
  exception when others then
    if sqlerrm not like '%merge into itself%' then raise; end if;
  end;
  begin
    update deedbox.party set deleted_at = now() where id = p1;   -- p1 is linked (party_link)
    raise exception 'linked party soft-deleted';
  exception when others then
    if sqlerrm not like '%wholly unlinked%' then raise; end if;
  end;
  update deedbox.party set deleted_at = now(), deleted_by = s_admin where id = p3;  -- truly unlinked

  -- merged party cannot be a link end.
  update deedbox.party set deleted_at = null, deleted_by = null where id = p3;
  update deedbox.party set state='merged', merged_into=p1 where id = p3;
  begin
    insert into deedbox.party_link (from_party, to_party, link_kind) values (p3, p2, lk);
    raise exception 'merged party linked';
  exception when others then
    if sqlerrm not like '%merged party cannot be linked%' then raise; end if;
  end;
  -- and its keys re-aimed at the survivor: a search for the absorbed
  -- name resolves to the active end of the chain.
  if not exists (select 1 from deedbox.party_match_key mk
                  where mk.party = p1 and mk.name_key = deedbox.fold_name('Loose End')) then
    raise exception 'absorbed name does not resolve to the survivor';
  end if;
  begin
    update deedbox.party set state='merged', merged_into=p3 where id = p2;  -- target is merged
    raise exception 'merged_into accepted a merged target';
  exception when others then
    if sqlerrm not like '%active party%' then raise; end if;
  end;

  ------------------------------------------------------------------
  -- 6. Duplicate decisions: born unreviewed; interactive rows terminal;
  --    deferred rows take exactly one review transition.
  ------------------------------------------------------------------
  insert into deedbox.duplicate_decision (created_entity_type, created_entity, candidates_shown, decision_mode, decided_by_kind, decided_by)
    values ('party', p2, '[{"party":1}]', 'integration_deferred', 'integration_key', 1) returning id into dd;
  if not exists (select 1 from deedbox.duplicate_decision d
                  where d.id = dd and d.reviewed_at is null and not d.test) then
    raise exception 'deferred decision missing from the review queue shape';
  end if;
  update deedbox.duplicate_decision set reviewed_by = s_admin, reviewed_at = now() where id = dd;
  begin
    update deedbox.duplicate_decision set reviewed_by = s_law where id = dd;
    raise exception 'reviewed decision mutated';
  exception when others then
    if sqlerrm not like '%immutable%' then raise; end if;
  end;
  insert into deedbox.duplicate_decision (created_entity_type, created_entity, candidates_shown, decided_by_kind, decided_by)
    values ('party', p2, '[]', 'staff', s_admin) returning id into dd;
  begin
    update deedbox.duplicate_decision set reviewed_by = s_admin, reviewed_at = now() where id = dd;
    raise exception 'interactive decision took a review transition';
  exception when others then
    if sqlerrm not like '%born terminal%' then raise; end if;
  end;
  begin
    delete from deedbox.duplicate_decision where id = dd;
    raise exception 'duplicate decision deleted';
  exception when others then
    if sqlerrm not like '%never deleted%' then raise; end if;
  end;

  ------------------------------------------------------------------
  -- 7. Bulk operations + the merge record: transition discipline.
  ------------------------------------------------------------------
  insert into deedbox.bulk_operation (operation_kind, dry_run_summary, reversible_until)
    values ('party_merge', '{"rows":1}', now() + interval '7 days') returning id into bo;
  begin
    update deedbox.bulk_operation set reversed_at = now(), reversed_by = s_admin where id = bo;
    raise exception 'uncommitted bulk operation reversed';
  exception when others then
    if sqlerrm not like '%only a committed bulk operation%' then raise; end if;
  end;
  update deedbox.bulk_operation set committed_at = now(), committed_by = s_admin where id = bo;
  begin
    update deedbox.bulk_operation set dry_run_summary = '{"rows":2}' where id = bo;
    raise exception 'bulk dry-run summary rewritten';
  exception when others then
    if sqlerrm not like '%admits only its commit and reversal%' then raise; end if;
  end;

  insert into deedbox.party_merge (survivor, absorbed, absorbed_snapshot, repointed_links, performed_by, bulk_operation)
    values (p1, p3, '{"names":["Loose End"]}', '[]', s_admin, bo) returning id into pm;
  begin
    update deedbox.party_merge set absorbed_snapshot = '{}' where id = pm;
    raise exception 'merge snapshot rewritten';
  exception when others then
    if sqlerrm not like '%exactly one mutation%' then raise; end if;
  end;
  update deedbox.party_merge set undone_at = now() where id = pm;
  begin
    update deedbox.party_merge set undone_at = null where id = pm;
    raise exception 'undone merge record mutated';
  exception when others then
    if sqlerrm not like '%immutable%' then raise; end if;
  end;
  begin
    delete from deedbox.party_merge where id = pm;
    raise exception 'merge record deleted';
  exception when others then
    if sqlerrm not like '%never deleted%' then raise; end if;
  end;

  ------------------------------------------------------------------
  -- 8. Conflict checks: immutable snapshots; one attach transition;
  --    once-written snapshot names; one resolution per check with the
  --    action-note rule.
  ------------------------------------------------------------------
  insert into deedbox.practice_area (name) values ('Litigation') returning id into pa;
  insert into deedbox.matter (matter_number, title, client_party, responsible_lawyer, office, practice_area)
    values (deedbox.allocate_number('matter', null, current_date), 'Conflict host', p1, s_law, o, pa) returning id into m1;

  insert into deedbox.conflict_check (run_by_kind, run_by, terms, result_snapshot)
    values ('staff', s_admin, '{"terms":["Jo Client"]}', '{"groups":[]}') returning id into cc;
  insert into deedbox.conflict_snapshot_name ("check", name_key, name_phonetic)
    values (cc, deedbox.fold_name('Jo Client'), deedbox.phonetic_name('Jo Client'));
  begin
    update deedbox.conflict_check set result_snapshot = '{"groups":["tampered"]}' where id = cc;
    raise exception 'snapshot rewritten';
  exception when others then
    if sqlerrm not like '%exactly one mutation%' then raise; end if;
  end;
  begin
    delete from deedbox.conflict_check where id = cc;
    raise exception 'conflict check deleted';
  exception when others then
    if sqlerrm not like '%never deleted%' then raise; end if;
  end;
  begin
    update deedbox.conflict_check set attached_to_kind='matter', attached_to=999999 where id = cc;
    raise exception 'attached to a nonexistent target';
  exception when others then
    if sqlerrm not like '%does not exist%' then raise; end if;
  end;
  update deedbox.conflict_check set attached_to_kind='matter', attached_to=m1 where id = cc;
  begin
    update deedbox.conflict_check set attached_to=null, attached_to_kind='none' where id = cc;
    raise exception 'attachment detached';
  exception when others then
    if sqlerrm not like '%immutable once attached%' then raise; end if;
  end;
  begin
    update deedbox.conflict_snapshot_name set name_key='tampered' where "check" = cc;
    raise exception 'snapshot name mutated';
  exception when others then
    if sqlerrm not like '%written once%' then raise; end if;
  end;

  -- a past check's snapshot names are searchable evidence for future checks.
  if not exists (select 1 from deedbox.conflict_snapshot_name sn
                  where sn.name_key = deedbox.fold_name('jo CLIENT')) then
    raise exception 'snapshot name not findable by normalised key';
  end if;

  begin
    insert into deedbox.conflict_resolution ("check", resolution, resolved_by)
      values (cc, 'conflict_found_action_taken', s_admin);
    raise exception 'conflict-found resolution accepted without an action note';
  exception when others then
    if sqlerrm not like '%check%' then raise; end if;
  end;
  insert into deedbox.conflict_resolution ("check", resolution, action_note, resolved_by)
    values (cc, 'conflict_found_action_taken', 'Wall erected; second lawyer assigned.', s_admin);
  begin
    insert into deedbox.conflict_resolution ("check", resolution, resolved_by)
      values (cc, 'no_conflict_found', s_admin);
    raise exception 'second resolution for one check accepted';
  exception when others then
    if sqlerrm not like '%duplicate key%' then raise; end if;
  end;
  begin
    update deedbox.conflict_resolution set action_note='revised' where "check" = cc;
    raise exception 'resolution mutated';
  exception when others then
    if sqlerrm not like '%insert-only%' then raise; end if;
  end;

  raise notice 'ALL 0007 IDENTITY-COMPLETION TESTS PASSED';
end $$;

rollback;
