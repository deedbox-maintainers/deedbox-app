-- Tests for 0018_app_role_extensions. Run as deployment role AFTER 0001–0018.
-- Proves the extension-backed identity machinery works AS THE APP ROLE — the
-- exact paths 0018 exists for: name folding (unaccent), the duplicate check
-- (dmetaphone + similarity), and a match-key rebuild fired by an app-role
-- write.

begin;

grant deedbox_app to current_user;

do $$
declare folded text; n int; pid bigint;
begin
  set local role deedbox_app;
  perform set_config('deedbox.principal_kind','staff', true);
  perform set_config('deedbox.principal_id','1', true);

  -- T1: folding reaches extensions.unaccent as the app role.
  folded := deedbox.fold_name('O''Brien Café');
  if folded is null or folded = '' then
    raise exception 'T1: fold_name returned nothing as deedbox_app';
  end if;

  -- T2: the duplicate check (trigram + phonetics) completes as the app role.
  select count(*) into n from deedbox.duplicate_candidates('Nobody Of Thatname', null, null);
  -- zero candidates is the expected answer; the call completing is the proof.

  -- T3: an app-role party + name write fires the match-key rebuild trigger,
  -- which folds and phoneticises — the write that first exposed the gap.
  insert into deedbox.party (kind, display_name) values ('person','Ext Grant Probe')
    returning id into pid;
  insert into deedbox.party_name (party, name_kind, full_name)
    values (pid, 'current', 'Ext Grant Probe');
  select count(*) into n from deedbox.party_match_key where party = pid;
  if n < 1 then
    raise exception 'T3: no match keys built for the app-role-created party';
  end if;

  reset role;
end $$;

rollback;
