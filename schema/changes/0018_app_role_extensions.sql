-- 0018_app_role_extensions — the running role reaches the extension helpers.
--
-- Found by the application layer's first real write as deedbox_app: the
-- identity machinery's folding, phonetics and similarity (0006/0007) call
-- schema-qualified extension functions (extensions.unaccent, .dmetaphone,
-- .similarity), and every write path that rebuilds match keys — party and
-- name creation included — runs them. The schema suites executed
-- those paths as the deployment role, which reaches the extensions schema
-- implicitly; deedbox_app had no USAGE on it, so the application's very
-- first party create was refused with "permission denied for schema
-- extensions". Function execute privileges are already public; schema usage
-- was the one missing gate.

begin;

grant usage on schema extensions to deedbox_app;

commit;
