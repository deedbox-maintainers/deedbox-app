-- 0044: documents and file notes learn their import shapes.
--
-- The migration workbook's two remaining record domains (owner decision).
-- Two enablements:
--
--   * an imported file carries its own honest source label — it is not a
--     staff upload, and pretending otherwise would falsify provenance;
--   * a note says who wrote it. The author is general-purpose: native notes
--     stamp their creator from now on, imported notes carry the historical
--     author, and an unknown author stays honestly unknown (null). Once set
--     it never changes — authorship is a fact, not an opinion.

alter table deedbox.document_file drop constraint document_file_source_check;
alter table deedbox.document_file add constraint document_file_source_check
  check (source in ('intake_api','staff_upload','template_generation','signing',
                    'email_filing','import'));

-- A real archive carries genuinely empty files (failed saves in the source
-- system's own life — bytes 0, object present). A file's existence is the
-- fact; emptiness is its content. The size rule admits zero, never less.
alter table deedbox.document_file drop constraint document_file_size_bytes_check;
alter table deedbox.document_file add constraint document_file_size_bytes_check
  check (size_bytes >= 0);

-- The batch engine's domain vocabulary learns the two new record domains.
alter table deedbox.import_batch drop constraint import_batch_record_domain_check;
alter table deedbox.import_batch add constraint import_batch_record_domain_check
  check (record_domain in
    ('clients','matters','bills','time','client_money_full_history',
     'client_money_opening_balances','other','documents','notes'));

-- The head-consistency proof learns that HISTORY CAN ARRIVE: an import
-- lands a document's whole version chain in one transaction, and the old
-- per-row form refused the superseded rows (the head rightly carries the
-- newest, which is not them). The invariant is unchanged — at commit the
-- head carries the newest version — but it is proven against the newest
-- row, which for the one-version-per-transaction live paths is exactly the
-- test it always was (0030's own suite continues to prove both directions).
create or replace function deedbox.document_head_consistency() returns trigger
language plpgsql as $$
declare
  head record;
  newest record;
begin
  select * into head from deedbox.document where id = new.document;
  select version_no, file into newest
    from deedbox.document_version
   where document = new.document
   order by version_no desc limit 1;
  if head.current_version <> newest.version_no or head.current_file <> newest.file then
    raise exception 'the document head must carry the newest version at commit';
  end if;
  return new;
end $$;

alter table deedbox.note add column author bigint references deedbox.staff_member(id);

comment on column deedbox.note.author is
  'Who wrote the note: the creating staff member for native notes, the '
  'historical author for imported ones. Nullable — unknown stays unknown. '
  'Immutable once set.';

create or replace function deedbox.note_author_guard() returns trigger
language plpgsql as $$
begin
  if old.author is not null and new.author is distinct from old.author then
    raise exception 'a note''s author is immutable once set';
  end if;
  return new;
end $$;

create trigger note_author_guard
  before update on deedbox.note
  for each row execute function deedbox.note_author_guard();
