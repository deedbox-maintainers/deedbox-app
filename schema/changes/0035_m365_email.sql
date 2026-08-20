-- 0035_m365_email — the Microsoft 365 email module's home: per-lawyer
-- connections (tokens at rest; the platform owns disk encryption), the
-- filed correspondence record (append-only evidence, deduped on the
-- internet message id), and matter calendar events. The Graph connection
-- itself is an app seam; the shared filing-mailbox leg defers to its own
-- increment.

begin;

create table deedbox.m365_connection (
    id bigint generated always as identity primary key,
    staff bigint not null unique references deedbox.staff_member(id),
    ms_user_id text not null,
    email text not null,
    display_name text,
    scopes text,
    access_token text not null,
    refresh_token text not null,
    token_expires_at timestamptz not null,
    active boolean not null default true,
    connected_at timestamptz not null default now(),
    last_polled_at timestamptz
);
grant select, insert, update on deedbox.m365_connection to deedbox_app;

create table deedbox.matter_email (
    id bigint generated always as identity primary key,
    matter bigint not null references deedbox.matter(id),
    staff bigint references deedbox.staff_member(id),
    direction text not null check (direction in ('sent','received')),
    from_address text,
    to_addresses text[],
    cc_addresses text[],
    subject text,
    body_preview text,
    body_html text,
    ms_message_id text,
    ms_internet_message_id text,
    occurred_at timestamptz not null,
    created_at timestamptz not null default now(),
    unique (matter, ms_internet_message_id)
);
create index matter_email_matter on deedbox.matter_email (matter, occurred_at desc);
grant select, insert on deedbox.matter_email to deedbox_app;

create table deedbox.matter_calendar_event (
    id bigint generated always as identity primary key,
    matter bigint not null references deedbox.matter(id),
    staff bigint not null references deedbox.staff_member(id),
    ms_event_id text not null unique,
    subject text not null,
    location text,
    starts_at timestamptz not null,
    ends_at timestamptz,
    web_link text,
    created_at timestamptz not null default now()
);
create index matter_calendar_event_matter on deedbox.matter_calendar_event (matter, starts_at);
grant select, insert, update on deedbox.matter_calendar_event to deedbox_app;

insert into deedbox.deletion_policy (entity_type, mode) values
  ('m365_connection', 'hard_delete_allowed'),
  ('matter_email', 'never_deletable'),
  ('matter_calendar_event', 'hard_delete_allowed');

commit;
