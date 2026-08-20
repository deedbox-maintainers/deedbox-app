-- Tests for 0016_reporting_experience. Run as deployment role AFTER 0001–0016.

begin;

insert into deedbox.country_pack (code, name) values ('AU-NSW','Australia (NSW)');
insert into deedbox.pack_version (pack, version) select id, '0.0.1' from deedbox.country_pack;
update deedbox.country_pack cp set active_version = pv.id from deedbox.pack_version pv where pv.pack = cp.id;
insert into deedbox.firm (name, operating_currency, timezone, country_pack)
  select 'Test Firm','AUD','Australia/Sydney', id from deedbox.country_pack;
insert into deedbox.office (name, code) values ('Sydney','SYD');

do $$
declare o bigint; r_admin bigint; r_lawyer bigint; s_admin bigint; s_law bigint;
        p1 bigint; pa bigint; m1 bigint; def bigint; sr bigint; om bigint; om2 bigint;
        n1 bigint; te bigint; cat bigint; i int; tgt bigint; cnt int;
begin
  select id into o from deedbox.office limit 1;
  select id into r_admin from deedbox.role where system_key='administrator';
  select id into r_lawyer from deedbox.role where system_key='lawyer';
  insert into deedbox.staff_member (person_name, login, role, office, email)
    values ('{"display":"Ada Admin"}','ada', r_admin, o, 'ada@x.test') returning id into s_admin;
  insert into deedbox.staff_member (person_name, login, role, office, email)
    values ('{"display":"Lee Lawyer"}','lee', r_lawyer, o, 'lee@x.test') returning id into s_law;
  insert into deedbox.party (kind, display_name) values ('person','Cli') returning id into p1;
  insert into deedbox.party_name (party, name_kind, full_name) values (p1,'current','Cli Searchname');
  insert into deedbox.practice_area (name) values ('Litigation') returning id into pa;
  insert into deedbox.matter (matter_number, title, client_party, responsible_lawyer, office, practice_area)
    values (deedbox.allocate_number('matter', null, current_date), 'Search host', p1, s_law, o, pa) returning id into m1;

  ------------------------------------------------------------------
  -- 1. The shipped catalogue is seeded; keys resolve.
  ------------------------------------------------------------------
  select count(*) into cnt from deedbox.report_definition;
  if cnt < 31 then
    raise exception 'C1 the shipped catalogue is short (% rows)', cnt;
  end if;
  select id into def from deedbox.report_definition where key = 'aged_receivables';
  if def is null or (select schedulable from deedbox.report_definition where id = def) is not true then
    raise exception 'C2 aged_receivables missing or unschedulable';
  end if;
  if (select schedulable from deedbox.report_definition where key = 'view_unpaid_bills') then
    raise exception 'C3 a view source claims schedulability';
  end if;

  ------------------------------------------------------------------
  -- 2. Saved reports and schedules.
  ------------------------------------------------------------------
  insert into deedbox.saved_report (definition, name, owner, columns, filters, grouping, sort)
    values (def, 'My 90-day debtors', s_admin, '[]', '{"age_band":"91-180"}', '{}', '{}') returning id into sr;
  begin
    insert into deedbox.saved_report (definition, name, owner, columns, filters, grouping, sort)
      values (def, 'My 90-day debtors', s_admin, '[]', '{}', '{}', '{}');
    raise exception 'S1 duplicate saved-report name for one owner';
  exception when others then
    if sqlerrm not like '%duplicate key%' then raise; end if;
  end;
  insert into deedbox.report_schedule (report_kind, report, period, format, owner, next_run_at)
    values ('saved', sr, '{"frequency":"monthly","day":1,"time":"07:00"}', 'pdf', s_admin, now() + interval '1 day');
  insert into deedbox.schedule_recipient (schedule, staff)
    select max(id), s_admin from deedbox.report_schedule;

  ------------------------------------------------------------------
  -- 3. Outbound messages: forward-only; a retry is a new row.
  ------------------------------------------------------------------
  insert into deedbox.outbound_message (channel, recipient, rendered_artefact, purpose)
    values ('email', 'client@x.test', 'artefact:msg1', 'statement_cover') returning id into om;
  update deedbox.outbound_message set state='failed', failed_reason='mailbox full' where id = om;
  begin
    update deedbox.outbound_message set state='queued' where id = om;
    raise exception 'O1 failed message rewound';
  exception when others then
    if sqlerrm not like '%immutable%' then raise; end if;
  end;
  insert into deedbox.outbound_message (channel, recipient, rendered_artefact, purpose, retry_of)
    values ('email', 'client@x.test', 'artefact:msg1', 'statement_cover', om) returning id into om2;
  update deedbox.outbound_message set state='sent', sent_at=now() where id = om2;

  ------------------------------------------------------------------
  -- 4. Pins: twenty is the cap.
  ------------------------------------------------------------------
  for i in 1..20 loop
    insert into deedbox.pinned_item (staff, item_type, item, position) values (s_law, 'matter', i, i);
  end loop;
  begin
    insert into deedbox.pinned_item (staff, item_type, item, position) values (s_law, 'matter', 21, 21);
    raise exception 'P1 the twenty-first pin landed';
  exception when others then
    if sqlerrm not like '%twenty pins is the cap%' then raise; end if;
  end;

  ------------------------------------------------------------------
  -- 5. The search index: synchronous feeders; narrative-only for time;
  --    soft-delete removes in the same transaction.
  ------------------------------------------------------------------
  if not exists (select 1 from deedbox.search_index si
                  where si.entry_type='matter' and si.source=m1 and si.display_title like '%Search host%') then
    raise exception 'X1 matter not indexed on create';
  end if;
  if not exists (select 1 from deedbox.search_index si
                  where si.entry_type='party' and si.display_title='Cli Searchname') then
    raise exception 'X2 party name not indexed';
  end if;
  insert into deedbox.note (owner_type, owner, body) values ('matter', m1, 'The fence dispute widened.') returning id into n1;
  if not exists (select 1 from deedbox.search_index si
                  where si.entry_type='note' and si.source=n1 and si.matter=m1) then
    raise exception 'X3 note not indexed with its matter hook';
  end if;
  update deedbox.note set deleted_at=now(), deleted_by=s_admin where id = n1;
  if exists (select 1 from deedbox.search_index si where si.entry_type='note' and si.source=n1) then
    raise exception 'X4 soft-deleted note still indexed';
  end if;
  select ci.id into cat from deedbox.choice_item ci join deedbox.choice_list cl on cl.id=ci.list
   where cl.purpose_key='time_categories' and ci.shipped_key='chargeable';
  insert into deedbox.time_entry (matter, staff, work_date, kind, units, unit_minutes_applied,
                                  applied_rate, rate_source, value, narrative, category, origin)
    values (m1, s_law, current_date, 'timed', 1, 6, 100.00, 'manual', 10.00,
            'Reviewing the boundary survey', cat, 'manual') returning id into te;
  if not exists (select 1 from deedbox.search_index si
                  where si.entry_type='time_entry' and si.source=te
                    and si.body='Reviewing the boundary survey') then
    raise exception 'X5 narrative not indexed';
  end if;
  if exists (select 1 from deedbox.search_index si
              where si.entry_type='time_entry' and si.source=te and si.body like '%10%') then
    raise exception 'X6 money value leaked into the index';
  end if;

  ------------------------------------------------------------------
  -- 6. Targets and groups; the bulk item's reversal outcome.
  ------------------------------------------------------------------
  insert into deedbox.performance_target (subject_kind, subject, metric, amount, period_kind, period_start)
    values ('staff', s_law, 'billable_hours', 120, 'month', date_trunc('month', current_date)::date)
    returning id into tgt;
  begin
    insert into deedbox.performance_target (subject_kind, subject, metric, amount, period_kind, period_start)
      values ('staff', s_law, 'billable_hours', 150, 'month', date_trunc('month', current_date)::date);
    raise exception 'T1 duplicate live target';
  exception when others then
    if sqlerrm not like '%duplicate key%' then raise; end if;
  end;
  begin
    insert into deedbox.performance_target (subject_kind, subject, metric, amount, period_kind, period_start)
      values ('staff', s_law, 'hours_worked', 100, 'custom', current_date);
    raise exception 'T2 custom period accepted without an end';
  exception when others then
    if sqlerrm not like '%check%' then raise; end if;
  end;

  insert into deedbox.bulk_operation (operation_kind, dry_run_summary, reversible_until)
    values ('close', '{}', now() + interval '7 days');
  insert into deedbox.bulk_operation_item (operation, entity_type, entity, before, after, reversal_outcome, block_reason)
    select max(id), 'matter', m1, '{}', '{}', 'blocked', 'record touched since the run' from deedbox.bulk_operation;

  raise notice 'ALL 0016 REPORTING-EXPERIENCE TESTS PASSED';
end $$;

rollback;
