-- 0019_restriction_mirror_definer — the restricted mirror runs as owner.
--
-- Found by the application layer's restriction-change test: the mirror
-- trigger that recomputes matter.restricted from the grant rows ran with
-- the acting user's rights. When the holder of the LAST grant removed it,
-- their sight of the matter ended in the same command — the mirror's update
-- then matched zero rows under row security and the flag stayed up after
-- the restriction had ended. The schema suites never met this:
-- they ran as the deployment role, which row security does not bind.
--
-- The mirror is bookkeeping performed by the system, not a user act; it
-- carries the owner's authority. The guardian invariant is unaffected — it
-- judges from the grant rows themselves.

begin;

alter function deedbox.a_restriction_mirror()
  security definer set search_path = deedbox, pg_temp;

commit;
