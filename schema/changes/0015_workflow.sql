-- 0015_workflow — stage 6 opens: workflow templates and their stages and
-- tasks, firm-named anchor dates with the recompute-proposal discipline,
-- matter stages with the one-current rule, tasks, and key dates. The billing
-- guardrail's stage pointer and the reminder contact's task pointer become
-- real foreign keys. Template application, slot resolution, date
-- recomputation and the staffing re-resolution hook are app-layer operations
-- over these rows.
--
-- Implementation notes:
--   * key_date_types' list row shipped in 0002; its shipped ITEMS land
--     here with their owning table (court_date, limitation_date,
--     settlement, appointment — firm-editable like every list).
--   * The closed-matter read-only rule for tasks (completion included) is
--     enforced by the same session-ceremony pattern as every other closed-
--     matter write (deedbox.edit_closed), checked in the task guard.
--   * A date_recompute_proposal supersedes any pending sibling for its
--     matter at insert, mechanically — the freshest computation is the
--     only pending one.

begin;

------------------------------------------------------------------------------
-- Workflow templates.
------------------------------------------------------------------------------
create table deedbox.workflow_template (
    id bigint generated always as identity primary key,
    name text not null,
    practice_area bigint not null references deedbox.practice_area(id),
    active boolean not null default true,
    created_at timestamptz not null default now()
);
create unique index workflow_template_name_unique
  on deedbox.workflow_template (practice_area, name) where active;
grant select, insert, update on deedbox.workflow_template to deedbox_app;

create table deedbox.template_stage (
    id bigint generated always as identity primary key,
    template bigint not null references deedbox.workflow_template(id),
    name text not null,
    position int not null,
    expected_duration_days int,
    unique (template, position)
);
grant select, insert, update, delete on deedbox.template_stage to deedbox_app;

create table deedbox.template_task (
    id bigint generated always as identity primary key,
    stage bigint not null references deedbox.template_stage(id),
    title text not null,
    assignee_slot text not null check (assignee_slot in ('responsible_lawyer','assisting_staff','named_person')),
    named_staff bigint references deedbox.staff_member(id),
    due_rule jsonb not null,
    check ((assignee_slot = 'named_person') = (named_staff is not null))
);
grant select, insert, update, delete on deedbox.template_task to deedbox_app;

------------------------------------------------------------------------------
-- Anchor dates and the recompute-proposal discipline.
------------------------------------------------------------------------------
create table deedbox.anchor_date_definition (
    id bigint generated always as identity primary key,
    name text not null,
    practice_areas jsonb,
    pack_version bigint references deedbox.pack_version(id),
    active boolean not null default true,
    created_at timestamptz not null default now()
);
create unique index anchor_date_definition_name_unique
  on deedbox.anchor_date_definition (name) where active;
grant select, insert, update on deedbox.anchor_date_definition to deedbox_app;

create table deedbox.matter_anchor_date (
    id bigint generated always as identity primary key,
    matter bigint not null references deedbox.matter(id),
    definition bigint not null references deedbox.anchor_date_definition(id),
    value date not null,
    unique (matter, definition)
);
grant select, insert, update on deedbox.matter_anchor_date to deedbox_app;

create table deedbox.date_recompute_proposal (
    id bigint generated always as identity primary key,
    matter bigint not null references deedbox.matter(id),
    changes jsonb not null,
    state text not null default 'pending'
      check (state in ('pending','confirmed','rejected','superseded')),
    created_at timestamptz not null default now()
);
create index date_recompute_matter_idx on deedbox.date_recompute_proposal (matter) where state = 'pending';
grant select, insert, update on deedbox.date_recompute_proposal to deedbox_app;

create or replace function deedbox.date_recompute_guard() returns trigger
language plpgsql as $$
begin
  if tg_op = 'DELETE' then
    raise exception 'proposals are decided or superseded, never deleted';
  end if;
  if tg_op = 'INSERT' then
    if new.state <> 'pending' then
      raise exception 'a proposal is born pending';
    end if;
    -- the freshest computation is the only pending one.
    update deedbox.date_recompute_proposal p set state = 'superseded'
     where p.matter = new.matter and p.state = 'pending';
    return new;
  end if;
  if old.state <> 'pending' then
    raise exception 'a decided proposal is immutable';
  end if;
  if new.state = 'pending' and new.changes is distinct from old.changes then
    raise exception 'a proposal''s computed changes are immutable; a fresh anchor change raises a fresh proposal';
  end if;
  return new;
