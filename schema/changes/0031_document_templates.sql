-- 0031_document_templates — the document-templates module's home:
-- firm-uploaded Word templates with merge fields, generated onto matters as
-- ordinary documents (source template_generation, shipped by 0030). The
-- template file's bytes live on the platform store under the templates/
-- prefix; the row is the record. Writes are gated on templates.manage (a
-- shipped 0003 capability — no catalogue change); a template must be
-- ACTIVE to generate; deletion is soft with the standard restore window.
-- Pack-supplied document templates (the templates.documents rule point)
-- materialise with the country-pack work as their own numbered change.

begin;

create table deedbox.document_template (
    id bigint generated always as identity primary key,
    name text not null check (length(name) between 1 and 255),
    category text not null default 'General' check (length(category) between 1 and 80),
    description text,
    practice_area bigint references deedbox.practice_area(id),
    jurisdiction text,
    filename text not null check (length(filename) between 1 and 300),
    storage_ref text not null unique,
    size_bytes bigint not null check (size_bytes > 0),
    active boolean not null default false,
    created_at timestamptz not null default now(),
    created_by bigint not null references deedbox.staff_member(id),
    updated_at timestamptz not null default now(),
    updated_by bigint references deedbox.staff_member(id),
    soft_deleted_at timestamptz,
    soft_deleted_by bigint references deedbox.staff_member(id),
    check ((soft_deleted_at is null) = (soft_deleted_by is null))
);
create index document_template_active on deedbox.document_template (active) where soft_deleted_at is null;

-- a deleted template cannot stay generatable
create or replace function deedbox.document_template_guard() returns trigger
language plpgsql as $$
begin
  if new.soft_deleted_at is not null and new.active then
    raise exception 'a deleted template cannot remain active';
  end if;
  new.updated_at := now();
  return new;
end $$;
create trigger document_template_guard before update on deedbox.document_template
for each row execute function deedbox.document_template_guard();

insert into deedbox.deletion_policy (entity_type, mode) values
  ('document_template', 'soft_delete');

grant select, insert, update on deedbox.document_template to deedbox_app;

commit;
