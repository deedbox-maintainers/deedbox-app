-- 0024_config_admin_write_paths — the configuration screens' missing write
-- paths. Runs as the deployment role.
--
-- Found by the screens stage (the administration operations have no consumers
-- until the configuration screens exist, so the gaps surfaced only now):
--
--   1. create_or_replace_number_format had NO write path: number_format
--      is app-read-only and sequence_counter deliberately carries no app
--      grants at all. The replacement operation must supersede the active
--      format AND carry the series forward (a replacement never renumbers
--      and never restarts a gapless series), which touches the counter
--      table — so the whole number-format write set lands here as ONE security-
--      definer function, mirroring allocate_number's posture: the app role
--      holds execute on the function and still no direct table access.
--
--   2. 2. delete_unused_item needs DELETE on choice_item, which 0002 granted
--      only select/insert/update. The guard trigger (shipped items never
--      deleted) and the operation's zero-usage check stand in front.

------------------------------------------------------------------------------
-- 1. replace_number_format — the whole replacement as one atomic act in the caller's txn.
------------------------------------------------------------------------------
create or replace function deedbox.replace_number_format(
    p_purpose deedbox.number_purpose,
    p_scope text,
    p_pattern text,
    p_mode text,
    p_reset text,
    p_actor_kind text,
    p_actor bigint,
    p_session bigint default null
) returns bigint
security definer set search_path = deedbox, pg_temp
language plpgsql as $$
declare
  old_row deedbox.number_format%rowtype;
  new_id bigint;
  f bigint;
  seq_last bigint;
  seq_called boolean;
  seed bigint;
begin
  -- grammar checks: a serial token always; yearly reset demands the
  -- year in the rendered number or partitions would collide across years.
  if p_pattern !~ '\{SEQ:\d+\}' then
    raise exception 'number format refused: pattern must contain a {SEQ:n} token';
  end if;
  if p_reset = 'yearly' and position('{YEAR}' in p_pattern) = 0 then
    raise exception 'number format refused: a yearly-reset pattern must contain {YEAR}';
  end if;
  if p_mode not in ('sequence','gapless') then
    raise exception 'number format refused: unknown allocation mode %', p_mode;
  end if;
  if p_reset not in ('never','yearly') then
    raise exception 'number format refused: unknown reset rule %', p_reset;
  end if;

  select * into old_row from deedbox.number_format
   where purpose = p_purpose and active
     and coalesce(scope,'') = coalesce(p_scope,'')
   for update;

  if found then
    update deedbox.number_format set active = false where id = old_row.id;
  end if;

  insert into deedbox.number_format (purpose, scope, pattern, allocation_mode, reset)
  values (p_purpose, p_scope, p_pattern, p_mode, p_reset)
  returning id into new_id;

  -- Series continuation: a format change NEVER renumbers and NEVER restarts
  -- the stream. The next value carries across shape changes.
  if found then
    if old_row.allocation_mode = 'gapless' then
      -- carry every partition forward; a reset-rule change collapses or
      -- seeds partitions from the highest value so no number can repeat.
      if p_reset = old_row.reset then
        insert into deedbox.sequence_counter (format, partition, next_value)
        select new_id, partition, next_value
          from deedbox.sequence_counter where format = old_row.id;
      else
        select coalesce(max(next_value), 1) into seed
          from deedbox.sequence_counter where format = old_row.id;
        if p_mode = 'gapless' then
          insert into deedbox.sequence_counter (format, partition, next_value)
          values (new_id, case when p_reset = 'yearly'
                               then to_char(current_date, 'YYYY') else '' end, seed);
        end if;
      end if;
      if p_mode = 'sequence' then
        select coalesce(max(next_value), 1) into seed
          from deedbox.sequence_counter where format = old_row.id;
        execute format('select setval(''deedbox.numseq_%s'', %s, false)', new_id, seed);
      end if;
    else
      execute format('select last_value, is_called from deedbox.numseq_%s', old_row.id)
        into seq_last, seq_called;
      seed := case when seq_called then seq_last + 1 else seq_last end;
      if p_mode = 'sequence' then
        execute format('select setval(''deedbox.numseq_%s'', %s, false)', new_id, seed);
      else
        insert into deedbox.sequence_counter (format, partition, next_value)
        values (new_id, case when p_reset = 'yearly'
                             then to_char(current_date, 'YYYY') else '' end, seed);
      end if;
    end if;
  end if;

  select id into f from deedbox.firm limit 1;
  if f is not null then
    insert into deedbox.register_entry
      (firm, actor_kind, actor, session_ref, event_kind, subject_type, subject, detail)
    values (f, p_actor_kind, p_actor, p_session, 'numbering.format_changed',
            'number_format', new_id,
            jsonb_build_object(
              'before', case when old_row.id is null then null else jsonb_build_object(
                'format', old_row.id, 'pattern', old_row.pattern,
                'allocation_mode', old_row.allocation_mode, 'reset', old_row.reset) end,
              'after', jsonb_build_object(
                'format', new_id, 'pattern', p_pattern,
                'allocation_mode', p_mode, 'reset', p_reset),
              'purpose', p_purpose::text, 'scope', p_scope));
  end if;

  return new_id;
end $$;

grant execute on function deedbox.replace_number_format(
  deedbox.number_purpose, text, text, text, text, text, bigint, bigint) to deedbox_app;

------------------------------------------------------------------------------
-- 2. 2. activate_pack becomes security definer — a schema defect found by
--    application testing. 0002's function ran with the CALLER's rights, but
--    the app role holds only SELECT on country_pack, so the one sanctioned
--    activation path was permission-refused for every real principal. The
--    schema suites ran it as the deployment role and never met the gap (the
--    0018/0019 class). Body unchanged except the definer posture and the
--    pinned search path.
------------------------------------------------------------------------------
create or replace function deedbox.activate_pack(p_pack bigint, p_version bigint,
                                                 p_actor_kind text, p_actor bigint)
returns void
security definer set search_path = deedbox, pg_temp
language plpgsql as $$
declare bad bigint; old_version bigint; f bigint;
begin
  select count(*) into bad
    from deedbox.pack_declaration d
    left join deedbox.rule_point rp
      on rp.key = d.rule_point
      or (rp.key = 'strings.*' and d.rule_point like 'strings.%')
   where d.pack_version = p_version
     and (rp.key is null or not (d.kind::text = any (rp.permitted_kinds)));
  if bad > 0 then
    raise exception 'pack refused at activation: % invalid declaration(s)', bad;
  end if;
  select active_version into old_version from deedbox.country_pack where id = p_pack;
  update deedbox.country_pack set active_version = p_version where id = p_pack;
  select id into f from deedbox.firm limit 1;
  if f is not null then
    insert into deedbox.register_entry
      (firm, actor_kind, actor, event_kind, subject_type, subject, privileged, detail)
    values (f, p_actor_kind, p_actor, 'pack.activated', 'country_pack', p_pack, true,
            jsonb_build_object('before', jsonb_build_object('active_version', old_version),
                               'after',  jsonb_build_object('active_version', p_version)));
  end if;
end $$;

------------------------------------------------------------------------------
-- 3. delete_unused_item's write path (guard trigger + zero-usage op in front).
------------------------------------------------------------------------------
grant delete on deedbox.choice_item to deedbox_app;

------------------------------------------------------------------------------
-- 4. The numbering console's next-number preview reads the counters.
--    Read-only: allocation stays exclusively inside allocate_number and
--    replace_number_format (both security definer).
------------------------------------------------------------------------------
grant select on deedbox.sequence_counter to deedbox_app;
