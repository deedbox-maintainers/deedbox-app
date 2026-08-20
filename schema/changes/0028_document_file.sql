-- 0028_document_file — the core's landing record for machine-delivered files
-- (the intake API's documents half, opened by the document-store binding).
-- The core owns no document management of its own — files belong to the
-- documents module — but the intake door needs an honest landing place
-- TODAY: a permanent record of what arrived, where its bytes were put, and
-- under whose authority, discoverable by matter. The documents module
-- extends this home (folders, versions, lifecycle ceremonies) when it lands
-- as its own numbered change; nothing here presumes its shape.
--
-- Posture: rows are evidence of arrival. The app role may insert and read,
-- never change or remove (no grant) — the same append-only-through-grants
-- stance the register suites proved. storage_ref is unique: one record per
-- stored object; two documents may freely share a filename.

begin;

create table deedbox.document_file (
    id bigint generated always as identity primary key,
    matter bigint not null references deedbox.matter(id),
    filename text not null check (length(filename) between 1 and 300),
    content_type text not null default 'application/octet-stream',
    size_bytes bigint not null check (size_bytes > 0),
    storage_ref text not null unique,
    source text not null check (source in ('intake_api')),
    integration_key bigint references deedbox.integration_key(id),
    external_ref text,
    uploaded_at timestamptz not null default now()
);
create index document_file_matter on deedbox.document_file (matter);

grant select, insert on deedbox.document_file to deedbox_app;

commit;
