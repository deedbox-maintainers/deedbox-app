-- 0002_substrate_seams — packs, numbering, lists, fields, private-layer contracts.
-- Implements: the rule-point catalogue, pack declarations, numbering, firm
--   lists, custom fields, and the private-layer and country-pack seams.
-- Runs as the deployment role.
--
-- Implementation notes:
--   * pack_declaration.rule_point is validated by trigger against the shipped
--     catalogue (exact match, or prefix match under 'strings.*') rather than a
--     plain foreign key, because the strings family is a wildcard point.
--   * Declaration-body validation at activation currently checks rule point
--     existence + declaration kind permitted for the point; per-point JSON
--     schema enforcement deepens as each consuming stage lands its schemas
--     (the catalogue carries a body_schema column from day one).
--   * Sequence-mode streams draw from a per-format native sequence created by
--     trigger at format insert.

begin;

------------------------------------------------------------------------------
-- The rule-point catalogue (shipped, firm-scopeless, versioned by release).
------------------------------------------------------------------------------
create table deedbox.rule_point (
    key text primary key,
    permitted_kinds text[] not null,
    body_schema jsonb,
    neutral_default text not null default 'no additional rule',
    description text not null default ''
);
grant select on deedbox.rule_point to deedbox_app;

insert into deedbox.rule_point (key, permitted_kinds, neutral_default) values
('money.payment_methods', array['enumeration','field_schema','availability_rule'], 'shipped four methods, no compulsion'),
('money.entitlement_bases', array['enumeration','value'], 'rendered bill only, no notice period'),
('money.timeliness', array['threshold_rule'], 'no additional rule'),
('money.close', array['value','report_set','document_template'], 'no scheduled obligation; close on demand'),
('money.set_aside', array['expression_formula','value'], 'no additional rule'),
('money.dormancy', array['value'], 'no additional rule'),
('money.instrument_kinds', array['enumeration','value'], 'cheque, 180 days'),
('money.exception_workflow', array['exception_workflow'], 'no additional rule'),
('money.unallocated_routing', array['threshold_rule','value'], 'never compelled'),
('bank.account_identifiers', array['field_schema'], 'account label and account number, both required'),
('registers.statutory', array['register_schema','document_template'], 'no additional rule'),
('billing.tax', array['value','enumeration','expression_formula'], 'no additional rule'),
('billing.interest_cap', array['threshold_rule','value'], 'compounding not permitted unless declared'),
('billing.surcharge', array['threshold_rule','expression_formula'], 'no additional rule'),
('billing.estimate_rules', array['threshold_rule','value','string_bundle'], 'no additional rule'),
('channel.destination', array['value'], 'top-ups engine-fixed to client money; bills office unless declared'),
('statements.obligations', array['value','document_template'], 'nothing compulsory; annual run and on-request always available'),
('lists.items', array['enumeration'], 'no additional rule'),
('dates.anchors', array['enumeration'], 'no additional rule'),
('dates.calendar', array['value'], 'no additional rule'),
('dates.rules', array['deadline_rule'], 'no additional rule'),
('privacy.erasure', array['value'], 'erasure not permitted unless declared'),
('imports.mappings', array['value'], 'no additional rule'),
('notifications.deficiency_shape', array['notification_shape'], 'no additional rule'),
('strings.*', array['string_bundle'], 'engine strings'),
('templates.documents', array['document_template'], 'no additional rule'),
('templates.messages', array['document_template','string_bundle'], 'no additional rule');

------------------------------------------------------------------------------
-- pack_declaration — one typed declaration per rule point.
------------------------------------------------------------------------------
create type deedbox.declaration_kind as enum
  ('value','threshold_rule','expression_formula','field_schema','enumeration',
   'deadline_rule','document_template','string_bundle','register_schema',
   'report_set','notification_shape','availability_rule','exception_workflow');

create table deedbox.pack_declaration (
    id bigint generated always as identity primary key,
    pack_version bigint not null references deedbox.pack_version(id),
    rule_point text not null,
    kind deedbox.declaration_kind not null,
    discriminator text,
    body jsonb not null
);
create unique index pack_declaration_unique
  on deedbox.pack_declaration (pack_version, rule_point, coalesce(discriminator, ''));
grant select on deedbox.pack_declaration to deedbox_app;

