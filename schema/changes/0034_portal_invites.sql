-- 0034_portal_invites — the client portal's onboarding record: a
-- staff-issued invitation binding a party to a hosted sign-in identity.
-- The rest of the portal rides machinery the engine shipped from day one:
-- the portal_client role (0003), sessions accepting portal principals
-- (0003), and the visibility predicate's portal rule (0005 — a portal
-- client sees exactly the matters whose matter_party row switched portal
-- access on). Tokens are stored only as sha256 fingerprints (the house
-- discipline); invite rows are onboarding evidence — never deletable.

begin;

create table deedbox.portal_invite (
    id bigint generated always as identity primary key,
    party bigint not null references deedbox.party(id),
    email text not null check (length(email) between 3 and 320),
    token_hash text not null unique,
    invited_by bigint not null references deedbox.staff_member(id),
    expires_at timestamptz not null,
    accepted_at timestamptz,
    login text,
    last_login_at timestamptz,
    revoked_at timestamptz,
    revoked_by bigint references deedbox.staff_member(id),
    created_at timestamptz not null default now(),
    check ((accepted_at is null) = (login is null)),
    check ((revoked_at is null) = (revoked_by is null))
);
create index portal_invite_party on deedbox.portal_invite (party);
create index portal_invite_login on deedbox.portal_invite (login) where login is not null;

create or replace function deedbox.portal_invite_guard() returns trigger
language plpgsql as $$
begin
  if new.party is distinct from old.party
     or new.token_hash is distinct from old.token_hash
     or new.invited_by is distinct from old.invited_by then
    raise exception 'an invite''s identity never changes';
  end if;
  if old.accepted_at is not null and new.accepted_at is distinct from old.accepted_at then
    raise exception 'acceptance is written exactly once';
  end if;
  if old.revoked_at is not null and new.revoked_at is distinct from old.revoked_at then
    raise exception 'revocation is written exactly once';
  end if;
  if new.accepted_at is not null and old.accepted_at is null and old.revoked_at is not null then
    raise exception 'a revoked invite never accepts';
  end if;
  return new;
end $$;
create trigger portal_invite_guard before update on deedbox.portal_invite
for each row execute function deedbox.portal_invite_guard();

insert into deedbox.deletion_policy (entity_type, mode) values
  ('portal_invite', 'never_deletable');

grant select, insert, update on deedbox.portal_invite to deedbox_app;

commit;
