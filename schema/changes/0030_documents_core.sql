-- 0030_documents_core — the documents module's home in the core:
-- folders, mutable document heads, immutable version evidence over the 0028
-- landing store, and the access evidence log. The shape is this schema's
-- own. Bytes live on the platform store (0028 posture); version
-- rows and access rows are append-only evidence; the head carries exactly
-- the working state; closed matters refuse document writes without the
-- edit-closed ceremony; a legal hold blocks soft deletion. Sharing,
-- signing, templates, OCR/full-text and email land as their own numbered
-- changes.

begin;

------------------------------------------------------------------------------
-- The landing store widens: staff uploads and template output land in the
-- same evidence table the intake door proved (0028's "extends this home").
------------------------------------------------------------------------------
alter table deedbox.document_file drop constraint document_file_source_check;
alter table deedbox.document_file add constraint document_file_source_check
  check (source in ('intake_api','staff_upload','template_generation'));
alter table deedbox.document_file
  add column uploaded_by bigint references deedbox.staff_member(id);

------------------------------------------------------------------------------
-- Folders: matter-scoped organisation. Not evidence — hard delete is
-- allowed, but ONLY when empty (guard below), and every act registers.
------------------------------------------------------------------------------
create table deedbox.document_folder (
    id bigint generated always as identity primary key,
    matter bigint not null references deedbox.matter(id),
    parent bigint references deedbox.document_folder(id),
    name text not null check (length(name) between 1 and 120 and position('/' in name) = 0),
    created_at timestamptz not null default now(),
    created_by bigint not null references deedbox.staff_member(id)
);
create unique index document_folder_name_unique
  on deedbox.document_folder (matter, coalesce(parent, 0), name);
create index document_folder_matter on deedbox.document_folder (matter);

create or replace function deedbox.document_folder_guard() returns trigger
language plpgsql as $$
declare
  cur bigint;
  hops int := 0;
begin
  if new.parent is not null then
    if (select matter from deedbox.document_folder where id = new.parent) <> new.matter then
      raise exception 'a folder and its parent belong to one matter';
    end if;
    -- no cycles: walk up from the proposed parent; meeting ourselves refuses
    cur := new.parent;
    while cur is not null loop
      if cur = new.id then
        raise exception 'a folder cannot sit inside its own descendant';
      end if;
      select parent into cur from deedbox.document_folder where id = cur;
      hops := hops + 1;
      if hops > 100 then raise exception 'folder tree too deep'; end if;
    end loop;
  end if;
  if tg_op = 'UPDATE' and new.matter is distinct from old.matter then
    raise exception 'a folder never changes matter';
  end if;
  return new;
end $$;
create trigger document_folder_guard before insert or update on deedbox.document_folder
for each row execute function deedbox.document_folder_guard();

create or replace function deedbox.document_folder_delete_guard() returns trigger
language plpgsql as $$
begin
  if exists (select 1 from deedbox.document_folder where parent = old.id) then
    raise exception 'the folder still contains folders';
  end if;
  if exists (select 1 from deedbox.document where folder = old.id) then
    raise exception 'the folder still contains documents';
  end if;
  return old;
end $$;
create trigger document_folder_delete_guard before delete on deedbox.document_folder
for each row execute function deedbox.document_folder_delete_guard();

------------------------------------------------------------------------------
-- The document head: the one mutable row per logical document.
------------------------------------------------------------------------------
create table deedbox.document (
    id bigint generated always as identity primary key,
    matter bigint not null references deedbox.matter(id),
    folder bigint references deedbox.document_folder(id),
    title text not null check (length(title) between 1 and 300),
    description text,
    document_date date,
    confidential boolean not null default false,
    related_party bigint references deedbox.party(id),
    correspondent_author text,
    correspondent_recipient text,
    current_file bigint not null references deedbox.document_file(id),
    current_version int not null default 1 check (current_version >= 1),
    checked_out_by bigint references deedbox.staff_member(id),
    checked_out_at timestamptz,
    checkout_purpose text,
    locked boolean not null default false,
    legal_hold boolean not null default false,
    created_at timestamptz not null default now(),
    created_by bigint not null references deedbox.staff_member(id),
    soft_deleted_at timestamptz,
    soft_deleted_by bigint references deedbox.staff_member(id),
    check ((checked_out_by is null) = (checked_out_at is null)),
    check (checkout_purpose is null or checked_out_by is not null),
    check ((soft_deleted_at is null) = (soft_deleted_by is null))
);
create index document_matter on deedbox.document (matter);
create index document_folder_idx on deedbox.document (folder);

create or replace function deedbox.document_guard() returns trigger
language plpgsql as $$
declare
  mstat text;
begin
  -- folder stays within the matter
  if new.folder is not null then
    if (select matter from deedbox.document_folder where id = new.folder) <> new.matter then
      raise exception 'a document and its folder belong to one matter';
    end if;
  end if;
  if tg_op = 'UPDATE' then
    if new.matter is distinct from old.matter then
      raise exception 'a document never changes matter';
    end if;
    -- a legal hold blocks soft deletion for as long as it stands
    if new.soft_deleted_at is not null and old.soft_deleted_at is null and old.legal_hold then
      raise exception 'the document is under legal hold';
    end if;
    -- a locked document admits only its own lock and hold flags
    if old.locked and new.locked
       and (new.title is distinct from old.title
         or new.description is distinct from old.description
         or new.document_date is distinct from old.document_date
         or new.confidential is distinct from old.confidential
         or new.related_party is distinct from old.related_party
         or new.correspondent_author is distinct from old.correspondent_author
         or new.correspondent_recipient is distinct from old.correspondent_recipient
         or new.folder is distinct from old.folder
         or new.current_file is distinct from old.current_file
         or new.current_version is distinct from old.current_version
         or new.checked_out_by is distinct from old.checked_out_by
         or new.soft_deleted_at is distinct from old.soft_deleted_at) then
      raise exception 'the document is locked';
    end if;
  end if;
  -- closed matters refuse document writes without the edit-closed ceremony
  select status into mstat from deedbox.matter where id = new.matter;
  if mstat in ('closed','archived')
     and coalesce(current_setting('deedbox.edit_closed', true), '') <> 'on' then
    raise exception 'every document write on a closed matter requires matter.edit_closed';
  end if;
  return new;
end $$;
create trigger document_guard before insert or update on deedbox.document
for each row execute function deedbox.document_guard();

------------------------------------------------------------------------------
-- Version rows: immutable evidence, dense per document, one row per stored
-- file. The head must agree with the newest version at commit.
------------------------------------------------------------------------------
create table deedbox.document_version (
    id bigint generated always as identity primary key,
    document bigint not null references deedbox.document(id),
    version_no int not null check (version_no >= 1),
    file bigint not null references deedbox.document_file(id),
    comment text,
    created_at timestamptz not null default now(),
    created_by bigint not null references deedbox.staff_member(id),
    unique (document, version_no),
    unique (file)
);

create or replace function deedbox.document_version_guard() returns trigger
language plpgsql as $$
declare
  head record;
begin
  select * into head from deedbox.document where id = new.document;
  -- density: each version is exactly the next number
  if new.version_no <> coalesce(
       (select max(version_no) from deedbox.document_version where document = new.document), 0) + 1 then
    raise exception 'versions are dense: expected the next number';
  end if;
  -- the file must belong to the same matter as the document
  if (select matter from deedbox.document_file where id = new.file) <> head.matter then
    raise exception 'a version file belongs to the document''s matter';
  end if;
  if head.locked then
    raise exception 'the document is locked';
  end if;
  -- checked out by another staff member: only the holder adds versions
  if head.checked_out_by is not null
     and not (coalesce(current_setting('deedbox.principal_kind', true), '') = 'staff'
              and coalesce(current_setting('deedbox.principal_id', true), '') = head.checked_out_by::text) then
    raise exception 'the document is checked out by someone else';
  end if;
  -- closed matters refuse version writes without the ceremony
  if (select status from deedbox.matter where id = head.matter) in ('closed','archived')
     and coalesce(current_setting('deedbox.edit_closed', true), '') <> 'on' then
    raise exception 'every document write on a closed matter requires matter.edit_closed';
  end if;
  return new;
end $$;
create trigger document_version_guard before insert on deedbox.document_version
for each row execute function deedbox.document_version_guard();

-- head consistency, proven at commit: the head points at the newest version
create or replace function deedbox.document_head_consistency() returns trigger
language plpgsql as $$
declare
  head record;
begin
  select * into head from deedbox.document where id = new.document;
  if head.current_version <> new.version_no or head.current_file <> new.file then
    raise exception 'the document head must carry the newest version at commit';
  end if;
  return new;
end $$;
create constraint trigger document_head_consistency
  after insert on deedbox.document_version
  deferrable initially deferred
  for each row execute function deedbox.document_head_consistency();

------------------------------------------------------------------------------
-- Access evidence: insert-only, deliberately OFF the hash chain (the
-- register carries lifecycle; every view would drown it).
------------------------------------------------------------------------------
create table deedbox.document_access (
    id bigint generated always as identity primary key,
    document bigint not null references deedbox.document(id),
    version bigint references deedbox.document_version(id),
    actor_kind text not null check (actor_kind in ('staff','portal_party','integration_key','system_job')),
    actor bigint not null,
    action text not null check (action in ('viewed','downloaded','opened_in_word','printed','compared')),
    occurred_at timestamptz not null default now(),
    detail jsonb
);
create index document_access_document on deedbox.document_access (document, occurred_at desc);

------------------------------------------------------------------------------
-- Catalogue extensions.
------------------------------------------------------------------------------
insert into deedbox.capability (key, description, grantable_to_firm_roles) values
  ('documents.manage',
   'Lock and unlock documents, set and release legal holds, delete empty folders, restore soft-deleted documents.',
   true);
insert into deedbox.role_capability (role, capability)
  select id, 'documents.manage' from deedbox.role where system_key = 'administrator';

insert into deedbox.deletion_policy (entity_type, mode) values
  ('document', 'soft_delete'),
  ('document_folder', 'hard_delete_allowed'),
  ('document_version', 'never_deletable'),
  ('document_file', 'never_deletable'),
  ('document_access', 'never_deletable');

------------------------------------------------------------------------------
-- Grants: the working posture. Heads move; evidence only accrues.
------------------------------------------------------------------------------
grant select, insert, update, delete on deedbox.document_folder to deedbox_app;
grant select, insert, update on deedbox.document to deedbox_app;
grant select, insert on deedbox.document_version to deedbox_app;
grant select, insert on deedbox.document_access to deedbox_app;

commit;
