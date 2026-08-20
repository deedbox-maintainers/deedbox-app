-- 0043: the matter's prior-system reference.
--
-- A migrated matter arrives with a new matter number — the engine allocates
-- its own gapless numbers, stamped with the year of allocation. The number
-- the file carried in the system it came from is already preserved as the
-- record's source reference and lands in the search-indexed origin note, but
-- until this change it never appeared ON the matter, where the people who
-- lived with the old numbers go looking for it.
--
-- One nullable column. The import path writes it; once set it is immutable —
-- a prior-system reference is a statement of where the record came from, and
-- provenance does not change. Owner decision.

alter table deedbox.matter add column prior_reference text
  check (prior_reference is null or length(prior_reference) between 1 and 120);

comment on column deedbox.matter.prior_reference is
  'The matter''s number or reference in the system it was migrated from. '
  'Written by the import path; immutable once set; displayed on the matter.';

create or replace function deedbox.matter_prior_reference_guard() returns trigger
language plpgsql as $$
begin
  if old.prior_reference is not null
     and new.prior_reference is distinct from old.prior_reference then
    raise exception 'prior_reference is immutable once set';
  end if;
  return new;
end $$;

create trigger matter_prior_reference_guard
  before update on deedbox.matter
  for each row execute function deedbox.matter_prior_reference_guard();
