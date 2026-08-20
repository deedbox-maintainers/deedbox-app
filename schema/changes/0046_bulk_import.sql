-- 0046 — the bulk import: every record domain, server-side.
--
-- Archive-scale migrations proved the per-record loading shape cannot scale:
-- each record paid many network round trips between the operator's machine
-- and the database, so a large archive queued for hours at a one-at-a-time
-- door. This change moves the ENTIRE import pipeline
-- inside the database: records are STAGED in bulk, then each domain applies
-- in one server-side call that reproduces the per-record pipeline's exact
-- semantics — per-record verdicts, per-record safety nets, source-reference
-- repeat-safety, the same register entries, the same batch reports, client
-- money all-or-nothing, and the validate-only mode that persists nothing.
--
-- Parity statement (the per-record pipeline in lib/ops/imports is the
-- specification; its appliers were ported statement by statement):
--   * Dispositions, refusal messages and warning texts are identical.
--   * validate_only runs the whole domain inside a sub-block that is rolled
--     back by a sentinel; only the batch row, its per-record dispositions,
--     the report artefact and the register entry survive — and gapless
--     numbers consumed inside the rolled-back work are released with it.
--   * Every write happens under the caller's own role and principal context
--     (deedbox_app + the 0005 predicate GUCs) — these functions are invoker
--     rights on purpose, so row security, grants, triggers and guards fire
--     exactly as they do for live operations.
--   * Client money: one transaction holds the whole replay; any integrity
--     failure aborts everything (zero money rows persist) and raises with
--     the itemised outcomes in the error detail, so the caller can commit
--     the refused-batch evidence in its own transaction
--     (bulk_record_money_refusal — the refusal-capture protocol's shape).
--
-- Two DELIBERATE deviations from the per-record shape, both strengthenings:
--   1. A real non-money batch is ONE transaction (per-record commits made a
--      mid-batch crash leave a partial batch; here it leaves nothing).
--   2. A matter landing on a practice area with ANY active workflow template
--      refuses loudly. The live path auto-applies a single template; a bulk
--      migration must not silently spawn workflow onto hundreds of matters —
--      deactivate templates for the load, or use the live path.

begin;

create table deedbox.import_staging_record (
    batch_key text not null,
    seq bigint not null,
    source_ref text not null,
    data jsonb not null,
    primary key (batch_key, seq)
);
grant select, insert, delete on deedbox.import_staging_record to deedbox_app;

create type deedbox.bulk_outcome as (
    source_ref text,
    disposition text,
    message text,
    target_type text,
    target bigint
);

-- ---------------------------------------------------------------------------
-- Staging: append records (jsonb array of {source_ref, data}) and clear.
-- ---------------------------------------------------------------------------

create or replace function deedbox.bulk_stage(p_batch_key text, p_records jsonb)
returns integer language plpgsql as $stage$
declare n integer;
begin
  insert into deedbox.import_staging_record (batch_key, seq, source_ref, data)
  select p_batch_key,
         coalesce((select max(seq) from deedbox.import_staging_record where batch_key = p_batch_key), 0)
           + row_number() over (),
         r ->> 'source_ref',
         r -> 'data'
    from jsonb_array_elements(p_records) r;
  get diagnostics n = row_count;
  return n;
end $stage$;

create or replace function deedbox.bulk_stage_clear(p_batch_key text)
returns integer language plpgsql as $clear$
declare n integer;
begin
  delete from deedbox.import_staging_record where batch_key = p_batch_key;
  get diagnostics n = row_count;
  return n;
end $clear$;

-- ---------------------------------------------------------------------------
-- Ported helpers: the register write, artefact store, source references,
-- the touched-since-import exam, capability and settings reads.
-- ---------------------------------------------------------------------------

create or replace function deedbox.bulk_register(
    p_firm bigint, p_actor bigint, p_kind text, p_subject_type text,
    p_subject bigint, p_matter bigint, p_detail jsonb, p_artefact text default null)
returns bigint language plpgsql as $reg$
declare rid bigint;
begin
  insert into deedbox.register_entry
    (firm, actor_kind, actor, session_ref, event_kind, subject_type,
     subject, matter, privileged, detail, reason, bulk_operation, artefact)
  values (p_firm, 'staff', p_actor, null, p_kind, p_subject_type,
          p_subject, p_matter, false, p_detail, null, null, p_artefact)
  returning id into rid;
  return rid;
end $reg$;

create or replace function deedbox.bulk_artefact(p_kind text, p_content text, p_type text)
returns bigint language plpgsql as $art$
declare aid bigint;
begin
  insert into deedbox.stored_artefact (kind, content_ref, content_hash, content_type, size_bytes)
  values (p_kind, p_content,
          encode(sha256(convert_to(p_content, 'UTF8')), 'hex'),
          p_type, octet_length(p_content))
  returning id into aid;
  return aid;
end $art$;

create or replace function deedbox.bulk_source_hit(
    p_system text, p_ref text, p_type text,
    out o_target bigint, out o_created_at timestamptz)
language sql as $hit$
  select target, created_at from deedbox.source_reference
   where source_system = p_system and source_ref = p_ref and target_type = p_type;
$hit$;

create or replace function deedbox.bulk_touched_since(
    p_type text, p_target bigint, p_at timestamptz)
returns boolean language sql as $tsi$
  select exists (
    select 1 from deedbox.register_entry e
     where e.subject_type = p_type and e.subject = p_target
       and e.occurred_at > p_at
       and (e.detail ->> 'import_batch') is null
       and (e.detail ->> 'import_batch_reversal') is null);
$tsi$;

create or replace function deedbox.bulk_has_capability(p_staff bigint, p_key text)
returns boolean language sql as $cap$
  select exists (
    select 1 from deedbox.staff_member s
      join deedbox.role r on r.id = s.role and r.active
      join deedbox.role_capability rc on rc.role = s.role
     where s.id = p_staff and s.active and rc.capability = p_key and rc.scope <> 'none');
$cap$;

create or replace function deedbox.bulk_setting_text(p_key text)
returns text language sql as $set$
  select deedbox.current_setting_value(p_key) #>> '{}';
$set$;

-- Resolve the historical staff member by login; absent = the acting staff.
create or replace function deedbox.bulk_import_staff(p_actor bigint, p_ref text, p_login text)
returns bigint language plpgsql as $stf$
declare sid bigint;
begin
  if p_login is null then return p_actor; end if;
  select id into sid from deedbox.staff_member where login = p_login;
  if sid is null then
    raise exception '%: no staff member with login %', p_ref, p_login;
  end if;
  return sid;
end $stf$;

-- Resolve a record's matter (explicit id or an imported source reference).
create or replace function deedbox.bulk_record_matter(
    p_system text, p_ref text, p_data jsonb)
returns bigint language plpgsql as $rmx$
declare mid bigint; h record;
begin
  if p_data ? 'matter' then return (p_data ->> 'matter')::bigint; end if;
  if (p_data ->> 'matter_source_ref') is not null then
    select * into h from deedbox.bulk_source_hit(p_system, p_data ->> 'matter_source_ref', 'matter');
    if h.o_target is null then
      raise exception '%: matter source reference % has not been imported',
        p_ref, p_data ->> 'matter_source_ref';
    end if;
    return h.o_target;
  end if;
  raise exception '% names no matter', p_ref;
end $rmx$;

-- The one home for a document's searchable text (syncDocumentText, ported).
create or replace function deedbox.bulk_sync_document_text(p_doc bigint)
returns void language plpgsql as $syn$
declare d record; v_content text;
begin
  select dd.id, dd.matter, dd.title, dd.description, dd.soft_deleted_at,
         coalesce(t.content, '') as text
    into d
    from deedbox.document dd
    left join deedbox.document_version v
      on v.document = dd.id and v.version_no = dd.current_version
    left join deedbox.document_version_text t on t.version = v.id
   where dd.id = p_doc;
  if not found then return; end if;
  if d.soft_deleted_at is not null then
    perform deedbox.corpus_withdraw('documents', 'external_document', p_doc::text);
    delete from deedbox.search_index where entry_type = 'document' and source = p_doc;
    return;
  end if;
  v_content := left(concat_ws(' ',
    nullif(d.title, ''), nullif(coalesce(d.description, ''), ''), nullif(d.text, '')), 200000);
  perform deedbox.corpus_upsert('documents', 'external_document', p_doc::text,
    v_content, d.matter, null);
  insert into deedbox.search_index (entry_type, source, matter, display_title, body)
  values ('document', p_doc, d.matter, d.title, left(d.text, 200000))
  on conflict (entry_type, source) do update
    set matter = excluded.matter, display_title = excluded.display_title,
        body = excluded.body, updated_at = now();
end $syn$;

-- One version's text (writeVersionTextInTx, ported).
create or replace function deedbox.bulk_write_version_text(
    p_version bigint, p_doc bigint, p_content text, p_method text)
returns void language plpgsql as $wvt$
begin
  insert into deedbox.document_version_text (version, content, method, char_count)
  values (p_version, p_content, p_method, length(p_content))
  on conflict (version) do update
    set content = excluded.content, method = excluded.method, char_count = excluded.char_count;
  perform deedbox.bulk_sync_document_text(p_doc);
end $wvt$;

-- '/'-separated folder path under a matter, creating what is missing
-- (ensureFolderPathInTx, ported: idempotent by (matter, parent, name)).
create or replace function deedbox.bulk_ensure_folder_path(
    p_firm bigint, p_actor bigint, p_batch bigint,
    p_matter bigint, p_path text, p_created_by bigint)
returns bigint language plpgsql as $fol$
declare v_seg text; v_parent bigint := null; v_hit bigint; v_any boolean := false;
begin
  foreach v_seg in array string_to_array(p_path, '/') loop
    v_seg := trim(v_seg);
    continue when v_seg = '';
    v_any := true;
    select f.id into v_hit from deedbox.document_folder f
     where f.matter = p_matter and f.name = v_seg and f.parent is not distinct from v_parent;
    if v_hit is not null then
      v_parent := v_hit;
      continue;
    end if;
    insert into deedbox.document_folder (matter, parent, name, created_by)
    values (p_matter, v_parent, v_seg, p_created_by)
    returning id into v_parent;
    perform deedbox.bulk_register(p_firm, p_actor, 'record.created', 'document_folder',
      v_parent, p_matter, jsonb_build_object('name', v_seg, 'import_batch', p_batch));
  end loop;
  if not v_any then
    raise exception 'a folder path needs at least one segment';
  end if;
  return v_parent;
end $fol$;

-- ---------------------------------------------------------------------------
-- Domain appliers. Each is the per-record applier from lib/ops/imports,
-- ported statement by statement; refusal texts are kept identical so a
-- verdict reads the same whichever shape produced it.
-- ---------------------------------------------------------------------------

create or replace function deedbox.bulk_apply_clients_record(
    p_firm bigint, p_actor bigint, p_batch bigint, p_system text,
    p_ref text, p_data jsonb)
returns deedbox.bulk_outcome language plpgsql as $cli$
declare
  v_name text := trim(coalesce(p_data ->> 'full_name', ''));
  v_notes text := p_data ->> 'notes';
  v_phone text := nullif(trim(coalesce(p_data ->> 'phone', '')), '');
  v_email text := nullif(trim(coalesce(p_data ->> 'email', '')), '');
  v_hit record; v_cur record; v_party bigint; v_cands text;
begin
  if v_name = '' then
    raise exception 'a client record needs full_name';
  end if;
  select * into v_hit from deedbox.bulk_source_hit(p_system, p_ref, 'party');
  if v_hit.o_target is not null then
    if deedbox.bulk_touched_since('party', v_hit.o_target, v_hit.o_created_at) then
      return (p_ref, 'accepted_with_warning', 'target changed since import; not updated',
              null, null)::deedbox.bulk_outcome;
    end if;
    select pt.display_name, pt.notes into v_cur from deedbox.party pt where pt.id = v_hit.o_target;
    if v_cur.display_name = v_name and (v_cur.notes is not distinct from v_notes) then
      return (p_ref, 'accepted_with_warning', 'already imported; no changes',
              null, null)::deedbox.bulk_outcome;
    end if;
    if v_cur.display_name <> v_name then
      update deedbox.party_name set name_kind = 'former'
       where party = v_hit.o_target and name_kind = 'current';
      insert into deedbox.party_name (party, name_kind, full_name)
      values (v_hit.o_target, 'current', v_name);
    end if;
    update deedbox.party set display_name = v_name, notes = v_notes where id = v_hit.o_target;
    perform deedbox.bulk_register(p_firm, p_actor, 'record.changed', 'party', v_hit.o_target, null,
      jsonb_build_object(
        'before', jsonb_build_object('display_name', v_cur.display_name, 'notes', v_cur.notes),
        'after', jsonb_build_object('display_name', v_name, 'notes', v_notes),
        'import_batch', p_batch));
    return (p_ref, 'updated', null, 'party', v_hit.o_target)::deedbox.bulk_outcome;
  end if;
  select string_agg(dc.party::text, ', ') into v_cands
    from deedbox.duplicate_candidates(v_name, v_phone, v_email) dc;
  insert into deedbox.party (kind, display_name, notes)
  values (coalesce(p_data ->> 'kind', 'person'), v_name, v_notes)
  returning id into v_party;
  insert into deedbox.party_name (party, name_kind, full_name) values (v_party, 'current', v_name);
  if v_phone is not null then
    insert into deedbox.contact_point (party, kind, value, is_primary)
    values (v_party, 'phone', v_phone, true);
  end if;
  if v_email is not null then
    insert into deedbox.contact_point (party, kind, value, is_primary)
    values (v_party, 'email', v_email, true);
  end if;
  perform deedbox.bulk_register(p_firm, p_actor, 'record.created', 'party', v_party, null,
    jsonb_build_object('display_name', v_name, 'import_batch', p_batch));
  insert into deedbox.source_reference (source_system, source_ref, target_type, target)
  values (p_system, p_ref, 'party', v_party);
  if v_cands is not null then
    return (p_ref, 'accepted_with_warning',
            'possible duplicates of existing parties: ' || v_cands,
            'party', v_party)::deedbox.bulk_outcome;
  end if;
  return (p_ref, 'accepted', null, 'party', v_party)::deedbox.bulk_outcome;
end $cli$;

-- The direct close, ported from matterLifecycle (lock order preserved:
-- matter row, then every ledger ascending, held to commit).
create or replace function deedbox.bulk_close_matter_direct(
    p_firm bigint, p_actor bigint, p_matter bigint, p_note text)
returns void language plpgsql as $cls$
declare
  v_status text; v_lid bigint; v_bal numeric;
  v_ledgers jsonb := '[]'::jsonb; v_hard text[] := '{}'::text[];
  v_held numeric := 0; v_earm numeric := 0; v_earm_n int := 0; v_inst_n int := 0;
  v_dorm jsonb; v_unbilled numeric; v_outstanding numeric; v_ids bigint[];
  v_beh_unb text; v_beh_out text; v_beh_held text; v_block text[] := '{}'::text[];
  v_fail text[]; v_pos jsonb; v_eval jsonb; v_req bigint;
begin
  select m.status into v_status from deedbox.matter m where m.id = p_matter for update;
  if v_status is null then raise exception 'matter not found'; end if;
  if v_status <> 'open' and v_status <> 'on_hold' then
    raise exception 'a % matter cannot be closed', v_status;
  end if;
  select coalesce(array_agg(l.id order by l.id), '{}'::bigint[]) into v_ids
    from deedbox.matter_ledger l where l.matter = p_matter;
  perform 1 from deedbox.matter_ledger l where l.id = any(v_ids) order by l.id for update;
  foreach v_lid in array v_ids loop
    select deedbox.ledger_balance(v_lid) into v_bal;
    v_ledgers := v_ledgers || jsonb_build_object('id', v_lid, 'balance', v_bal);
    v_held := v_held + v_bal;
    if v_bal <> 0 then
      v_hard := v_hard || format('ledger %s holds %s', v_lid, to_char(v_bal, 'FM999999999990.00'));
    end if;
  end loop;
  if array_length(v_ids, 1) is not null then
    select coalesce(sum(e.amount), 0), count(*)::int into v_earm, v_earm_n
      from deedbox.earmark e where e.matter_ledger = any(v_ids) and e.state = 'active';
    if v_earm_n > 0 then v_hard := v_hard || format('%s active earmark(s)', v_earm_n); end if;
    select count(*)::int into v_inst_n
      from deedbox.instrument i
      join deedbox.ledger_line ll on ll.transaction = i.transaction
     where ll.matter_ledger = any(v_ids)
       and i.state not in ('presented','replaced','cleared','dishonoured','cancelled');
    if v_inst_n > 0 then
      v_hard := v_hard || format('%s instrument(s) not in a terminal-good state', v_inst_n);
    end if;
  end if;
  select coalesce(jsonb_agg(dc.id), '[]'::jsonb) into v_dorm
    from deedbox.dormant_case dc
   where dc.matter_ledger = any(v_ids) and dc.state <> 'resolved' and dc.state <> 'remitted';
  select coalesce((select sum(te.value) from deedbox.time_entry te
                    where te.matter = p_matter and te.billed_state = 'unbilled'
                      and te.deleted_at is null), 0)
       + coalesce((select sum(d.amount) from deedbox.disbursement d
                    where d.matter = p_matter and d.billed_state = 'unbilled'
                      and d.deleted_at is null), 0)
    into v_unbilled;
  select coalesce(sum(deedbox.bill_outstanding(b.id)), 0) into v_outstanding
    from deedbox.bill b where b.matter = p_matter and b.state = 'issued';
  v_beh_unb  := coalesce(deedbox.bulk_setting_text('matter.close_condition_unbilled'), 'warn');
  v_beh_out  := coalesce(deedbox.bulk_setting_text('matter.close_condition_outstanding'), 'warn');
  v_beh_held := coalesce(deedbox.bulk_setting_text('matter.close_condition_held_funds'), 'block');
  if v_unbilled > 0 and v_beh_unb = 'block' then
    v_block := v_block || format('unbilled work remains (%s)', to_char(v_unbilled, 'FM999999999990.00'));
  end if;
  if v_outstanding > 0 and v_beh_out = 'block' then
    v_block := v_block || format('bills remain outstanding (%s)', to_char(v_outstanding, 'FM999999999990.00'));
  end if;
  if v_held <> 0 and v_beh_held = 'block' then
    v_block := v_block || format('client money remains held (%s)', to_char(v_held, 'FM999999999990.00'));
  end if;
  v_fail := v_hard || v_block;
  if array_length(v_fail, 1) is not null then
    raise exception 'close refused: %', array_to_string(v_fail, '; ');
  end if;
  v_pos := jsonb_build_object(
    'unbilled', v_unbilled, 'outstanding', v_outstanding, 'heldGross', v_held,
    'heldEarmarked', v_earm, 'heldAvailable', v_held - v_earm,
    'ledgers', v_ledgers, 'dormantWarnings', v_dorm);
  v_eval := jsonb_build_object(
    'unbilled', jsonb_build_object('present', v_unbilled > 0, 'behaviour', v_beh_unb),
    'outstanding', jsonb_build_object('present', v_outstanding > 0, 'behaviour', v_beh_out),
    'heldFunds', jsonb_build_object('present', v_held <> 0, 'behaviour', v_beh_held));
  insert into deedbox.matter_close_request
    (matter, requested_by, financial_position, condition_evaluation,
     state, decided_by, decided_at, decision_note)
  values (p_matter, p_actor, v_pos, v_eval, 'approved', p_actor, now(), p_note)
  returning id into v_req;
  update deedbox.matter set status = 'closed' where id = p_matter;
  perform deedbox.bulk_register(p_firm, p_actor, 'matter.close_approved', 'matter_close_request',
    v_req, p_matter, jsonb_build_object('position', v_pos, 'evaluation', v_eval));
  perform deedbox.bulk_register(p_firm, p_actor, 'matter.status_changed', 'matter',
    p_matter, p_matter,
    jsonb_build_object('before', 'open', 'after', 'closed', 'position', v_pos));
end $cls$;

create or replace function deedbox.bulk_apply_matters_record(
    p_firm bigint, p_actor bigint, p_batch bigint, p_system text,
    p_ref text, p_data jsonb)
returns deedbox.bulk_outcome language plpgsql as $mat$
declare
  v_hit record; v_cur record; v_ch record;
  v_title text := trim(coalesce(p_data ->> 'title', ''));
  v_client bigint; v_lawyer bigint; v_office bigint;
  v_area_id bigint; v_pstate text; v_pdel timestamptz;
  v_templates int; v_num text; v_matter bigint; v_prior text;
begin
  select * into v_hit from deedbox.bulk_source_hit(p_system, p_ref, 'matter');
  if v_hit.o_target is not null then
    if deedbox.bulk_touched_since('matter', v_hit.o_target, v_hit.o_created_at) then
      return (p_ref, 'accepted_with_warning', 'target changed since import; not updated',
              null, null)::deedbox.bulk_outcome;
    end if;
    select m.title, m.summary into v_cur from deedbox.matter m where m.id = v_hit.o_target;
    if not found then
      return (p_ref, 'accepted_with_warning',
              'imported matter not visible to the import actor; not updated',
              null, null)::deedbox.bulk_outcome;
    end if;
    if v_cur.title = v_title and (v_cur.summary is not distinct from (p_data ->> 'summary')) then
      return (p_ref, 'accepted_with_warning', 'already imported; no changes',
              null, null)::deedbox.bulk_outcome;
    end if;
    update deedbox.matter set title = v_title, summary = p_data ->> 'summary'
     where id = v_hit.o_target;
    perform deedbox.bulk_register(p_firm, p_actor, 'record.changed', 'matter',
      v_hit.o_target, v_hit.o_target,
      jsonb_build_object(
        'before', jsonb_build_object('title', v_cur.title, 'summary', v_cur.summary),
        'after', jsonb_build_object('title', v_title, 'summary', p_data ->> 'summary'),
        'import_batch', p_batch));
    return (p_ref, 'updated', null, 'matter', v_hit.o_target)::deedbox.bulk_outcome;
  end if;

  if p_data ? 'client_party' then
    v_client := (p_data ->> 'client_party')::bigint;
  elsif (p_data ->> 'client_source_ref') is not null then
    select * into v_ch from deedbox.bulk_source_hit(p_system, p_data ->> 'client_source_ref', 'party');
    if v_ch.o_target is null then
      raise exception 'client source reference % has not been imported',
        p_data ->> 'client_source_ref';
    end if;
    v_client := v_ch.o_target;
  else
    raise exception 'a matter record names its client';
  end if;
  select s.id into v_lawyer from deedbox.staff_member s
   where s.login = p_data ->> 'responsible_lawyer_login' and s.active;
  if v_lawyer is null then
    raise exception 'no active staff member with login %', p_data ->> 'responsible_lawyer_login';
  end if;
  select o.id into v_office from deedbox.office o where o.code = p_data ->> 'office_code';
  if v_office is null then
    raise exception 'no office with code %', p_data ->> 'office_code';
  end if;
  select a.id into v_area_id from deedbox.practice_area a
   where a.name = p_data ->> 'practice_area_name' and a.active;
  if v_area_id is null then
    raise exception 'no active practice area named %', p_data ->> 'practice_area_name';
  end if;

  -- createMatter core, gate satisfied externally (the source system's own
  -- history is the conflict gate's satisfaction, as in the per-record path).
  if v_title = '' then raise exception 'a matter needs a title'; end if;
  select pt.state, pt.deleted_at into v_pstate, v_pdel from deedbox.party pt where pt.id = v_client;
  if v_pstate is null then raise exception 'client party not found'; end if;
  if v_pstate <> 'active' or v_pdel is not null then
    raise exception 'the client must be an active party';
  end if;
  -- Deviation 2 (see header): any active workflow template refuses, before
  -- the gapless counter is touched.
  select count(*)::int into v_templates from deedbox.workflow_template w
   where w.practice_area = v_area_id and w.active;
  if v_templates > 0 then
    raise exception 'bulk import onto a practice area with an active workflow template is not supported — deactivate the template for the load or use the live path';
  end if;
  select deedbox.allocate_number('matter') into v_num;
  -- No RETURNING on this insert: the visibility predicate cannot see a row
  -- the same command is still inserting (the per-record path's own note).
  insert into deedbox.matter
    (matter_number, title, client_party, responsible_lawyer, office,
     practice_area, jurisdiction, summary, origin_note, opened_date)
  values (v_num, v_title, v_client, v_lawyer, v_office, v_area_id, null,
          p_data ->> 'summary', format('imported from %s (%s)', p_system, p_ref),
          coalesce((p_data ->> 'opened_date')::date, current_date));
  select m.id into v_matter from deedbox.matter m where m.matter_number = v_num;
  insert into deedbox.matter_staffing (matter, staff, role_on_matter)
  values (v_matter, v_lawyer, 'responsible_lawyer');
  perform deedbox.bulk_register(p_firm, p_actor, 'record.created', 'matter', v_matter, v_matter,
    jsonb_build_object('matter_number', v_num, 'title', v_title));
  perform deedbox.bulk_register(p_firm, p_actor, 'matter.status_changed', 'matter', v_matter, v_matter,
    jsonb_build_object('before', null, 'after', 'open'));
  v_prior := trim(coalesce(p_data ->> 'prior_reference', ''));
  if v_prior <> '' then
    update deedbox.matter set prior_reference = v_prior where id = v_matter;
  end if;
  if p_data ->> 'status' = 'closed' then
    perform deedbox.bulk_close_matter_direct(p_firm, p_actor, v_matter,
      coalesce(p_data ->> 'close_note', format('imported as closed from %s', p_system)));
  end if;
  insert into deedbox.source_reference (source_system, source_ref, target_type, target)
  values (p_system, p_ref, 'matter', v_matter);
  return (p_ref, 'accepted', null, 'matter', v_matter)::deedbox.bulk_outcome;
end $mat$;

create or replace function deedbox.bulk_apply_time_record(
    p_firm bigint, p_actor bigint, p_batch bigint, p_system text,
    p_ref text, p_data jsonb)
returns deedbox.bulk_outcome language plpgsql as $tim$
declare
  v_hit record; v_matter bigint; v_staff bigint; v_status text; v_cat bigint;
  v_kind text; v_units numeric; v_unitmin int; v_rate numeric; v_rate_src text;
  v_amount numeric; v_id bigint; v_value numeric;
  v_narr text := coalesce(p_data ->> 'narrative', '');
begin
  select * into v_hit from deedbox.bulk_source_hit(p_system, p_ref, 'time_entry');
  if v_hit.o_target is not null then
    return (p_ref, 'accepted_with_warning', 'already imported; history never re-applies',
            null, null)::deedbox.bulk_outcome;
  end if;
  v_matter := deedbox.bulk_record_matter(p_system, p_ref, p_data);
  select s.id into v_staff from deedbox.staff_member s where s.login = p_data ->> 'staff_login';
  if v_staff is null then
    raise exception '%: no staff member with login %', p_ref, p_data ->> 'staff_login';
  end if;
  if trim(v_narr) = '' then
    raise exception 'a time entry carries a narrative';
  end if;
  select m.status into v_status from deedbox.matter m where m.id = v_matter;
  if v_status is null then raise exception 'matter not found'; end if;
  if v_status = 'closed' or v_status = 'archived' then
    if not deedbox.bulk_has_capability(p_actor, 'matter.edit_closed') then
      raise exception 'this matter is closed; recording needs matter.edit_closed';
    end if;
  end if;
  select ci.id into v_cat from deedbox.choice_item ci
    join deedbox.choice_list cl on cl.id = ci.list
   where cl.purpose_key = 'time_categories' and ci.shipped_key = 'chargeable';
  if v_cat is null then
    raise exception 'no shipped item chargeable in list time_categories';
  end if;
  v_kind := coalesce(p_data ->> 'kind', 'timed');
  if v_kind = 'timed' then
    v_units := (p_data ->> 'units')::numeric;
    if v_units is null or v_units <= 0 then
      raise exception 'a timed entry needs units above zero';
    end if;
    v_unitmin := coalesce(deedbox.bulk_setting_text('time.unit_minutes'), '6')::int;
    if p_data ? 'manual_rate' then
      v_rate := (p_data ->> 'manual_rate')::numeric;
      v_rate_src := 'manual';
    else
      select rr.rate, rr.rate_source into v_rate, v_rate_src
        from deedbox.resolve_rate(v_matter, v_staff, null, (p_data ->> 'work_date')::date) rr;
      if v_rate is null then
        raise exception 'no rate resolves for this staff member and date; supply one';
      end if;
    end if;
    insert into deedbox.time_entry
      (matter, staff, work_date, kind, units, unit_minutes_applied, applied_rate,
       rate_source, value, narrative, category, origin, suggestion, created_by)
    values (v_matter, v_staff, (p_data ->> 'work_date')::date, 'timed', v_units::int,
            v_unitmin, v_rate, v_rate_src,
            round((v_units::int * v_unitmin * v_rate) / 60.0, 2),
            v_narr, v_cat, 'import', null, p_actor)
    returning id, value into v_id, v_value;
  else
    v_amount := (p_data ->> 'fixed_amount')::numeric;
    if v_amount is null or v_amount < 0 then
      raise exception 'a fixed-fee entry needs its amount';
    end if;
    insert into deedbox.time_entry
      (matter, staff, work_date, kind, fixed_amount, value, narrative, category,
       origin, suggestion, created_by)
    values (v_matter, v_staff, (p_data ->> 'work_date')::date, 'fixed_fee', v_amount,
            v_amount, v_narr, v_cat, 'import', null, p_actor)
    returning id, value into v_id, v_value;
  end if;
  -- supersede overlapping pending suggestions, exactly as the live path does
  update deedbox.suggested_entry
     set state = 'superseded_by_manual', resolved_at = now()
   where state = 'pending' and staff = v_staff
     and (id is distinct from null)
     and (matter = v_matter and proposed_date = (p_data ->> 'work_date')::date);
  perform deedbox.bulk_register(p_firm, p_actor, 'record.created', 'time_entry', v_id, v_matter,
    jsonb_build_object('staff', v_staff, 'value', v_value, 'kind', v_kind));
  insert into deedbox.source_reference (source_system, source_ref, target_type, target)
  values (p_system, p_ref, 'time_entry', v_id);
  return (p_ref, 'accepted', null, 'time_entry', v_id)::deedbox.bulk_outcome;
end $tim$;

create or replace function deedbox.bulk_apply_bills_record(
    p_firm bigint, p_actor bigint, p_batch bigint, p_system text,
    p_ref text, p_data jsonb)
returns deedbox.bulk_outcome language plpgsql as $bil$
declare
  v_hit record; v_ph record; v_issue_c bigint; v_line_c bigint := 0; v_run_c bigint := 0;
  v_matter bigint; v_payer bigint; v_group bigint; v_bill bigint;
  v_content text; v_art bigint; v_pos int := 0; v_l jsonb; v_e jsonb;
  v_due date; v_reason text;
begin
  select * into v_hit from deedbox.bulk_source_hit(p_system, p_ref, 'bill');
  if v_hit.o_target is not null then
    return (p_ref, 'accepted_with_warning', 'already imported; history never re-applies',
            null, null)::deedbox.bulk_outcome;
  end if;
  if jsonb_typeof(p_data -> 'journal') is distinct from 'array'
     or jsonb_array_length(p_data -> 'journal') = 0 then
    raise exception '%: an imported bill carries its journal history', p_ref;
  end if;
  if (p_data -> 'journal' -> 0 ->> 'kind') <> 'issue_total'
     or ((p_data -> 'journal' -> 0 ->> 'amount')::numeric) <= 0 then
    raise exception '%: the first journal entry is the positive issue total', p_ref;
  end if;
  v_issue_c := round((p_data -> 'journal' -> 0 ->> 'amount')::numeric * 100);
  if jsonb_typeof(p_data -> 'lines') is distinct from 'array'
     or jsonb_array_length(p_data -> 'lines') = 0 then
    raise exception '%: an imported bill carries at least one line', p_ref;
  end if;
  for v_l in select value from jsonb_array_elements(p_data -> 'lines') loop
    v_line_c := v_line_c + round((v_l ->> 'net')::numeric * 100)
                         + round((v_l ->> 'tax')::numeric * 100);
  end loop;
  if v_line_c <> v_issue_c then
    raise exception '%: lines sum to %s but the issue total is %s — the old record must reproduce to the cent',
      p_ref, to_char(v_line_c / 100.0, 'FM999999999990.00'),
      to_char(v_issue_c / 100.0, 'FM999999999990.00');
  end if;
  for v_e in select value from jsonb_array_elements(p_data -> 'journal') loop
    v_run_c := v_run_c + round((v_e ->> 'amount')::numeric * 100);
    if v_run_c < 0 then
      raise exception '%: the journal drives the balance below zero — route this record specially, never replay it',
        p_ref;
    end if;
  end loop;
  perform 1 from deedbox.bill b where b.bill_number = p_data ->> 'bill_number';
  if found then
    raise exception '%: a bill numbered % already exists', p_ref, p_data ->> 'bill_number';
  end if;
  v_matter := deedbox.bulk_record_matter(p_system, p_ref, p_data);
  if p_data ? 'payer_party' then
    v_payer := (p_data ->> 'payer_party')::bigint;
  elsif (p_data ->> 'payer_source_ref') is not null then
    select * into v_ph from deedbox.bulk_source_hit(p_system, p_data ->> 'payer_source_ref', 'party');
    if v_ph.o_target is null then
      raise exception '%: payer source reference % has not been imported',
        p_ref, p_data ->> 'payer_source_ref';
    end if;
    v_payer := v_ph.o_target;
  else
    select m.client_party into v_payer from deedbox.matter m where m.id = v_matter;
  end if;

  insert into deedbox.bill_group (matter, matter_total, payer_share_snapshot)
  values (v_matter, round(v_issue_c / 100.0, 2), '[]') returning id into v_group;
  insert into deedbox.bill (bill_group, matter, payer_party)
  values (v_group, v_matter, v_payer) returning id into v_bill;

  v_content := (jsonb_build_object(
    'document', 'legacy_bill', 'source_system', p_system, 'source_ref', p_ref,
    'bill_number', p_data ->> 'bill_number', 'issue_date', p_data ->> 'issue_date',
    'terms_days', (p_data ->> 'terms_days')::int, 'lines', p_data -> 'lines',
    'journal', p_data -> 'journal',
    'legacy_detail', coalesce(p_data -> 'legacy_detail', 'null'::jsonb)))::text;
  v_art := deedbox.bulk_artefact('legacy_bill_rendering', v_content, 'application/json');

  for v_l in select value from jsonb_array_elements(p_data -> 'lines') loop
    v_pos := v_pos + 1;
    insert into deedbox.bill_line
      (bill, position, kind, source_entry, description, original_value, amount,
       tax_treatment, tax_amount, category_key)
    values (v_bill, v_pos, 'manual', null, v_l ->> 'description',
            round((v_l ->> 'net')::numeric, 2), round((v_l ->> 'net')::numeric, 2),
            'standard', round((v_l ->> 'tax')::numeric, 2),
            coalesce(v_l ->> 'category_key', 'imported'));
  end loop;

  v_due := coalesce((p_data ->> 'due_date')::date,
                    ((p_data ->> 'issue_date')::date + (p_data ->> 'terms_days')::int));
  update deedbox.bill
     set state = 'issued', bill_number = p_data ->> 'bill_number',
         issue_date = (p_data ->> 'issue_date')::date,
         terms_days_applied = (p_data ->> 'terms_days')::int,
         due_date = v_due, rendered_artefact = v_art::text
   where id = v_bill;

  for v_e in select value from jsonb_array_elements(p_data -> 'journal') loop
    if (v_e ->> 'kind') = 'write_off' then
      v_reason := coalesce(nullif(trim(coalesce(v_e ->> 'reason', '')), ''),
                           'written off in the source system; no reason recorded there');
    else
      v_reason := nullif(trim(coalesce(v_e ->> 'reason', '')), '');
    end if;
    insert into deedbox.bill_journal_entry
      (bill, entry_kind, signed_amount, source_type, source, effective_date, entered_by, reason)
    values (v_bill, v_e ->> 'kind', round((v_e ->> 'amount')::numeric, 2), 'import',
            p_batch, (v_e ->> 'date')::date, p_actor, v_reason);
  end loop;

  perform deedbox.bulk_register(p_firm, p_actor, 'record.created', 'bill', v_bill, v_matter,
    jsonb_build_object(
      'import_batch', p_batch, 'source_ref', p_ref,
      'bill_number', p_data ->> 'bill_number',
      'issue_total', to_char(v_issue_c / 100.0, 'FM999999999990.00'),
      'outstanding', to_char(v_run_c / 100.0, 'FM999999999990.00')));
  insert into deedbox.source_reference (source_system, source_ref, target_type, target)
  values (p_system, p_ref, 'bill', v_bill);
  return (p_ref, 'accepted',
          format('outstanding %s', to_char(v_run_c / 100.0, 'FM999999999990.00')),
          'bill', v_bill)::deedbox.bulk_outcome;
end $bil$;

create or replace function deedbox.bulk_apply_other_record(
    p_firm bigint, p_actor bigint, p_batch bigint, p_system text,
    p_ref text, p_data jsonb)
returns deedbox.bulk_outcome language plpgsql as $oth$
declare v_hit record; v_matter bigint; v_status text; v_amount numeric; v_id bigint;
begin
  if (p_data ->> 'record_kind') is distinct from 'disbursement' then
    raise exception '%: unknown other-record kind %', p_ref, coalesce(p_data ->> 'record_kind', 'undefined');
  end if;
  select * into v_hit from deedbox.bulk_source_hit(p_system, p_ref, 'disbursement');
  if v_hit.o_target is not null then
    return (p_ref, 'accepted_with_warning', 'already imported; history never re-applies',
            null, null)::deedbox.bulk_outcome;
  end if;
  v_matter := deedbox.bulk_record_matter(p_system, p_ref, p_data);
  select m.status into v_status from deedbox.matter m where m.id = v_matter;
  if v_status = 'closed' or v_status = 'archived' then
    raise exception '%: unbilled costs import onto OPEN matters only — billed history rides its bill',
      p_ref;
  end if;
  v_amount := (p_data ->> 'amount')::numeric;
  if v_amount is null or v_amount <= 0 then
    raise exception '%: a disbursement needs its amount above zero', p_ref;
  end if;
  insert into deedbox.disbursement
    (matter, incurred_date, description, amount, tax_treatment, billable, cost_type, created_by)
  values (v_matter, (p_data ->> 'incurred_date')::date, p_data ->> 'description',
          round(v_amount, 2), coalesce(p_data ->> 'tax_treatment', 'standard'), true, null, p_actor)
  returning id into v_id;
  insert into deedbox.source_reference (source_system, source_ref, target_type, target)
  values (p_system, p_ref, 'disbursement', v_id);
  return (p_ref, 'accepted', null, 'disbursement', v_id)::deedbox.bulk_outcome;
end $oth$;

create or replace function deedbox.bulk_apply_documents_record(
    p_firm bigint, p_actor bigint, p_batch bigint, p_system text,
    p_ref text, p_data jsonb)
returns deedbox.bulk_outcome language plpgsql as $doc$
declare
  v_kind text := p_data ->> 'record_kind';
  v_hit record; v_matter bigint; v_by bigint; v_folder bigint := null;
  v_versions jsonb; v_first jsonb; v_file bigint; v_doc bigint; v_ver bigint;
  v_title text; v_i int; v_v jsonb;
begin
  if v_kind = 'folder' then
    select * into v_hit from deedbox.bulk_source_hit(p_system, p_ref, 'document_folder');
    if v_hit.o_target is not null then
      return (p_ref, 'accepted_with_warning', 'already imported; history never re-applies',
              null, null)::deedbox.bulk_outcome;
    end if;
    if trim(coalesce(p_data ->> 'path', '')) = '' then
      raise exception '%: a folder record names its path', p_ref;
    end if;
    v_matter := deedbox.bulk_record_matter(p_system, p_ref, p_data);
    v_by := deedbox.bulk_import_staff(p_actor, p_ref, p_data ->> 'created_by_login');
    v_folder := deedbox.bulk_ensure_folder_path(p_firm, p_actor, p_batch,
      v_matter, p_data ->> 'path', v_by);
    insert into deedbox.source_reference (source_system, source_ref, target_type, target)
    values (p_system, p_ref, 'document_folder', v_folder);
    return (p_ref, 'accepted', null, 'document_folder', v_folder)::deedbox.bulk_outcome;
  end if;
  if v_kind is distinct from 'document' then
    raise exception '%: unknown documents-record kind %', p_ref, coalesce(v_kind, 'undefined');
  end if;
  select * into v_hit from deedbox.bulk_source_hit(p_system, p_ref, 'document');
  if v_hit.o_target is not null then
    return (p_ref, 'accepted_with_warning', 'already imported; history never re-applies',
            null, null)::deedbox.bulk_outcome;
  end if;
  v_versions := coalesce(p_data -> 'versions', '[]'::jsonb);
  if jsonb_array_length(v_versions) = 0 then
    raise exception '%: a document record carries at least one version', p_ref;
  end if;
  v_matter := deedbox.bulk_record_matter(p_system, p_ref, p_data);
  v_by := deedbox.bulk_import_staff(p_actor, p_ref, p_data ->> 'created_by_login');
  if trim(coalesce(p_data ->> 'folder_path', '')) <> '' then
    v_folder := deedbox.bulk_ensure_folder_path(p_firm, p_actor, p_batch,
      v_matter, p_data ->> 'folder_path', v_by);
  end if;
  v_first := v_versions -> 0;

  insert into deedbox.document_file
    (matter, filename, content_type, size_bytes, storage_ref, source, uploaded_by, uploaded_at)
  values (v_matter, v_first ->> 'filename',
          coalesce(v_first ->> 'content_type', 'application/octet-stream'),
          (v_first ->> 'size_bytes')::bigint, v_first ->> 'storage_ref', 'import', v_by,
          coalesce((v_first ->> 'uploaded_at')::timestamptz, now()))
  returning id into v_file;
  v_title := trim(coalesce(p_data ->> 'title', v_first ->> 'filename'));
  insert into deedbox.document
    (matter, folder, title, description, document_date, confidential,
     current_file, current_version, created_by, created_at)
  values (v_matter, v_folder, v_title, p_data ->> 'description',
          (p_data ->> 'document_date')::date,
          coalesce((p_data ->> 'confidential')::boolean, false), v_file, 1, v_by,
          coalesce((p_data ->> 'created_at')::timestamptz,
                   (v_first ->> 'uploaded_at')::timestamptz, now()))
  returning id into v_doc;
  insert into deedbox.document_version (document, version_no, file, comment, created_by, created_at)
  values (v_doc, 1, v_file, v_first ->> 'comment', v_by,
          coalesce((p_data ->> 'created_at')::timestamptz,
                   (v_first ->> 'uploaded_at')::timestamptz, now()))
  returning id into v_ver;
  perform deedbox.bulk_sync_document_text(v_doc);
  perform deedbox.bulk_register(p_firm, p_actor, 'record.created', 'document', v_doc, null,
    jsonb_build_object('matter', v_matter, 'folder', v_folder, 'title', v_title,
      'filename', v_first ->> 'filename', 'file', v_file, 'source', 'import',
      'import_batch', p_batch));
  if v_first ? 'extracted_text' then
    perform deedbox.bulk_write_version_text(v_ver, v_doc, v_first ->> 'extracted_text', 'embedded');
  end if;

  for v_i in 1 .. jsonb_array_length(v_versions) - 1 loop
    v_v := v_versions -> v_i;
    insert into deedbox.document_file
      (matter, filename, content_type, size_bytes, storage_ref, source, uploaded_by, uploaded_at)
    values (v_matter, v_v ->> 'filename',
            coalesce(v_v ->> 'content_type', 'application/octet-stream'),
            (v_v ->> 'size_bytes')::bigint, v_v ->> 'storage_ref', 'import', v_by,
            coalesce((v_v ->> 'uploaded_at')::timestamptz, now()))
    returning id into v_file;
    insert into deedbox.document_version (document, version_no, file, comment, created_by, created_at)
    values (v_doc, v_i + 1, v_file, v_v ->> 'comment', v_by,
            coalesce((v_v ->> 'uploaded_at')::timestamptz, now()))
    returning id into v_ver;
    update deedbox.document set current_file = v_file, current_version = v_i + 1
     where id = v_doc;
    if v_v ? 'extracted_text' then
      perform deedbox.bulk_write_version_text(v_ver, v_doc, v_v ->> 'extracted_text', 'embedded');
    end if;
  end loop;

  insert into deedbox.source_reference (source_system, source_ref, target_type, target)
  values (p_system, p_ref, 'document', v_doc);
  return (p_ref, 'accepted', null, 'document', v_doc)::deedbox.bulk_outcome;
end $doc$;

create or replace function deedbox.bulk_apply_notes_record(
    p_firm bigint, p_actor bigint, p_batch bigint, p_system text,
    p_ref text, p_data jsonb)
returns deedbox.bulk_outcome language plpgsql as $not$
declare v_hit record; v_matter bigint; v_author bigint := null; v_id bigint; v_detail jsonb;
begin
  select * into v_hit from deedbox.bulk_source_hit(p_system, p_ref, 'note');
  if v_hit.o_target is not null then
    return (p_ref, 'accepted_with_warning', 'already imported; history never re-applies',
            null, null)::deedbox.bulk_outcome;
  end if;
  if trim(coalesce(p_data ->> 'body', '')) = '' then
    raise exception '%: a note needs text', p_ref;
  end if;
  v_matter := deedbox.bulk_record_matter(p_system, p_ref, p_data);
  if (p_data ->> 'author_login') is not null then
    select s.id into v_author from deedbox.staff_member s where s.login = p_data ->> 'author_login';
    if v_author is null then
      raise exception '%: no staff member with login %', p_ref, p_data ->> 'author_login';
    end if;
  end if;
  insert into deedbox.note (owner_type, owner, body, noted_at, author)
  values ('matter', v_matter, p_data ->> 'body',
          coalesce((p_data ->> 'noted_at')::timestamptz, now()), v_author)
  returning id into v_id;
  v_detail := jsonb_build_object('import_batch', p_batch);
  if (p_data ->> 'author_login') is not null then
    v_detail := v_detail || jsonb_build_object('author_login', p_data ->> 'author_login');
  end if;
  perform deedbox.bulk_register(p_firm, p_actor, 'record.created', 'note', v_id, v_matter, v_detail);
  insert into deedbox.source_reference (source_system, source_ref, target_type, target)
  values (p_system, p_ref, 'note', v_id);
  return (p_ref, 'accepted', null, 'note', v_id)::deedbox.bulk_outcome;
end $not$;

-- ---------------------------------------------------------------------------
-- Client money, full-history replay (applyMoneyFullHistory, ported).
-- All-or-nothing: any integrity failure re-raises carrying the itemised
-- outcomes in the error DETAIL, so the caller can commit the refused-batch
-- evidence in its own transaction. Opening balances are NOT yet bulk — that
-- mode refuses loudly and stays on the per-record path until a firm needs it.
-- ---------------------------------------------------------------------------

create or replace function deedbox.bulk_money_replay(
    p_firm bigint, p_actor bigint, p_batch bigint, p_system text,
    p_account bigint, p_key text)
returns deedbox.bulk_outcome[] language plpgsql as $mon$
declare
  v_outs deedbox.bulk_outcome[] := '{}'::deedbox.bulk_outcome[];
  v_r record; v_hit record; v_auth bigint := null;
begin
  for v_r in select r.source_ref, r.data from deedbox.import_staging_record r
              where r.batch_key = p_key
              order by (r.data ->> 'entered_at'), r.seq loop
    begin
      declare
        v_amount numeric := (v_r.data ->> 'amount')::numeric;
        v_kind text := v_r.data ->> 'kind';
        v_matter bigint; v_ledger bigint; v_lstatus text;
        v_num text; v_seq bigint; v_txn bigint; v_content text; v_art bigint;
      begin
        select * into v_hit from deedbox.bulk_source_hit(p_system, v_r.source_ref, 'money_transaction');
        if v_hit.o_target is not null then
          v_outs := v_outs || (v_r.source_ref, 'accepted_with_warning', 'already imported',
                               null, null)::deedbox.bulk_outcome;
          continue;
        end if;
        if v_amount is null or not (v_amount > 0) then
          raise exception 'movement %: amounts are positive; kind carries direction', v_r.source_ref;
        end if;
        if v_r.data ? 'matter' then
          v_matter := (v_r.data ->> 'matter')::bigint;
        elsif (v_r.data ->> 'matter_source_ref') is not null then
          select h.o_target into v_matter
            from deedbox.bulk_source_hit(p_system, v_r.data ->> 'matter_source_ref', 'matter') h;
          if v_matter is null then
            raise exception 'movement %: matter source reference % has not been imported',
              v_r.source_ref, v_r.data ->> 'matter_source_ref';
          end if;
        else
          raise exception 'movement % names no matter', v_r.source_ref;
        end if;
        select l.id, l.status into v_ledger, v_lstatus from deedbox.matter_ledger l
         where l.matter = v_matter and l.account = p_account and l.ledger_kind = 'client_matter';
        if v_ledger is not null then
          if v_lstatus <> 'open' then
            raise exception 'the ledger is closed — reopen it before receipting; settlement is never silently rerouted'
              using hint = 'integrity_refusal';
          end if;
        else
          insert into deedbox.matter_ledger (account, matter) values (p_account, v_matter)
          returning id into v_ledger;
          perform deedbox.bulk_register(p_firm, p_actor, 'record.created', 'matter_ledger',
            v_ledger, v_matter,
            jsonb_build_object('account', p_account, 'opened_on_first_receipt', true));
        end if;
        perform 1 from deedbox.matter_ledger l where l.id = v_ledger for update;

        if v_kind = 'receipt' then
          select deedbox.allocate_number('money_receipt') into v_num;
          v_seq := nullif(regexp_replace(v_num, '^[^0-9]+', ''), '')::bigint;
          select deedbox.post_money_transaction(
            'receipt', (v_r.data ->> 'effective_date')::date, p_actor,
            'money_receipt_number', v_seq,
            jsonb_build_array(
              jsonb_build_object('side', 'cash_book', 'account', p_account,
                                 'signed_amount', v_amount),
              jsonb_build_object('side', 'matter_ledger', 'account', p_account,
                                 'matter_ledger', v_ledger, 'signed_amount', v_amount)),
            null, null, null, (v_r.data ->> 'entered_at')::timestamptz)
          into v_txn;
          v_content := (jsonb_build_object(
            'document', 'money_receipt', 'receipt_number', v_num, 'amount', v_amount,
            'method', coalesce(v_r.data ->> 'method', 'electronic_transfer'),
            'imported_from', p_system, 'source_ref', v_r.source_ref))::text;
          v_art := deedbox.bulk_artefact('money_receipt_rendering', v_content, 'application/json');
          insert into deedbox.money_receipt
            (matter_ledger, receipt_number, payer_description, method,
             received_date, amount, transaction, printable_artefact)
          values (v_ledger, v_num,
                  coalesce(v_r.data ->> 'payer_description', format('imported from %s', p_system)),
                  coalesce(v_r.data ->> 'method', 'electronic_transfer'),
                  (v_r.data ->> 'effective_date')::date, v_amount, v_txn, v_art::text);
        else
          if v_auth is null then
            insert into deedbox.payment_authorisation
              (subject_type, subject, authoriser, decision, note)
            values ('money_payment', p_batch, p_actor, 'approved',
                    format('money history import from %s (batch %s)', p_system, p_batch))
            returning id into v_auth;
          end if;
          select deedbox.post_money_transaction(
            'payment_out', (v_r.data ->> 'effective_date')::date, p_actor,
            'import_batch', p_batch,
            jsonb_build_array(
              jsonb_build_object('side', 'cash_book', 'account', p_account,
                                 'signed_amount', -v_amount),
              jsonb_build_object('side', 'matter_ledger', 'account', p_account,
                                 'matter_ledger', v_ledger, 'signed_amount', -v_amount)),
            coalesce(v_r.data ->> 'reason',
                     format('imported payment %s (%s)', v_r.source_ref,
                            coalesce(v_r.data ->> 'payee', 'payee unrecorded'))),
            v_auth, null, (v_r.data ->> 'entered_at')::timestamptz)
          into v_txn;
        end if;
        perform deedbox.bulk_register(p_firm, p_actor, 'money.transaction_posted',
          'money_transaction', v_txn, v_matter,
          jsonb_build_object('kind', v_kind, 'amount', v_amount,
                             'import_batch', p_batch, 'source_ref', v_r.source_ref));
        insert into deedbox.source_reference (source_system, source_ref, target_type, target)
        values (p_system, v_r.source_ref, 'money_transaction', v_txn);
        v_outs := v_outs || (v_r.source_ref, 'accepted', null,
                             'money_transaction', v_txn)::deedbox.bulk_outcome;
      end;
    exception when sqlstate 'P0V46' then
      raise;
    when others then
      declare v_msg text := sqlerrm; v_hint text;
      begin
        get stacked diagnostics v_hint = pg_exception_hint;
        raise exception '%', v_msg
          using detail = (to_jsonb(v_outs))::text, hint = coalesce(v_hint, '');
      end;
    end;
  end loop;
  return v_outs;
end $mon$;

-- ---------------------------------------------------------------------------
-- Shared shapes for reports and counts.
-- ---------------------------------------------------------------------------

create or replace function deedbox.bulk_counts(p_outs deedbox.bulk_outcome[])
returns jsonb language sql as $cnt$
  select coalesce(jsonb_object_agg(s.d, s.n), '{}'::jsonb)
    from (select o.disposition as d, count(*) as n
            from unnest(p_outs) o group by o.disposition) s;
$cnt$;

create or replace function deedbox.bulk_outcomes_from_jsonb(p jsonb)
returns deedbox.bulk_outcome[] language sql as $ofj$
  select coalesce(array_agg((e ->> 'source_ref', e ->> 'disposition', e ->> 'message',
                             e ->> 'target_type', (e ->> 'target')::bigint)::deedbox.bulk_outcome),
                  '{}'::deedbox.bulk_outcome[])
    from jsonb_array_elements(p) e;
$ofj$;

-- Non-accepted outcomes survive as decided; accepted ones did not survive the
-- aborted replay and say so; the batch-level refusal closes the report.
create or replace function deedbox.bulk_remap_refused(
    p_outs deedbox.bulk_outcome[], p_message text)
returns deedbox.bulk_outcome[] language sql as $rmr$
  select coalesce(
           (select array_agg(o) from unnest(p_outs) o where o.disposition <> 'accepted'),
           '{}'::deedbox.bulk_outcome[])
      || coalesce(
           (select array_agg((o.source_ref, 'refused',
                              'rolled back: a later movement refused the batch',
                              null, null)::deedbox.bulk_outcome)
              from unnest(p_outs) o where o.disposition = 'accepted'),
           '{}'::deedbox.bulk_outcome[])
      || array[('(batch)', 'refused', p_message, null, null)::deedbox.bulk_outcome];
$rmr$;

-- ---------------------------------------------------------------------------
-- The dispatcher and the orchestrator.
-- ---------------------------------------------------------------------------

create or replace function deedbox.bulk_apply_one(
    p_domain text, p_firm bigint, p_actor bigint, p_batch bigint, p_system text,
    p_ref text, p_data jsonb)
returns deedbox.bulk_outcome language plpgsql as $one$
begin
  case p_domain
    when 'clients' then
      return deedbox.bulk_apply_clients_record(p_firm, p_actor, p_batch, p_system, p_ref, p_data);
    when 'matters' then
      return deedbox.bulk_apply_matters_record(p_firm, p_actor, p_batch, p_system, p_ref, p_data);
    when 'time' then
      return deedbox.bulk_apply_time_record(p_firm, p_actor, p_batch, p_system, p_ref, p_data);
    when 'bills' then
      return deedbox.bulk_apply_bills_record(p_firm, p_actor, p_batch, p_system, p_ref, p_data);
    when 'other' then
      return deedbox.bulk_apply_other_record(p_firm, p_actor, p_batch, p_system, p_ref, p_data);
    when 'documents' then
      return deedbox.bulk_apply_documents_record(p_firm, p_actor, p_batch, p_system, p_ref, p_data);
    when 'notes' then
      return deedbox.bulk_apply_notes_record(p_firm, p_actor, p_batch, p_system, p_ref, p_data);
    else
      raise exception 'no applier exists for the % record domain', p_domain;
  end case;
end $one$;

create or replace function deedbox.bulk_apply(
    p_domain text, p_system text, p_key text, p_mode text,
    p_migration bigint, p_actor bigint, p_firm bigint, p_account bigint default null)
returns setof deedbox.bulk_outcome language plpgsql as $ap$
declare
  v_outs deedbox.bulk_outcome[] := '{}'::deedbox.bulk_outcome[];
  v_o deedbox.bulk_outcome; v_r record; v_batch bigint;
  v_counts jsonb; v_art bigint; v_content text;
begin
  if not deedbox.bulk_has_capability(p_actor, 'import.execute') then
    raise exception 'this operation requires import.execute';
  end if;
  if p_mode <> 'validate_only' and p_mode <> 'real' then
    raise exception 'unknown batch mode %', p_mode;
  end if;
  if p_domain = 'client_money_opening_balances' then
    raise exception 'client_money_opening_balances is not yet a bulk domain — use the per-record path';
  end if;

  if p_domain = 'client_money_full_history' then
    if p_account is null then
      raise exception 'full-history batches carry the account';
    end if;
    if p_mode = 'validate_only' then
      begin
        insert into deedbox.import_batch (migration, mapping, record_domain, mode, source_system)
        values (p_migration, null, p_domain, 'validate_only', p_system) returning id into v_batch;
        v_outs := deedbox.bulk_money_replay(p_firm, p_actor, v_batch, p_system, p_account, p_key);
        v_counts := deedbox.bulk_counts(v_outs);
        v_content := (jsonb_build_object('batch', v_batch, 'mode', 'validate_only',
          'record_domain', p_domain, 'source_system', p_system,
          'outcomes', to_jsonb(v_outs), 'boundary_reconciliation', null))::text;
        v_art := deedbox.bulk_artefact('import_batch_report', v_content, 'application/json');
        insert into deedbox.import_record (batch, source_ref, disposition, message, target_type, target)
        select v_batch, o.source_ref, o.disposition, o.message, o.target_type, o.target
          from unnest(v_outs) o;
        update deedbox.import_batch
           set state = 'completed', report_artefact = v_art::text, counts = v_counts,
               finished_at = now()
         where id = v_batch;
        perform deedbox.bulk_register(p_firm, p_actor, 'import.batch_applied', 'import_batch',
          v_batch, null,
          jsonb_build_object('mode', 'validate_only', 'validate', true,
                             'record_domain', p_domain, 'counts', v_counts),
          v_art::text);
        raise exception 'validate-only pipeline rolled back by design' using errcode = 'P0V46';
      exception
        when sqlstate 'P0V46' then
          v_counts := deedbox.bulk_counts(v_outs);
          v_content := (jsonb_build_object('mode', 'validate_only', 'record_domain', p_domain,
            'source_system', p_system, 'state', 'completed', 'outcomes', to_jsonb(v_outs)))::text;
          v_art := deedbox.bulk_artefact('import_batch_report', v_content, 'application/json');
          insert into deedbox.import_batch
            (migration, mapping, record_domain, mode, state, report_artefact, counts,
             source_system, finished_at)
          values (p_migration, null, p_domain, 'validate_only', 'completed', v_art::text,
                  v_counts, p_system, now()) returning id into v_batch;
          insert into deedbox.import_record (batch, source_ref, disposition, message, target_type, target)
          select v_batch, o.source_ref, o.disposition, o.message, o.target_type, o.target
            from unnest(v_outs) o;
          perform deedbox.bulk_register(p_firm, p_actor, 'import.batch_applied', 'import_batch',
            v_batch, null,
            jsonb_build_object('mode', 'validate_only', 'validate', true, 'state', 'completed',
                               'counts', v_counts),
            v_art::text);
        when others then
          declare v_msg text := sqlerrm; v_dtl text;
          begin
            get stacked diagnostics v_dtl = pg_exception_detail;
            v_outs := deedbox.bulk_remap_refused(
              deedbox.bulk_outcomes_from_jsonb(coalesce(nullif(v_dtl, ''), '[]')::jsonb), v_msg);
            v_counts := deedbox.bulk_counts(v_outs);
            v_content := (jsonb_build_object('mode', 'validate_only', 'record_domain', p_domain,
              'source_system', p_system, 'state', 'refused', 'outcomes', to_jsonb(v_outs)))::text;
            v_art := deedbox.bulk_artefact('import_batch_report', v_content, 'application/json');
            insert into deedbox.import_batch
              (migration, mapping, record_domain, mode, state, report_artefact, counts,
               source_system, finished_at)
            values (p_migration, null, p_domain, 'validate_only', 'refused', v_art::text,
                    v_counts, p_system, now()) returning id into v_batch;
            insert into deedbox.import_record (batch, source_ref, disposition, message, target_type, target)
            select v_batch, o.source_ref, o.disposition, o.message, o.target_type, o.target
              from unnest(v_outs) o;
            perform deedbox.bulk_register(p_firm, p_actor, 'record.created', 'import_batch',
              v_batch, null,
              jsonb_build_object('mode', 'validate_only', 'validate', true, 'state', 'refused',
                                 'counts', v_counts),
              v_art::text);
          end;
      end;
      return query select * from unnest(v_outs);
      return;
    end if;
    -- real money: one transaction holds everything; a refusal re-raises out
    -- of this call carrying the outcomes, and the caller records the refused
    -- batch through bulk_record_money_refusal in its own transaction.
    insert into deedbox.import_batch (migration, mapping, record_domain, mode, source_system)
    values (p_migration, null, p_domain, 'real', p_system) returning id into v_batch;
    v_outs := deedbox.bulk_money_replay(p_firm, p_actor, v_batch, p_system, p_account, p_key);
    v_counts := deedbox.bulk_counts(v_outs);
    v_content := (jsonb_build_object('batch', v_batch, 'mode', 'real',
      'record_domain', p_domain, 'source_system', p_system,
      'outcomes', to_jsonb(v_outs), 'boundary_reconciliation', null))::text;
    v_art := deedbox.bulk_artefact('import_batch_report', v_content, 'application/json');
    insert into deedbox.import_record (batch, source_ref, disposition, message, target_type, target)
    select v_batch, o.source_ref, o.disposition, o.message, o.target_type, o.target
      from unnest(v_outs) o;
    update deedbox.import_batch
       set state = 'completed', report_artefact = v_art::text, counts = v_counts,
           finished_at = now()
     where id = v_batch;
    perform deedbox.bulk_register(p_firm, p_actor, 'import.batch_applied', 'import_batch',
      v_batch, null,
      jsonb_build_object('mode', 'real', 'validate', false, 'record_domain', p_domain,
                         'counts', v_counts),
      v_art::text);
    return query select * from unnest(v_outs);
    return;
  end if;

  if p_domain not in ('clients','matters','time','bills','other','documents','notes') then
    raise exception 'no applier exists for the % record domain', p_domain;
  end if;
  if not exists (select 1 from deedbox.import_staging_record r where r.batch_key = p_key) then
    raise exception 'an import batch carries at least one record';
  end if;
  -- An archive lands on closed matters — that is the point of an archive —
  -- and the schema rightly demands the edit-closed ceremony for document
  -- writes there. The import batch IS the deliberate act (per-record path's
  -- own posture). Set before any savepoint so it survives per-record rollbacks.
  if p_domain = 'documents' then
    perform set_config('deedbox.edit_closed', 'on', true);
  end if;

  if p_mode = 'validate_only' then
    begin
      for v_r in select r.source_ref, r.data from deedbox.import_staging_record r
                  where r.batch_key = p_key order by r.seq loop
        begin
          v_o := deedbox.bulk_apply_one(p_domain, p_firm, p_actor, 0, p_system,
                                        v_r.source_ref, v_r.data);
        exception when others then
          v_o := (v_r.source_ref, 'refused', sqlerrm, null, null)::deedbox.bulk_outcome;
        end;
        v_outs := v_outs || v_o;
      end loop;
      raise exception 'validate-only pipeline rolled back by design' using errcode = 'P0V46';
    exception when sqlstate 'P0V46' then
      null;
    end;
    v_counts := deedbox.bulk_counts(v_outs);
    v_content := (jsonb_build_object('mode', 'validate_only', 'record_domain', p_domain,
      'source_system', p_system, 'outcomes', to_jsonb(v_outs)))::text;
    v_art := deedbox.bulk_artefact('import_batch_report', v_content, 'application/json');
    insert into deedbox.import_batch
      (migration, mapping, record_domain, mode, state, report_artefact, counts,
       source_system, finished_at)
    values (p_migration, null, p_domain, 'validate_only', 'completed', v_art::text,
            v_counts, p_system, now()) returning id into v_batch;
    insert into deedbox.import_record (batch, source_ref, disposition, message, target_type, target)
    select v_batch, o.source_ref, o.disposition, o.message, o.target_type, o.target
      from unnest(v_outs) o;
    perform deedbox.bulk_register(p_firm, p_actor, 'import.batch_applied', 'import_batch',
      v_batch, null,
      jsonb_build_object('mode', 'validate_only', 'validate', true, 'record_domain', p_domain,
                         'counts', v_counts),
      v_art::text);
    return query select * from unnest(v_outs);
    return;
  end if;

  insert into deedbox.import_batch (migration, mapping, record_domain, mode, source_system)
  values (p_migration, null, p_domain, 'real', p_system) returning id into v_batch;
  for v_r in select r.source_ref, r.data from deedbox.import_staging_record r
              where r.batch_key = p_key order by r.seq loop
    begin
      v_o := deedbox.bulk_apply_one(p_domain, p_firm, p_actor, v_batch, p_system,
                                    v_r.source_ref, v_r.data);
      insert into deedbox.import_record (batch, source_ref, disposition, message, target_type, target)
      values (v_batch, v_o.source_ref, v_o.disposition, v_o.message, v_o.target_type, v_o.target);
    exception when others then
      v_o := (v_r.source_ref, 'refused', sqlerrm, null, null)::deedbox.bulk_outcome;
      insert into deedbox.import_record (batch, source_ref, disposition, message, target_type, target)
      values (v_batch, v_o.source_ref, v_o.disposition, v_o.message, v_o.target_type, v_o.target);
    end;
    v_outs := v_outs || v_o;
  end loop;
  v_counts := deedbox.bulk_counts(v_outs);
  v_content := (jsonb_build_object('batch', v_batch, 'mode', 'real', 'record_domain', p_domain,
    'source_system', p_system, 'outcomes', to_jsonb(v_outs)))::text;
  v_art := deedbox.bulk_artefact('import_batch_report', v_content, 'application/json');
  update deedbox.import_batch
     set state = 'completed', report_artefact = v_art::text, counts = v_counts,
         finished_at = now()
   where id = v_batch;
  perform deedbox.bulk_register(p_firm, p_actor, 'import.batch_applied', 'import_batch',
    v_batch, null,
    jsonb_build_object('mode', 'real', 'record_domain', p_domain, 'counts', v_counts),
    v_art::text);
  return query select * from unnest(v_outs);
end $ap$;

-- The refusal-capture protocol's second transaction, for a REAL money batch
-- the replay refused: the permanent refused_operation row, its register
-- entry, and the refused batch row with the itemised report. The caller
-- passes the outcomes carried in the raise's DETAIL and the reason
-- classified by the engine's own rules.
create or replace function deedbox.bulk_record_money_refusal(
    p_system text, p_migration bigint, p_actor bigint, p_firm bigint,
    p_account bigint, p_reason text, p_message text, p_outcomes jsonb)
returns bigint language plpgsql as $ref$
declare
  v_rid bigint; v_outs deedbox.bulk_outcome[]; v_counts jsonb;
  v_content text; v_art bigint; v_batch bigint;
begin
  insert into deedbox.refused_operation
    (account, matter_ledger, attempted_operation, refusal_reason,
     attempted_by_kind, attempted_by)
  values (p_account, null,
          jsonb_build_object('operation',
            jsonb_build_object('import_batch', 'client_money_full_history'),
            'message', p_message),
          p_reason, 'staff', p_actor)
  returning id into v_rid;
  perform deedbox.bulk_register(p_firm, p_actor, 'money.refusal_recorded', 'refused_operation',
    v_rid, null, jsonb_build_object('reason', p_reason, 'message', p_message));
  v_outs := deedbox.bulk_remap_refused(deedbox.bulk_outcomes_from_jsonb(p_outcomes), p_message);
  v_counts := deedbox.bulk_counts(v_outs);
  v_content := (jsonb_build_object('mode', 'real', 'record_domain', 'client_money_full_history',
    'source_system', p_system, 'state', 'refused', 'outcomes', to_jsonb(v_outs)))::text;
  v_art := deedbox.bulk_artefact('import_batch_report', v_content, 'application/json');
  insert into deedbox.import_batch
    (migration, mapping, record_domain, mode, state, report_artefact, counts,
     source_system, finished_at)
  values (p_migration, null, 'client_money_full_history', 'real', 'refused', v_art::text,
          v_counts, p_system, now()) returning id into v_batch;
  insert into deedbox.import_record (batch, source_ref, disposition, message, target_type, target)
  select v_batch, o.source_ref, o.disposition, o.message, o.target_type, o.target
    from unnest(v_outs) o;
  perform deedbox.bulk_register(p_firm, p_actor, 'record.created', 'import_batch', v_batch, null,
    jsonb_build_object('mode', 'real', 'validate', false, 'state', 'refused', 'counts', v_counts),
    v_art::text);
  return v_batch;
end $ref$;

commit;
