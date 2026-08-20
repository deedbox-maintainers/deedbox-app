-- 0032_sharing_esign — the sharing + e-signature module's home: secure
-- share links (token fingerprint, optional password, expiry, view budget,
-- revocation, watermark flag) and signing requests (pinned version,
-- forward-only status, full signing forensics, the stamped copy filed as
-- its own document). Both rows are DISCLOSURE EVIDENCE — never deletable.
-- Deliberate choices here: tokens are stored only as sha256 fingerprints,
-- and the exact version is pinned at creation so the evidence shows
-- precisely what was disclosed.

begin;

------------------------------------------------------------------------------
-- Share links.
------------------------------------------------------------------------------
create table deedbox.document_share (
    id bigint generated always as identity primary key,
    document bigint not null references deedbox.document(id),
    version bigint not null references deedbox.document_version(id),
    recipient_name text,
    recipient_email text,
    note text,
    token_hash text not null unique,
    password_hash text,
    expires_at timestamptz not null,
    max_views int check (max_views > 0),
    view_count int not null default 0 check (view_count >= 0),
    allow_download boolean not null default true,
    watermark boolean not null default true,
    revoked_at timestamptz,
    revoked_by bigint references deedbox.staff_member(id),
    created_at timestamptz not null default now(),
    created_by bigint not null references deedbox.staff_member(id),
    check ((revoked_at is null) = (revoked_by is null))
);
create index document_share_document on deedbox.document_share (document);

------------------------------------------------------------------------------
-- Signing requests: pending → signed | revoked, forward-only.
------------------------------------------------------------------------------
create table deedbox.document_signing_request (
    id bigint generated always as identity primary key,
    document bigint not null references deedbox.document(id),
    version bigint not null references deedbox.document_version(id),
    signer_name text not null check (length(signer_name) between 1 and 200),
    signer_email text not null check (length(signer_email) between 3 and 320),
    token_hash text not null unique,
    status text not null default 'pending' check (status in ('pending','signed','revoked')),
    expires_at timestamptz not null,
    signed_at timestamptz,
    signature_data text,
    signer_ip inet,
    signer_user_agent text,
    signed_document bigint references deedbox.document(id),
    revoked_at timestamptz,
    revoked_by bigint references deedbox.staff_member(id),
    created_at timestamptz not null default now(),
    created_by bigint not null references deedbox.staff_member(id),
    check (status <> 'signed' or (signed_at is not null and signature_data is not null and signed_document is not null)),
    check (status <> 'revoked' or revoked_at is not null)
);
create index document_signing_request_document on deedbox.document_signing_request (document);

create or replace function deedbox.signing_request_guard() returns trigger
language plpgsql as $$
begin
  -- forward-only: exactly pending → signed and pending → revoked
  if new.status is distinct from old.status then
    if not (old.status = 'pending' and new.status in ('signed','revoked')) then
      raise exception 'a signing request moves only from pending to signed or revoked';
    end if;
  else
    -- no rewriting a settled request's evidence
    if old.status <> 'pending' then
      raise exception 'a settled signing request never changes';
    end if;
  end if;
  -- identity immutable
  if new.document is distinct from old.document
     or new.version is distinct from old.version
     or new.token_hash is distinct from old.token_hash
     or new.created_by is distinct from old.created_by then
    raise exception 'a signing request''s identity never changes';
  end if;
  return new;
end $$;
create trigger signing_request_guard before update on deedbox.document_signing_request
for each row execute function deedbox.signing_request_guard();

------------------------------------------------------------------------------
-- Vocabulary widenings: outside actors on the access evidence, and the
-- stamped copy's provenance on the landing store.
------------------------------------------------------------------------------
alter table deedbox.document_access drop constraint document_access_actor_kind_check;
alter table deedbox.document_access add constraint document_access_actor_kind_check
  check (actor_kind in ('staff','portal_party','integration_key','system_job','share_recipient','signer'));

alter table deedbox.document_file drop constraint document_file_source_check;
alter table deedbox.document_file add constraint document_file_source_check
  check (source in ('intake_api','staff_upload','template_generation','signing'));

insert into deedbox.deletion_policy (entity_type, mode) values
  ('document_share', 'never_deletable'),
  ('document_signing_request', 'never_deletable');

grant select, insert, update on deedbox.document_share to deedbox_app;
grant select, insert, update on deedbox.document_signing_request to deedbox_app;

commit;