create or replace function deedbox.pack_declaration_guard() returns trigger
language plpgsql as $$
declare rp deedbox.rule_point%rowtype;
begin
  if tg_op in ('UPDATE','DELETE') then
    raise exception 'pack declarations are immutable within a version';
  end if;
  select * into rp from deedbox.rule_point
   where key = new.rule_point
      or (key = 'strings.*' and new.rule_point like 'strings.%');
  if not found then
    raise exception 'unknown rule point %', new.rule_point;
  end if;
  if not (new.kind::text = any (rp.permitted_kinds)) then
    raise exception 'declaration kind % not permitted for rule point %', new.kind, new.rule_point;
  end if;
  return new;
end $$;

create trigger pack_declaration_guard
before insert or update or delete on deedbox.pack_declaration
for each row execute function deedbox.pack_declaration_guard();

-- Activation: single-approver privileged registered operation; declarations
-- validate before the version can govern anything.
create or replace function deedbox.activate_pack(p_pack bigint, p_version bigint,
                                                 p_actor_kind text, p_actor bigint)
returns void language plpgsql as $$
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
grant execute on function deedbox.activate_pack(bigint, bigint, text, bigint) to deedbox_app;

------------------------------------------------------------------------------
-- Numbering — formats, counters, and the one allocation path.
------------------------------------------------------------------------------
create type deedbox.number_purpose as enum
  ('matter','bill','credit_note','money_receipt','money_payment',
   'ledger_transfer','statement','top_up_request','receivable_receipt');

create table deedbox.number_format (
    id bigint generated always as identity primary key,
    purpose deedbox.number_purpose not null,
    scope text,
    pattern text not null,
    allocation_mode text not null check (allocation_mode in ('sequence','gapless')),
    reset text not null default 'never' check (reset in ('never','yearly')),
    active boolean not null default true,
    created_at timestamptz not null default now()
);
create unique index number_format_unique
  on deedbox.number_format (purpose, coalesce(scope,'')) where active;
grant select on deedbox.number_format to deedbox_app;

create table deedbox.sequence_counter (
    format bigint not null references deedbox.number_format(id),
    partition text not null default '',
    next_value bigint not null default 1,
    primary key (format, partition)
);
-- app allocates only through allocate_number (security definer); no direct grants.

create or replace function deedbox.number_format_after_insert() returns trigger
language plpgsql as $$
begin
  if new.allocation_mode = 'sequence' then
    execute format('create sequence if not exists deedbox.numseq_%s', new.id);
  end if;
  return new;
end $$;
create trigger number_format_after_insert
after insert on deedbox.number_format
for each row execute function deedbox.number_format_after_insert();

create or replace function deedbox.render_number(p_pattern text, p_n bigint,
                                                 p_office text, p_act_date date)
returns text language plpgsql immutable as $$
declare out_text text := p_pattern; w int;
begin
  out_text := replace(out_text, '{YEAR}', to_char(p_act_date, 'YYYY'));
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
  part := case when fmt.reset = 'yearly' then to_char(p_act_date, 'YYYY') else '' end;
  if fmt.allocation_mode = 'gapless' then
    -- counter locked inside the committing transaction of the irreversible act:
    -- an aborted save rolls the increment back, so no committed gap can exist.
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
grant execute on function deedbox.allocate_number(deedbox.number_purpose, text, date) to deedbox_app;

-- Shipped defaults: scope-absent, one per purpose.
insert into deedbox.number_format (purpose, scope, pattern, allocation_mode, reset) values
('matter', null, 'M-{YEAR}-{SEQ:5}', 'gapless', 'yearly'),
('bill', null, 'B-{SEQ:6}', 'gapless', 'never'),
('credit_note', null, 'CN-{SEQ:6}', 'gapless', 'never'),
('money_receipt', null, 'R-{SEQ:6}', 'gapless', 'never'),
('money_payment', null, 'P-{SEQ:6}', 'gapless', 'never'),
('ledger_transfer', null, 'T-{SEQ:6}', 'gapless', 'never'),
('statement', null, 'S-{SEQ:6}', 'sequence', 'never'),
('top_up_request', null, 'TU-{SEQ:6}', 'sequence', 'never'),
('receivable_receipt', null, 'OR-{SEQ:6}', 'gapless', 'never');

