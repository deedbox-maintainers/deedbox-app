-- 0037_gl_journal_number_purpose — the gl_journal numbering purpose, alone.
--
-- A value added to an enum cannot be USED in the transaction that adds it
-- (Postgres 55P04), and the chain applier runs each change file as one
-- transaction — so the enum addition gets its own numbered change, and
-- 0038 (the GL module) is free to reference it. No begin/commit: the one
-- statement rides the applier's own transaction.

alter type deedbox.number_purpose add value 'gl_journal';
