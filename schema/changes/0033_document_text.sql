-- 0033_document_text — the documents module's text half: a per-version
-- extracted-text cache (re-extractable derived content, powering version
-- compare and the sweep job's exactly-once discipline), and the search
-- index's closed entry_type vocabulary widened so documents join the
-- search page. Conflict-check coverage needs no schema: the registered_text
-- corpus row simply carries the text.

begin;

create table deedbox.document_version_text (
    id bigint generated always as identity primary key,
    version bigint not null unique references deedbox.document_version(id),
    content text not null,
    method text not null check (method in ('embedded','none')),
    char_count int not null default 0,
    extracted_at timestamptz not null default now()
);
grant select, insert, update on deedbox.document_version_text to deedbox_app;

create or replace function deedbox.document_version_text_guard() returns trigger
language plpgsql as $$
begin
  if new.version is distinct from old.version then
    raise exception 'a text row never changes version';
  end if;
  new.extracted_at := now();
  return new;
end $$;
create trigger document_version_text_guard before update on deedbox.document_version_text
for each row execute function deedbox.document_version_text_guard();

alter table deedbox.search_index drop constraint search_index_entry_type_check;
alter table deedbox.search_index add constraint search_index_entry_type_check
  check (entry_type in
    ('matter','party','note','task','key_date','time_entry','custom_field_value','document'));

insert into deedbox.deletion_policy (entity_type, mode) values
  ('document_version_text', 'hard_delete_allowed');

commit;