------------------------------------------------------------------------------
-- choice_list / choice_item — the one engine behind every firm list.
------------------------------------------------------------------------------
create table deedbox.choice_list (
    id bigint generated always as identity primary key,
    purpose_key text not null unique,
    name text not null
);
create table deedbox.choice_item (
    id bigint generated always as identity primary key,
    list bigint not null references deedbox.choice_list(id),
    label text not null,
    position int not null,
    active boolean not null default true,
    shipped_key text,
    counts_as_chargeable boolean not null default false
);
grant select, insert, update on deedbox.choice_list, deedbox.choice_item to deedbox_app;

create or replace function deedbox.choice_item_guard() returns trigger
language plpgsql as $$
declare lp text;
begin
  if tg_op = 'DELETE' then
    if old.shipped_key is not null then
      raise exception 'shipped choice items are never deleted';
    end if;
    return old;
  end if;
  if tg_op = 'UPDATE' and old.shipped_key is not null then
    select purpose_key into lp from deedbox.choice_list where id = old.list;
    if lp = 'time_categories'
       and new.counts_as_chargeable is distinct from old.counts_as_chargeable then
      raise exception 'the shipped time-category chargeability flags are immutable';
    end if;
    if new.active is distinct from old.active and old.shipped_key in ('chargeable','non_chargeable') then
      raise exception 'the shipped time categories cannot be deactivated';
    end if;
  end if;
  return new;
end $$;
create trigger choice_item_guard
before update or delete on deedbox.choice_item
for each row execute function deedbox.choice_item_guard();

-- Shipped lists and items (time categories ship EXACTLY chargeable + non_chargeable).
insert into deedbox.choice_list (purpose_key, name) values
('time_categories','Time categories'),
('key_date_types','Key date types'),
('intake_outcomes','Intake outcomes'),
('matter_party_capacities','Matter party capacities'),
('relation_labels','Matter relation labels'),
('party_link_kinds','Party link kinds');

insert into deedbox.choice_item (list, label, position, shipped_key, counts_as_chargeable)
select id, 'Chargeable', 1, 'chargeable', true from deedbox.choice_list where purpose_key='time_categories';
insert into deedbox.choice_item (list, label, position, shipped_key, counts_as_chargeable)
select id, 'Non-chargeable', 2, 'non_chargeable', false from deedbox.choice_list where purpose_key='time_categories';
insert into deedbox.choice_item (list, label, position, shipped_key)
select id, 'Proceeded', 1, 'proceeded' from deedbox.choice_list where purpose_key='intake_outcomes';
insert into deedbox.choice_item (list, label, position, shipped_key)
select id, 'Did not proceed', 2, 'did_not_proceed' from deedbox.choice_list where purpose_key='intake_outcomes';
insert into deedbox.choice_item (list, label, position, shipped_key)
select id, c.label, c.pos, c.key from deedbox.choice_list l,
 (values ('Client',1,'client'),('Opposing party',2,'opposing_party'),('Related party',3,'related_party'),
         ('Witness',4,'witness'),('Payer',5,'payer')) as c(label,pos,key)
where l.purpose_key='matter_party_capacities';
insert into deedbox.choice_item (list, label, position, shipped_key)
select id, c.label, c.pos, c.key from deedbox.choice_list l,
 (values ('Contact person',1,'contact_person'),('Employee',2,'employee'),('Related',3,'related')) as c(label,pos,key)
where l.purpose_key='party_link_kinds';

------------------------------------------------------------------------------
-- The custom-field engine (one engine, four uses).
------------------------------------------------------------------------------
create table deedbox.custom_field_set (
    id bigint generated always as identity primary key,
    name text not null,
    scope text not null check (scope in ('matter','intake'))
);
create table deedbox.custom_field_definition (
    id bigint generated always as identity primary key,
    scope text not null check (scope in ('party','matter','intake','pack_object')),
    owner_pack_version bigint references deedbox.pack_version(id),
    pack_object_kind text,
    key text not null,
    label text not null,
    data_type text not null check (data_type in ('text','number','date','choice','party_link')),
    choice_list bigint references deedbox.choice_list(id),
    required boolean not null default false,
    validation jsonb,
    field_set bigint references deedbox.custom_field_set(id),
    position int not null default 0,
    searchable boolean not null default true,
    active boolean not null default true,
    constraint pack_scope_shape check (
      (scope = 'pack_object') = (owner_pack_version is not null)
    )
);
create unique index custom_field_definition_unique
  on deedbox.custom_field_definition (scope, coalesce(owner_pack_version, 0), key) where active;