end $$;
create trigger date_recompute_guard before insert or update or delete on deedbox.date_recompute_proposal
for each row execute function deedbox.date_recompute_guard();

------------------------------------------------------------------------------
-- Matter stages — at most one current per matter.
------------------------------------------------------------------------------
create table deedbox.matter_stage (
    id bigint generated always as identity primary key,
    matter bigint not null references deedbox.matter(id),
    name text not null,
    position int not null,
    entered_at timestamptz,
    template_origin bigint references deedbox.template_stage(id),
    state text not null default 'pending' check (state in ('pending','current','done')),
    unique (matter, position)
);
create unique index matter_stage_one_current
  on deedbox.matter_stage (matter) where state = 'current';
grant select, insert, update on deedbox.matter_stage to deedbox_app;

alter table deedbox.budget
  add constraint budget_stage_fk foreign key (stage) references deedbox.matter_stage(id);

------------------------------------------------------------------------------
-- Tasks — the closed-matter rule admits no exceptions.
------------------------------------------------------------------------------
create table deedbox.task (
    id bigint generated always as identity primary key,
    matter bigint references deedbox.matter(id),
    stage bigint references deedbox.matter_stage(id),
    title text not null,
    owner bigint not null references deedbox.staff_member(id),
    due_date date,
    due_rule jsonb,
    assignee_slot text check (assignee_slot in ('responsible_lawyer','assisting_staff','named_person')),
    done boolean not null default false,
    done_at timestamptz,
    done_by bigint references deedbox.staff_member(id),
    origin text not null default 'manual' check (origin in ('manual','template','reminder_step','system')),
    created_at timestamptz not null default now(),
    deleted_at timestamptz,
    deleted_by bigint,
    check (not done or done_at is not null)
);
create index task_owner_idx on deedbox.task (owner) where not done and deleted_at is null;
create index task_matter_idx on deedbox.task (matter);
create index task_due_idx on deedbox.task (due_date) where not done and deleted_at is null;
grant select, insert, update on deedbox.task to deedbox_app;

create or replace function deedbox.task_guard() returns trigger
language plpgsql as $$
declare m_status text;
begin
  if tg_op = 'DELETE' then
    raise exception 'tasks soft-delete; they are never hard-deleted';
  end if;
  if coalesce(new.matter, case when tg_op = 'UPDATE' then old.matter end) is not null then
    select m.status into m_status from deedbox.matter m
     where m.id = coalesce(new.matter, old.matter);
    if m_status in ('closed','archived')
       and coalesce(current_setting('deedbox.edit_closed', true), '') <> 'on' then
      raise exception 'every task write on a closed matter — completion included — requires matter.edit_closed';
    end if;
  end if;
  if tg_op = 'UPDATE' and new.done and not old.done then
    new.done_at := coalesce(new.done_at, now());
  end if;
  if tg_op = 'UPDATE' and not new.done and old.done then
    new.done_at := null; new.done_by := null;
  end if;
  return new;
end $$;
create trigger task_guard before insert or update or delete on deedbox.task
for each row execute function deedbox.task_guard();

alter table deedbox.reminder_contact
  add constraint reminder_contact_task_fk foreign key (task) references deedbox.task(id);

------------------------------------------------------------------------------
-- Key dates — the firm-wide critical view's base rows.
------------------------------------------------------------------------------
-- the key_date_types list shipped in 0002; its items land with their table.
insert into deedbox.choice_item (list, label, position, shipped_key)
select l.id, c.label, c.pos, c.key from deedbox.choice_list l,
 (values ('Court date',1,'court_date'),('Limitation date',2,'limitation_date'),
         ('Settlement',3,'settlement'),('Appointment',4,'appointment')) as c(label,pos,key)
where l.purpose_key = 'key_date_types';

create table deedbox.key_date (
    id bigint generated always as identity primary key,
    matter bigint not null references deedbox.matter(id),
    kind text not null check (kind in ('key_date','appointment')),
    type bigint not null references deedbox.choice_item(id),
    title text not null,
    starts_at timestamptz not null,
    ends_at timestamptz,
    critical boolean not null default false,
    external_sync_ref text,
    done boolean not null default false,
    created_at timestamptz not null default now(),
    deleted_at timestamptz,
    deleted_by bigint,
    check (ends_at is null or ends_at >= starts_at)
);
create index key_date_matter_idx on deedbox.key_date (matter);
create index key_date_critical_idx on deedbox.key_date (starts_at) where critical and not done and deleted_at is null;
grant select, insert, update on deedbox.key_date to deedbox_app;

commit;
