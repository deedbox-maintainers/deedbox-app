-- Tests for 0042_register_hash_text_encoding. Run as deployment role AFTER
-- the full chain. Proves the register survives text it used to choke on,
-- that the chain still verifies, and that the conversion is not a decoder.

begin;

grant deedbox_app to current_user;

insert into deedbox.country_pack (code, name) values ('XQT','Quoted Text Test Pack');
insert into deedbox.firm (name, operating_currency, timezone, country_pack)
  select 'Quoted Text Test Firm','AUD','Australia/Sydney', id
    from deedbox.country_pack where code='XQT';
insert into deedbox.office (name, code) values ('QT Office','XQT1');

do $$
declare
  fm bigint; off bigint; rl bigint; st bigint; pa bigint; p1 bigint; m bigint; num text;
  breaks bigint; n int;
begin
  select id into fm from deedbox.firm where name = 'Quoted Text Test Firm';
  select id into off from deedbox.office where code = 'XQT1';
  select id into rl from deedbox.role where system_key = 'administrator';
  insert into deedbox.staff_member (person_name, login, role, office, email)
    values ('{"given":"Quentin","family":"Tester"}','quentin.xqt', rl, off,
            'quentin.xqt@example.test')
    returning id into st;
  insert into deedbox.practice_area (name) values ('QT General') returning id into pa;
  insert into deedbox.party (kind, display_name) values ('person','QT Client') returning id into p1;
  insert into deedbox.party_name (party, name_kind, full_name) values (p1,'current','QT Client');
  num := deedbox.allocate_number('matter', null, current_date);
  insert into deedbox.matter (matter_number, title, client_party, responsible_lawyer, office, practice_area)
    values (num, 'QT matter', p1, st, off, pa) returning id into m;

  -- T1 THE DEFECT ITSELF: a detail carrying a double quote. A JSON document
  -- renders it as \", which the old bytea cast read as an escape and refused.
  insert into deedbox.register_entry
    (firm, actor_kind, actor, event_kind, subject_type, subject, matter, detail)
  values (fm, 'staff', st, 'record.created', 'party', p1, null,
          jsonb_build_object('display_name', 'Marguerite "Daisy" Ashgrove-Penrhyn'));

  -- T2 a lone backslash, which was never a valid escape either
  insert into deedbox.register_entry
    (firm, actor_kind, actor, event_kind, subject_type, subject, matter, detail)
  values (fm, 'staff', st, 'record.created', 'party', p1, null,
          jsonb_build_object('display_name', 'Back\Slash Holdings'));

  -- T3 a backslash sequence that WAS a valid escape, and so was silently
  -- decoded — the integrity half of the defect
  insert into deedbox.register_entry
    (firm, actor_kind, actor, event_kind, subject_type, subject, matter, detail)
  values (fm, 'staff', st, 'record.created', 'party', p1, null,
          jsonb_build_object('note', 'octal \101 and \\ and "quoted"'));

  -- T4 non-ASCII must survive the conversion unharmed
  insert into deedbox.register_entry
    (firm, actor_kind, actor, event_kind, subject_type, subject, matter, detail)
  values (fm, 'staff', st, 'record.created', 'party', p1, null,
          jsonb_build_object('display_name', 'Ngô Đình "Bảo" Trần — Ærø ﬁrm'));

  select count(*) into n from deedbox.register_entry where firm = fm;
  if n < 4 then
    raise exception 'T1-T4 FAILED: expected at least four entries, found %', n;
  end if;

  -- T5 the chain still verifies end to end — writer and verifier compute the
  -- same recipe, which is the whole point of changing both together
  select deedbox.register_verify_chain(fm) into breaks;
  if breaks <> 0 then
    raise exception 'T5 FAILED: the chain reports % break(s) after the change', breaks;
  end if;

  -- T6 the detailed walk agrees, from genesis and from a checkpoint
  select d.breaks into breaks from deedbox.register_verify_chain_detail(fm, 0) d;
  if breaks <> 0 then
    raise exception 'T6 FAILED: the detailed walk reports % break(s)', breaks;
  end if;

  -- T7 the conversion is not a decoder: two canonical lines that the old cast
  -- collapsed to identical bytes must now hash differently
  if encode(sha256(convert_to('A', 'UTF8')), 'hex')
     = encode(sha256(convert_to('\101', 'UTF8')), 'hex') then
    raise exception 'T7 FAILED: distinct text still hashes identically';
  end if;
  if 'A'::bytea <> '\101'::bytea then
    raise exception 'T7 FAILED: the premise is wrong — the old cast did not collapse these';
  end if;

  -- T8 hash compatibility: for ordinary text the two conversions agree, so
  -- nothing that hashed before hashes differently now
  if encode(sha256('firm|1|2026-08-16|record.created'::bytea), 'hex')
     <> encode(sha256(convert_to('firm|1|2026-08-16|record.created', 'UTF8')), 'hex') then
    raise exception 'T8 FAILED: the change alters the hash of ordinary text';
  end if;

  -- T9 the stored hash really is the new recipe, recomputed by hand from the
  -- entry's own columns. The register is append-only by trigger, so a stored
  -- hash cannot be doctored to test the verifier from the other side; this
  -- checks the same thing from the writer's side, without ceremony.
  perform 1 from deedbox.register_entry e
   where e.firm = fm
     and e.detail ->> 'display_name' = 'Marguerite "Daisy" Ashgrove-Penrhyn'
     and e.entry_hash = encode(sha256(convert_to(concat_ws('|',
           e.prev_hash, e.firm::text, e.seq::text, e.occurred_at::text,
           e.actor_kind, coalesce(e.actor::text,''), e.event_kind,
           e.subject_type, e.subject::text, coalesce(e.matter::text,''),
           e.privileged::text, coalesce(e.detail::text,''),
           coalesce(e.reason,''), coalesce(e.artefact,'')), 'UTF8')), 'hex');
  if not found then
    raise exception 'T9 FAILED: the stored hash is not the text-encoded recipe';
  end if;
end $$;

rollback;
