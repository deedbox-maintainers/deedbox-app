-- Tests for 0051_daily_numbering. Run as deployment role AFTER the full chain.
-- The {DATE} token renders the acting date; a daily-reset gapless format
-- partitions its counter by that date and continues where an existing series
-- stands; the replacement routine accepts 'daily' only with {DATE} in the
-- pattern; the shipped formats are untouched.

begin;

insert into deedbox.country_pack (code, name) values ('ZZ-NUM','Numbering suite');
insert into deedbox.firm (name, operating_currency, timezone, country_pack)
  select 'Numbering Firm','AUD','Australia/Sydney', id from deedbox.country_pack where code = 'ZZ-NUM';

do $$
declare
  fid bigint; n1 text; n2 text; n3 text; n4 text; before_pattern text;
begin
  -- T1 the token renders the acting date
  if deedbox.render_number('INV-{DATE}-{SEQ:3}', 7, null, date '2026-03-05') <> 'INV-20260305-007' then
    raise exception 'T1 FAILED: got %', deedbox.render_number('INV-{DATE}-{SEQ:3}', 7, null, date '2026-03-05');
  end if;

  -- T2 a scoped daily format (its own office scope, so the shipped bill format is untouched):
  --    counters partition by the acting date and start at 001 each day
  insert into deedbox.number_format (purpose, scope, pattern, allocation_mode, reset)
  values ('bill', 'ZZNUM', 'INV-{DATE}-{SEQ:3}', 'gapless', 'daily') returning id into fid;
  n1 := deedbox.allocate_number('bill', 'ZZNUM', date '2026-03-05');
  n2 := deedbox.allocate_number('bill', 'ZZNUM', date '2026-03-05');
  n3 := deedbox.allocate_number('bill', 'ZZNUM', date '2026-03-06');
  if n1 <> 'INV-20260305-001' or n2 <> 'INV-20260305-002' or n3 <> 'INV-20260306-001' then
    raise exception 'T2 FAILED: % % %', n1, n2, n3;
  end if;

  -- T3 an existing series for a day is continued when its counter is seeded (the takeover case)
  insert into deedbox.sequence_counter (format, partition, next_value) values (fid, '20260301', 40)
    on conflict (format, partition) do update set next_value = excluded.next_value;
  n4 := deedbox.allocate_number('bill', 'ZZNUM', date '2026-03-01');
  if n4 <> 'INV-20260301-040' then
    raise exception 'T3 FAILED: got %', n4;
  end if;

  -- T4 the shipped default bill format still answers exactly as before
  select pattern into before_pattern from deedbox.number_format where purpose = 'bill' and scope is null and active;
  if before_pattern <> 'B-{SEQ:6}' then
    raise exception 'T4 FAILED: shipped bill pattern changed to %', before_pattern;
  end if;
  if deedbox.allocate_number('bill') !~ '^B-[0-9]{6}$' then
    raise exception 'T4 FAILED: default bill allocation no longer B-nnnnnn';
  end if;

  -- T5 the replacement routine: daily demands {DATE}; the constraint accepts daily
  begin
    perform deedbox.replace_number_format('credit_note', null, 'CN-{SEQ:4}', 'gapless', 'daily', 'staff', 1, null);
    raise exception 'T5 FAILED: a daily pattern without {DATE} was accepted';
  exception when others then
    if sqlerrm not like '%must contain {DATE}%' then raise; end if;
  end;
  perform deedbox.replace_number_format('credit_note', null, 'CN-{DATE}-{SEQ:3}', 'gapless', 'daily', 'staff', 1, null);
  if (select reset from deedbox.number_format where purpose = 'credit_note' and scope is null and active) <> 'daily' then
    raise exception 'T5 FAILED: the daily format did not take';
  end if;
  if deedbox.allocate_number('credit_note', null, date '2026-03-05') !~ '^CN-20260305-[0-9]{3}$' then
    raise exception 'T5 FAILED: daily credit-note allocation did not render';
  end if;
end $$;

rollback;
