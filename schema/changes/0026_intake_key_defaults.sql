-- 0026_intake_key_defaults — per-key creation defaults for the intake API's
-- direct-matter door, which cannot open a matter until a key names the
-- defaults to use. One row per integration key naming the office,
-- responsible lawyer and fallback practice area a matter delivered through
-- that key is opened under. The write operation (keys.manage) validates the
-- named rows are active and registers before/after; the schema fixes
-- identity and referential integrity. Deleting the row closes the matter
-- door for that key (the operation refuses typed 'key_defaults_missing') —
-- deliberate, so a firm can keep a key live for intake submissions while
-- withdrawing direct matter creation.

begin;

create table deedbox.integration_key_defaults (
    key bigint primary key references deedbox.integration_key(id),
    office bigint not null references deedbox.office(id),
    responsible_lawyer bigint not null references deedbox.staff_member(id),
    practice_area bigint not null references deedbox.practice_area(id),
    updated_at timestamptz not null default now()
);
grant select, insert, update, delete on deedbox.integration_key_defaults to deedbox_app;

create or replace function deedbox.integration_key_defaults_touch() returns trigger
language plpgsql as $$
begin
  new.updated_at := now();
  -- the key column is the row's identity
  if tg_op = 'UPDATE' and new.key is distinct from old.key then
    raise exception 'defaults belong to their key; delete and recreate to move them';
  end if;
  return new;
end $$;
create trigger integration_key_defaults_touch before update on deedbox.integration_key_defaults
for each row execute function deedbox.integration_key_defaults_touch();

commit;
