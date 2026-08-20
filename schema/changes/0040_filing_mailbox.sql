-- 0040: the shared filing-mailbox leg (email-to-file), the earlier
-- recorded deferral. A matter may hold a filing token: mail addressed to
-- filing+<token>@<the firm's shared filing mailbox> is filed onto that
-- matter as documents by a polling job riding the reader staff member's
-- own Microsoft 365 connection. This change adds the three homes the leg
-- needs; the seam growth, the job and the screens live in the app layer.

-- 1. The per-matter filing token: lowercase alphanumeric, minted by the
--    app on demand, unique across the installation where set.
alter table deedbox.matter add column filing_token text
  check (filing_token is null or filing_token ~ '^[a-z0-9]{8,32}$');
create unique index matter_filing_token_unique
  on deedbox.matter (filing_token) where filing_token is not null;

-- 2. The filing receipt: the proof one inbound message was filed onto one
--    matter exactly once — the dedup the poll's overlap window rides
--    (the matter_email shape, applied to email-to-file).
create table deedbox.m365_filing_receipt (
    id bigint generated always as identity primary key,
    matter bigint not null references deedbox.matter(id),
    internet_message_id text not null,
    subject text,
    from_address text,
    document_count int not null default 0,
    filed_at timestamptz not null default now(),
    unique (matter, internet_message_id)
);
grant select, insert on deedbox.m365_filing_receipt to deedbox_app;

insert into deedbox.deletion_policy (entity_type, mode) values
  ('m365_filing_receipt', 'never_deletable');

-- 3. Filed mail lands in the same evidence table every other arrival
--    proved: source gains 'email_filing'. A CHECK swap must restate the
--    LATEST vocabulary, not the table's original one — 0032 had already
--    added 'signing', and rebuilding from 0030's list silently dropped it
--    (the chain gate's 0032 suite caught the regression).
alter table deedbox.document_file drop constraint document_file_source_check;
alter table deedbox.document_file add constraint document_file_source_check
  check (source in ('intake_api','staff_upload','template_generation','signing','email_filing'));

-- 4. The poll's watermark: one row, advanced after every sweep (the
--    anomaly-cursor precedent — runtime state, never a setting, because
--    settings history is insert-only evidence).
create table deedbox.m365_filing_cursor (
    only_row boolean primary key default true check (only_row),
    last_polled_at timestamptz not null
);
grant select, insert, update on deedbox.m365_filing_cursor to deedbox_app;

insert into deedbox.deletion_policy (entity_type, mode) values
  ('m365_filing_cursor', 'hard_delete_allowed');

-- 5. The two firm settings that switch the leg on (both blank = off; the
--    reader is the staff member whose connected Microsoft 365 account
--    holds Full Access to the shared mailbox).
insert into deedbox.setting_definition (key, value_type, neutral_default, allowed_values, description) values
('m365.filing_mailbox_address','text','""',null,
 'The firm''s shared filing mailbox address (for example filing@your-firm.example). Mail sent to filing+<matter token>@… there is filed onto the matter as documents. Blank means the email-to-file leg is off.'),
('m365.filing_reader_email','text','""',null,
 'The email address of the connected Microsoft 365 account that reads the shared filing mailbox (a staff member holding Full Access to it). Blank means the email-to-file leg is off.');
