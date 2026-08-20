-- 0051 — numbers that reset each day, and a date in the number.
--
-- Some practices number their bills by the day they issue: a date, then a
-- short counter that starts again each morning (INV-20260305-001, -002 …).
-- The engine's numbering knew a yearly reset and a {YEAR} token only. This
-- change adds the {DATE} token (the acting date as YYYYMMDD) and the 'daily'
-- reset (a partition per acting date), through the same three routines —
-- render_number, allocate_number, replace_number_format — with the same
-- discipline: gapless allocation locks the counter inside the committing
-- transaction; a format change never renumbers and never restarts a stream;
-- a daily-reset pattern must carry {DATE} or partitions would collide.
--
-- The acting date is the caller's: a bill is numbered by its ISSUE date (the
-- application passes it), never by the database's clock — a bill issued at
-- 9am Sydney is not numbered for yesterday.

alter table deedbox.number_format drop constraint if exists number_format_reset_check;
alter table deedbox.number_format add constraint number_format_reset_check check (reset in ('never','yearly','daily'));

create or replace function deedbox.render_number(p_pattern text, p_n bigint,
                                                 p_office text, p_act_date date)
returns text language plpgsql immutable as $$
declare out_text text := p_pattern; w int;
begin
  out_text := replace(out_text, '{YEAR}', to_char(p_act_date, 'YYYY'));
  out_text := replace(out_text, '{DATE}', to_char(p_act_date, 'YYYYMMDD'));
  out_text := replace(out_text, '{OFFICE}', coalesce(p_office, ''));
  if out_text ~ '\{SEQ:\d+\}' then
    w := (regexp_match(out_text, '\{SEQ:(\d+)\}'))[1]::int;
    out_text := regexp_replace(out_text, '\{SEQ:\d+\}', lpad(p_n::text, w, '0'));
  end if;
  return out_text;
end $$;

create or replace function deedbox.allocate_number(p_purpose deedbox.number_purpose,
                                                   p_office text default null,
                                                   p_act_date date default current_date)
returns text
security definer set search_path = deedbox, pg_temp
language plpgsql as $$
declare fmt deedbox.number_format%rowtype; part text; n bigint;
begin
  select * into fmt from deedbox.number_format
   where purpose = p_purpose and active
     and (scope is null or scope = p_office)
   order by scope nulls last limit 1;
  if not found then
    raise exception 'no active number format for purpose %', p_purpose;
  end if;
  part := case when fmt.reset = 'yearly' then to_char(p_act_date, 'YYYY')
               when fmt.reset = 'daily'  then to_char(p_act_date, 'YYYYMMDD')
               else '' end;
  if fmt.allocation_mode = 'gapless' then
    insert into deedbox.sequence_counter (format, partition)
    values (fmt.id, part)
    on conflict (format, partition) do nothing;
    update deedbox.sequence_counter
       set next_value = next_value + 1
     where format = fmt.id and partition = part
    returning next_value - 1 into n;
  else
    execute format('select nextval(''deedbox.numseq_%s'')', fmt.id) into n;
  end if;
  return deedbox.render_number(fmt.pattern, n, p_office, p_act_date);
end $$;

-- the replacement routine, re-declared with the daily grammar (body otherwise 0024's)
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
  if p_reset = 'daily' and position('{DATE}' in p_pattern) = 0 then
    raise exception 'number format refused: a daily-reset pattern must contain {DATE}';
  end if;
  if p_mode not in ('sequence','gapless') then
    raise exception 'number format refused: unknown allocation mode %', p_mode;
  end if;
  if p_reset not in ('never','yearly','daily') then
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
          values (new_id, case when p_reset = 'yearly' then to_char(current_date, 'YYYY')
                               when p_reset = 'daily'  then to_char(current_date, 'YYYYMMDD')
                               else '' end, seed);
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
        values (new_id, case when p_reset = 'yearly' then to_char(current_date, 'YYYY')
                             when p_reset = 'daily'  then to_char(current_date, 'YYYYMMDD')
                             else '' end, seed);
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
