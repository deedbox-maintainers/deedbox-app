-- The reference scheduler ("the clock") for a DeedBox installation on
-- PostgreSQL with pg_cron + pg_net + the Vault extension (Supabase's stack;
-- any Postgres carrying all three works). Elsewhere, use the curl
-- alternative below. The application ships twenty-four background jobs behind
-- POST /api/jobs/<job> guarded by the DEEDBOX_JOB_SECRET header — and they
-- are INERT until something calls them. This file is that something.
--
-- What it installs, idempotently:
--   * an `ops` schema with a call log;
--   * the job secret in the database vault (never in the schedule text);
--   * ops.run_app_job(job) — reads the secret at call time and knocks;
--   * the schedule below (eighteen jobs; see the held-off list).
--
-- Usage (psql, three variables):
--
--   psql "$DATABASE_URL" \
--     -v app_url='https://your-installation.example' \
--     -v job_secret='the value of DEEDBOX_JOB_SECRET' \
--     -v prefix='firm' \
--     -f tools/install-scheduler.sql
--
-- No pg_cron? Any scheduler works — the door is plain HTTPS:
--
--   curl -X POST -H "x-job-secret: $DEEDBOX_JOB_SECRET" \
--        https://your-installation.example/api/jobs/outbound-dispatch
--
-- run from cron/systemd/Task Scheduler at the cadences below.
--
-- DELIBERATELY NOT SCHEDULED (each is a decision, not an oversight):
--   reminder-scheduler, instalment-notifications, instalment-collections,
--   missed-instalment-detection — these WRITE TO CLIENTS. Schedule them only
--   once the firm's reminder sequences and templates are set up and the firm
--   has decided to send reminders automatically.
--   m365-mail-poll, m365-filing-poll — only where the Microsoft 365 seam is
--   bound; uncomment their two lines below when it is.
--
-- Cadences are UTC (pg_cron's clock). The daily band below is small-hours
-- for UTC+10; shift it to suit your timezone.

-- 1. extensions (create only what is absent; on Supabase, re-creating
--    pg_cron trips its grant hook)
select 'create extension pg_cron with schema pg_catalog'
 where not exists (select 1 from pg_extension where extname = 'pg_cron') \gexec
select 'grant usage on schema cron to postgres'
 where not exists (select 1 from pg_extension where extname = 'pg_cron') \gexec
select 'create extension pg_net with schema extensions'
 where not exists (select 1 from pg_extension where extname = 'pg_net') \gexec

-- 2. the ops schema and the call log
create schema if not exists ops;
create table if not exists ops.job_call (
  id bigserial primary key,
  job text not null,
  request_id bigint,
  called_at timestamptz not null default now()
);
revoke all on schema ops from public;

-- 3. the secret, in the vault (updated in place on re-runs)
select case
  when exists (select 1 from vault.secrets where name = 'deedbox_job_secret')
  then format('select vault.update_secret(%L::uuid, %L, %L, %L)',
              (select id from vault.secrets where name = 'deedbox_job_secret'),
              :'job_secret', 'deedbox_job_secret', 'the app jobs door (x-job-secret)')
  else format('select vault.create_secret(%L, %L, %L)',
              :'job_secret', 'deedbox_job_secret', 'the app jobs door (x-job-secret)')
end \gexec

-- 4. the knocker: reads the secret at call time, posts, logs the call
select format($f$
  create or replace function ops.run_app_job(p_job text) returns bigint
  language plpgsql security definer set search_path = ''
  as $fn$
  declare v_secret text; v_id bigint;
  begin
    select decrypted_secret into v_secret from vault.decrypted_secrets where name = 'deedbox_job_secret';
    if v_secret is null then
      raise exception 'deedbox_job_secret is missing from the vault';
    end if;
    select net.http_post(
      url := %L || p_job,
      headers := jsonb_build_object('x-job-secret', v_secret, 'content-type', 'application/json'),
      body := '{}'::jsonb,
      timeout_milliseconds := 55000) into v_id;
    insert into ops.job_call (job, request_id) values (p_job, v_id);
    return v_id;
  end $fn$;
$f$, :'app_url' || '/api/jobs/') \gexec
revoke all on function ops.run_app_job(text) from public;

-- 5. the schedule — re-created from this table on every run
select format('select cron.unschedule(jobid) from cron.job where jobname = %L', :'prefix' || '-' || j)
  from unnest(array[
    'outbound-dispatch','session-timeouts','anomaly-evaluation','document-text-extraction',
    'threshold-sweep','schedule-sends','remainder-routing','stale-instruments',
    'dormancy-detection','close-materialiser','set-aside-recalculation','interest-proposals',
    'examiner-expiry','chain-verifier','gl-sync','cache-recompute','cache-verify','index-rebuild',
    'reminder-scheduler','instalment-notifications','instalment-collections',
    'missed-instalment-detection','m365-mail-poll','m365-filing-poll']) as j \gexec

select format('select cron.schedule(%L, %L, %L)',
              :'prefix' || '-' || j.name, j.cadence,
              'select ops.run_app_job(' || quote_literal(j.name) || ')')
  from (values
    ('outbound-dispatch',        '*/2 * * * *'),
    ('session-timeouts',         '*/5 * * * *'),
    ('anomaly-evaluation',       '1-59/5 * * * *'),
    ('document-text-extraction', '3-59/10 * * * *'),
    ('threshold-sweep',          '7 * * * *'),
    ('schedule-sends',           '12 * * * *'),
    ('remainder-routing',        '5 16 * * *'),
    ('stale-instruments',        '10 16 * * *'),
    ('dormancy-detection',       '15 16 * * *'),
    ('close-materialiser',       '20 16 * * *'),
    ('set-aside-recalculation',  '25 16 * * *'),
    ('interest-proposals',       '30 16 * * *'),
    ('examiner-expiry',          '35 16 * * *'),
    ('chain-verifier',           '40 16 * * *'),
    ('gl-sync',                  '45 16 * * *'),
    ('cache-recompute',          '0 17 * * *'),
    ('cache-verify',             '20 17 * * *'),
    ('index-rebuild',            '30 17 * * 0')
    -- , ('reminder-scheduler',   '15 * * * *')      -- writes to clients: schedule deliberately
    -- , ('m365-mail-poll',       '2-59/5 * * * *')  -- once the Microsoft 365 seam is bound
    -- , ('m365-filing-poll',     '4-59/5 * * * *')
  ) as j(name, cadence) \gexec

-- 6. see it working
select jobname, schedule, active from cron.job order by jobname;
