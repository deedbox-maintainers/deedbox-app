-- Tests for 0062_templates_read_door. Run as deployment role AFTER the full
-- chain. The switch is born off, flips on a live key, and dies with
-- revocation like every other key attribute; the engine article is present.
-- The door itself — permission refusal, evidence, scope — is pinned in the
-- application suite (the templates read door).

begin;

do $$
declare
  o bigint; r_admin bigint; s_admin bigint; k bigint;
  flag boolean; refused boolean := false;
begin
  insert into deedbox.office (name, code) values ('T62','T62') returning id into o;
  select id into r_admin from deedbox.role where system_key = 'administrator';
  insert into deedbox.staff_member (person_name, login, role, office, email)
    values ('{"display":"Ada Sixty-two"}','ada62', r_admin, o, 'ada62@x.test') returning id into s_admin;

  -- T1: a key is born with template reading OFF
  insert into deedbox.integration_key (label, secret_hash, issued_by, key_display)
    values ('T62 key', 't62hash', s_admin, 't62-disp') returning id into k;
  select templates_read into flag from deedbox.integration_key where id = k;
  if flag then
    raise exception 'T1 FAILED: a fresh key was born with template reading on';
  end if;

  -- T2: the switch flips on a live key (a non-identity column, guard permits)
  update deedbox.integration_key set templates_read = true where id = k;
  select templates_read into flag from deedbox.integration_key where id = k;
  if not flag then
    raise exception 'T2 FAILED: the switch did not flip on a live key';
  end if;

  -- T3: a revoked key is immutable — the switch included
  update deedbox.integration_key set revoked_at = now() where id = k;
  begin
    update deedbox.integration_key set templates_read = false where id = k;
  exception when others then
    refused := true;
    if position('immutable' in sqlerrm) = 0 then
      raise exception 'T3 FAILED: wrong refusal: %', sqlerrm;
    end if;
  end;
  if not refused then
    raise exception 'T3 FAILED: a revoked key accepted a switch change';
  end if;

  -- T4: the engine article is present and published
  if not exists (select 1 from deedbox.assistant_article
                  where firm is null and slug = 'template-reading-for-keys'
                    and status = 'published') then
    raise exception 'T4 FAILED: the template-reading article is absent';
  end if;
end $$;

rollback;