create table deedbox.custom_field_value (
    id bigint generated always as identity primary key,
    definition bigint not null references deedbox.custom_field_definition(id),
    owner_type text not null,
    owner bigint not null,
    text_value text,
    number_value numeric,
    date_value date,
    choice_value bigint references deedbox.choice_item(id),
    party_value bigint,
    unique (definition, owner_type, owner),
    constraint exactly_one_value check (
      (text_value is not null)::int + (number_value is not null)::int +
      (date_value is not null)::int + (choice_value is not null)::int +
      (party_value is not null)::int = 1
    )
);
grant select, insert, update on deedbox.custom_field_set, deedbox.custom_field_definition to deedbox_app;
grant select, insert, update, delete on deedbox.custom_field_value to deedbox_app;

create or replace function deedbox.custom_field_definition_guard() returns trigger
language plpgsql as $$
declare l bigint;
begin
  if tg_op = 'DELETE' then
    raise exception 'field definitions are deactivated, never deleted';
  end if;
  if tg_op = 'UPDATE' then
    if new.data_type is distinct from old.data_type then
      raise exception 'data_type is immutable';
    end if;
    if new.key is distinct from old.key then
      raise exception 'the machine key is never relabelled';
    end if;
    return new;
  end if;
  -- choice fields auto-create their own list where none is named
  if new.data_type = 'choice' and new.choice_list is null then
    insert into deedbox.choice_list (purpose_key, name)
    values ('custom.' || new.scope || '.' || new.key, new.label)
    returning id into l;
    new.choice_list := l;
  end if;
  return new;
end $$;
create trigger custom_field_definition_guard
before insert or update or delete on deedbox.custom_field_definition
for each row execute function deedbox.custom_field_definition_guard();

create or replace function deedbox.custom_field_value_guard() returns trigger
language plpgsql as $$
declare d deedbox.custom_field_definition%rowtype;
begin
  select * into d from deedbox.custom_field_definition where id = new.definition;
  if (d.data_type = 'text' and new.text_value is null)
     or (d.data_type = 'number' and new.number_value is null)
     or (d.data_type = 'date' and new.date_value is null)
     or (d.data_type = 'choice' and new.choice_value is null)
     or (d.data_type = 'party_link' and new.party_value is null) then
    raise exception 'value column must match the definition data_type (%)', d.data_type;
  end if;
  return new;
end $$;
create trigger custom_field_value_guard
before insert or update on deedbox.custom_field_value
for each row execute function deedbox.custom_field_value_guard();

------------------------------------------------------------------------------
-- Private namespace, config slots, extension points.
------------------------------------------------------------------------------
create table deedbox.private_namespace (
    id bigint generated always as identity primary key,
    namespace text not null unique check (namespace like 'firm_%'),
    description text not null,
    suspended boolean not null default false
);
create table deedbox.config_slot (
    id bigint generated always as identity primary key,
    slot text not null check (slot in ('branding','bank_details','timezone_display','custom_entry')),
    entry_key text not null,
    value jsonb not null,
    unique (slot, entry_key)
);
create table deedbox.ui_extension_point (
    point_key text primary key,
    location text not null,
    contract_version text not null,
    deprecation_state text not null default 'current'
      check (deprecation_state in ('current','deprecated','retired'))
);
grant select, insert, update on deedbox.private_namespace, deedbox.config_slot to deedbox_app;
grant select on deedbox.ui_extension_point to deedbox_app;

create or replace function deedbox.ui_extension_point_guard() returns trigger
language plpgsql as $$
begin
  raise exception 'extension points are append-only across releases (deprecation, never deletion)';
end $$;
create trigger ui_extension_point_guard
before delete on deedbox.ui_extension_point
for each row execute function deedbox.ui_extension_point_guard();

insert into deedbox.ui_extension_point (point_key, location, contract_version) values
('matter.side_panel','matter side panel','1.0'),
('party.side_panel','party side panel','1.0'),
('dashboard.slot','dashboard slot','1.0'),
('report.menu','report menu','1.0');

commit;
