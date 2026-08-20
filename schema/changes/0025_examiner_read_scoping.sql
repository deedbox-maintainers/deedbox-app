-- 0025_examiner_read_scoping — the examiner read scope lands with the
-- examiner surfaces: the examiner-scoped row policies belong with the
-- examiner screens, where the reads actually happen.
-- Row policies scope every read to money records within the examined period
-- plus the fixed per-ledger header; every write attempt is refused. The
-- examiner actor-kind gate stands in front. The money domain defines what an
-- examiner may see — money records for the granted period, plus, per ledger,
-- a minimal identifying header of exactly ledger number, client display name
-- and matter reference.
--
-- Mechanics:
--   * Row security switches ON for the money evidence tables (and party).
--     Each table receives a RUNTIME policy that admits exactly the four
--     non-examiner principal kinds — preserving today's behaviour for every
--     existing path bit-for-bit (capability gates stay in the access layer)
--     while making absent context fail closed — plus an EXAMINER read policy
--     scoped to the CURRENT grant's examined period. The grant is the request
--     principal: deedbox.principal_kind = 'examiner' and deedbox.principal_id
--     = the examiner_grant id (0003's session model).
--   * The identity pinhole deedbox.examiner_ledger_header(ledger) is
--     SECURITY DEFINER: matter and party row policies stay closed to
--     examiners; surfaces render identity ONLY through the header function,
--     which serves exactly the fixed trio (plus the restricted flag, which
--     the export operation needs for its register entry's restricted-matter
--     count — surfaces never render it).
--   * register_entry: examiners may SELECT only the master-data journal
--     (event_kind = 'master_data.changed') within the period, and may INSERT
--     only the platform's own read receipts (examiner.read) and their pack
--     export's record (export.performed) — the "every write attempt is
--     refused" rule with those two required writes carved out.
--
-- Scoping notes (per-table date basis):
--   * money_transaction / ledger_line / ledger_transfer: the transaction's
--     effective_date within the period — the books' own dating, so imported
--     history examines by when money moved, not when it was keyed.
--   * money_receipt: received_date; cross_account_transfer: its receipt's
--     received_date (both sides post in one transaction).
--   * money_payment: only EXECUTED payments (transaction is not null), by
--     the transaction's effective date — drafts and pending requests are not
--     movements; refused attempts reach the examiner via the refusal
--     register, not the payment table.
--   * instrument: in existence by the period end (birth transaction's
--     effective_date <= period_end) — an unpresented cheque from before the
--     period is exactly the evidence a period reconciliation carries.
--   * bank_statement_line: line_date <= period_end (context for carried
--     exceptions); deficiency_incident: incident_date <= period_end (an
--     unrectified older deficiency is what an examiner exists to find).
--   * reconciliation and its children: statement_date within the period.
--   * period_close / balance_listing_line / client_money_statement: the
--     record's own period overlaps the examined period.
--   * refused_operation: at::date within; remittance_register:
--     remitted_date within.
--   * client_account / matter_ledger: the reference frame — visible while
--     the grant is active and in-window (no date column of their own).
--   * party: row security ON, no examiner policy — structurally closed; the
--     pinhole is the only identity path. (party_name and the other identity
--     children stay app-gated: no examiner surface touches them and the
--     examiner role has no other query path.)

begin;

------------------------------------------------------------------------------
-- Context helpers. The period helpers return NULL unless the CURRENT request
-- context is an unrevoked, in-window examiner grant — so every policy below
-- fails closed on absent, foreign or expired context.
------------------------------------------------------------------------------
create or replace function deedbox.non_examiner_context() returns boolean
language sql stable as $$
  select coalesce(current_setting('deedbox.principal_kind', true), '')
         in ('staff','portal_client','system_job','integration_key')
$$;
grant execute on function deedbox.non_examiner_context() to deedbox_app;

create or replace function deedbox.examiner_period_start() returns date
security definer set search_path = deedbox, pg_temp
language sql stable as $$
  select g.period_start
    from deedbox.examiner_grant g
   where current_setting('deedbox.principal_kind', true) = 'examiner'
     and g.id = nullif(current_setting('deedbox.principal_id', true), '')::bigint
     and g.revoked_at is null
     and now() >= g.starts_at and now() < g.expires_at
$$;
grant execute on function deedbox.examiner_period_start() to deedbox_app;

create or replace function deedbox.examiner_period_end() returns date
security definer set search_path = deedbox, pg_temp
language sql stable as $$
  select g.period_end
    from deedbox.examiner_grant g
   where current_setting('deedbox.principal_kind', true) = 'examiner'
     and g.id = nullif(current_setting('deedbox.principal_id', true), '')::bigint
     and g.revoked_at is null
     and now() >= g.starts_at and now() < g.expires_at
$$;
grant execute on function deedbox.examiner_period_end() to deedbox_app;

-- Definer date lookups so child-row policies never recurse through the
-- parent tables' own policies.
create or replace function deedbox.txn_effective_date(p_txn bigint) returns date
security definer set search_path = deedbox, pg_temp
language sql stable as $$
  select t.effective_date from deedbox.money_transaction t where t.id = p_txn
$$;
grant execute on function deedbox.txn_effective_date(bigint) to deedbox_app;

create or replace function deedbox.receipt_received_date(p_receipt bigint) returns date
security definer set search_path = deedbox, pg_temp
language sql stable as $$
  select r.received_date from deedbox.money_receipt r where r.id = p_receipt
$$;
grant execute on function deedbox.receipt_received_date(bigint) to deedbox_app;

create or replace function deedbox.recon_statement_date(p_recon bigint) returns date
security definer set search_path = deedbox, pg_temp
language sql stable as $$
  select r.statement_date from deedbox.reconciliation r where r.id = p_recon
$$;
grant execute on function deedbox.recon_statement_date(bigint) to deedbox_app;

create or replace function deedbox.match_recon_statement_date(p_match bigint) returns date
security definer set search_path = deedbox, pg_temp
language sql stable as $$
  select r.statement_date
    from deedbox.recon_match g
    join deedbox.reconciliation r on r.id = g.reconciliation
   where g.id = p_match
$$;
grant execute on function deedbox.match_recon_statement_date(bigint) to deedbox_app;

create or replace function deedbox.close_in_examined_period(p_close bigint) returns boolean
security definer set search_path = deedbox, pg_temp
language sql stable as $$
  select pc.period_start <= deedbox.examiner_period_end()
     and pc.period_end   >= deedbox.examiner_period_start()
    from deedbox.period_close pc
   where pc.id = p_close
$$;
grant execute on function deedbox.close_in_examined_period(bigint) to deedbox_app;

------------------------------------------------------------------------------
-- The identity pinhole (the fixed header). SECURITY DEFINER: serves the
-- trio to an active examiner context ONLY; empty for everyone else — staff
-- read identity through the ordinary predicate paths, never through this.
-- The restricted flag rides for the export operation's register entry; no
-- surface renders it. Matterless ledgers (set-aside holding and contra) are
-- firm-level money records: ledger number only, identity columns null.
------------------------------------------------------------------------------
create or replace function deedbox.examiner_ledger_header(p_ledger bigint)
returns table (ledger_number text, client_display_name text, matter_reference text, restricted boolean)
security definer set search_path = deedbox, pg_temp
language sql stable as $$
  select ml.ledger_number,
         case when ml.matter is null then null::text else pt.display_name end,
         case when ml.matter is null then null::text else m.matter_number end,
         coalesce(m.restricted, false)
    from deedbox.matter_ledger ml
    left join deedbox.matter m on m.id = ml.matter
    left join deedbox.party pt on pt.id = m.client_party
   where ml.id = p_ledger
     and deedbox.examiner_period_start() is not null
$$;
grant execute on function deedbox.examiner_ledger_header(bigint) to deedbox_app;

------------------------------------------------------------------------------
-- The reference frame: accounts and ledgers, visible while the grant is
-- active. Every policied table: runtime policy for the four non-examiner
-- kinds (today's behaviour, context-fail-closed), examiner read policy per
-- the scoping map above.
------------------------------------------------------------------------------
alter table deedbox.client_account enable row level security;
create policy client_account_runtime on deedbox.client_account
  for all to deedbox_app
  using (deedbox.non_examiner_context()) with check (deedbox.non_examiner_context());
create policy client_account_examiner on deedbox.client_account
  for select to deedbox_app
  using (deedbox.examiner_period_start() is not null);

alter table deedbox.matter_ledger enable row level security;
create policy matter_ledger_runtime on deedbox.matter_ledger
  for all to deedbox_app
  using (deedbox.non_examiner_context()) with check (deedbox.non_examiner_context());
create policy matter_ledger_examiner on deedbox.matter_ledger
  for select to deedbox_app
  using (deedbox.examiner_period_start() is not null);

------------------------------------------------------------------------------
-- Movements: the spine and its documents.
------------------------------------------------------------------------------
alter table deedbox.money_transaction enable row level security;
create policy money_transaction_runtime on deedbox.money_transaction
  for all to deedbox_app
  using (deedbox.non_examiner_context()) with check (deedbox.non_examiner_context());
create policy money_transaction_examiner on deedbox.money_transaction
  for select to deedbox_app
  using (effective_date between deedbox.examiner_period_start() and deedbox.examiner_period_end());

alter table deedbox.ledger_line enable row level security;
create policy ledger_line_runtime on deedbox.ledger_line
  for all to deedbox_app
  using (deedbox.non_examiner_context()) with check (deedbox.non_examiner_context());
create policy ledger_line_examiner on deedbox.ledger_line
  for select to deedbox_app
  using (deedbox.txn_effective_date(transaction)
         between deedbox.examiner_period_start() and deedbox.examiner_period_end());

alter table deedbox.money_receipt enable row level security;
create policy money_receipt_runtime on deedbox.money_receipt
  for all to deedbox_app
  using (deedbox.non_examiner_context()) with check (deedbox.non_examiner_context());
create policy money_receipt_examiner on deedbox.money_receipt
  for select to deedbox_app
  using (received_date between deedbox.examiner_period_start() and deedbox.examiner_period_end());

alter table deedbox.money_payment enable row level security;
create policy money_payment_runtime on deedbox.money_payment
  for all to deedbox_app
  using (deedbox.non_examiner_context()) with check (deedbox.non_examiner_context());
create policy money_payment_examiner on deedbox.money_payment
  for select to deedbox_app
  using (transaction is not null
         and deedbox.txn_effective_date(transaction)
             between deedbox.examiner_period_start() and deedbox.examiner_period_end());

alter table deedbox.ledger_transfer enable row level security;
create policy ledger_transfer_runtime on deedbox.ledger_transfer
  for all to deedbox_app
  using (deedbox.non_examiner_context()) with check (deedbox.non_examiner_context());
create policy ledger_transfer_examiner on deedbox.ledger_transfer
  for select to deedbox_app
  using (deedbox.txn_effective_date(transaction)
         between deedbox.examiner_period_start() and deedbox.examiner_period_end());

alter table deedbox.cross_account_transfer enable row level security;
create policy cross_account_transfer_runtime on deedbox.cross_account_transfer
  for all to deedbox_app
  using (deedbox.non_examiner_context()) with check (deedbox.non_examiner_context());
create policy cross_account_transfer_examiner on deedbox.cross_account_transfer
  for select to deedbox_app
  using (deedbox.receipt_received_date(receipt)
         between deedbox.examiner_period_start() and deedbox.examiner_period_end());

alter table deedbox.instrument enable row level security;
create policy instrument_runtime on deedbox.instrument
  for all to deedbox_app
  using (deedbox.non_examiner_context()) with check (deedbox.non_examiner_context());
create policy instrument_examiner on deedbox.instrument
  for select to deedbox_app
  using (deedbox.txn_effective_date(transaction) <= deedbox.examiner_period_end());

------------------------------------------------------------------------------
-- Evidence of failure and statutory records.
------------------------------------------------------------------------------
alter table deedbox.refused_operation enable row level security;
create policy refused_operation_runtime on deedbox.refused_operation
  for all to deedbox_app
  using (deedbox.non_examiner_context()) with check (deedbox.non_examiner_context());
create policy refused_operation_examiner on deedbox.refused_operation
  for select to deedbox_app
  using (at::date between deedbox.examiner_period_start() and deedbox.examiner_period_end());

alter table deedbox.deficiency_incident enable row level security;
create policy deficiency_incident_runtime on deedbox.deficiency_incident
  for all to deedbox_app
  using (deedbox.non_examiner_context()) with check (deedbox.non_examiner_context());
create policy deficiency_incident_examiner on deedbox.deficiency_incident
  for select to deedbox_app
  using (incident_date <= deedbox.examiner_period_end());

alter table deedbox.bank_statement_line enable row level security;
create policy bank_statement_line_runtime on deedbox.bank_statement_line
  for all to deedbox_app
  using (deedbox.non_examiner_context()) with check (deedbox.non_examiner_context());
create policy bank_statement_line_examiner on deedbox.bank_statement_line
  for select to deedbox_app
  using (line_date <= deedbox.examiner_period_end());

alter table deedbox.reconciliation enable row level security;
create policy reconciliation_runtime on deedbox.reconciliation
  for all to deedbox_app
  using (deedbox.non_examiner_context()) with check (deedbox.non_examiner_context());
create policy reconciliation_examiner on deedbox.reconciliation
  for select to deedbox_app
  using (statement_date between deedbox.examiner_period_start() and deedbox.examiner_period_end());

alter table deedbox.recon_match enable row level security;
create policy recon_match_runtime on deedbox.recon_match
  for all to deedbox_app
  using (deedbox.non_examiner_context()) with check (deedbox.non_examiner_context());
create policy recon_match_examiner on deedbox.recon_match
  for select to deedbox_app
  using (deedbox.recon_statement_date(reconciliation)
         between deedbox.examiner_period_start() and deedbox.examiner_period_end());

alter table deedbox.recon_match_member enable row level security;
create policy recon_match_member_runtime on deedbox.recon_match_member
  for all to deedbox_app
  using (deedbox.non_examiner_context()) with check (deedbox.non_examiner_context());
create policy recon_match_member_examiner on deedbox.recon_match_member
  for select to deedbox_app
  using (deedbox.match_recon_statement_date(match_group)
         between deedbox.examiner_period_start() and deedbox.examiner_period_end());

alter table deedbox.recon_exception enable row level security;
create policy recon_exception_runtime on deedbox.recon_exception
  for all to deedbox_app
  using (deedbox.non_examiner_context()) with check (deedbox.non_examiner_context());
create policy recon_exception_examiner on deedbox.recon_exception
  for select to deedbox_app
  using (deedbox.recon_statement_date(reconciliation)
         between deedbox.examiner_period_start() and deedbox.examiner_period_end());

alter table deedbox.period_close enable row level security;
create policy period_close_runtime on deedbox.period_close
  for all to deedbox_app
  using (deedbox.non_examiner_context()) with check (deedbox.non_examiner_context());
create policy period_close_examiner on deedbox.period_close
  for select to deedbox_app
  using (period_start <= deedbox.examiner_period_end()
         and period_end >= deedbox.examiner_period_start());

alter table deedbox.balance_listing_line enable row level security;
create policy balance_listing_line_runtime on deedbox.balance_listing_line
  for all to deedbox_app
  using (deedbox.non_examiner_context()) with check (deedbox.non_examiner_context());
create policy balance_listing_line_examiner on deedbox.balance_listing_line
  for select to deedbox_app
  using (deedbox.close_in_examined_period(close));

alter table deedbox.remittance_register enable row level security;
create policy remittance_register_runtime on deedbox.remittance_register
  for all to deedbox_app
  using (deedbox.non_examiner_context()) with check (deedbox.non_examiner_context());
create policy remittance_register_examiner on deedbox.remittance_register
  for select to deedbox_app
  using (remitted_date between deedbox.examiner_period_start() and deedbox.examiner_period_end());

alter table deedbox.client_money_statement enable row level security;
create policy client_money_statement_runtime on deedbox.client_money_statement
  for all to deedbox_app
  using (deedbox.non_examiner_context()) with check (deedbox.non_examiner_context());
create policy client_money_statement_examiner on deedbox.client_money_statement
  for select to deedbox_app
  using (period_start <= deedbox.examiner_period_end()
         and period_end >= deedbox.examiner_period_start());

------------------------------------------------------------------------------
-- Identity stays closed: party rows are never served to examiner context.
-- The pinhole above is the ONLY identity path (matter's policy already fails
-- closed for examiners via the 0005 predicate's actor-kind gate).
------------------------------------------------------------------------------
alter table deedbox.party enable row level security;
create policy party_runtime on deedbox.party
  for all to deedbox_app
  using (deedbox.non_examiner_context()) with check (deedbox.non_examiner_context());

------------------------------------------------------------------------------
-- The register: examiners read ONLY the master-data journal within the
-- period, and the only rows an examiner-context transaction may ever write
-- are the two the audit trail requires — the read receipts and the
-- pack-export record. Everything else stays exactly as it was for the four
-- runtime kinds. The chain trigger is SECURITY DEFINER over its own head
-- table (0001), so hashing is untouched by these policies.
------------------------------------------------------------------------------
alter table deedbox.register_entry enable row level security;
create policy register_entry_runtime on deedbox.register_entry
  for all to deedbox_app
  using (deedbox.non_examiner_context()) with check (deedbox.non_examiner_context());
-- The examiner reads the master-data journal within the period, plus their
-- OWN audit trail (read receipts and pack-export records) — the latter also
-- because insert…returning is subject to the select policy (the earlier
-- lesson), and the export's register entry must land in the export's own
-- transaction, which runs under examiner context.
create policy register_entry_examiner_read on deedbox.register_entry
  for select to deedbox_app
  using ((event_kind = 'master_data.changed'
          and occurred_at::date
              between deedbox.examiner_period_start() and deedbox.examiner_period_end())
      or (event_kind in ('examiner.read', 'export.performed')
          and actor_kind = 'examiner'
          and actor = nullif(current_setting('deedbox.principal_id', true), '')::bigint
          and deedbox.examiner_period_start() is not null));
create policy register_entry_examiner_write on deedbox.register_entry
  for insert to deedbox_app
  with check (current_setting('deedbox.principal_kind', true) = 'examiner'
              and event_kind in ('examiner.read', 'export.performed')
              and deedbox.examiner_period_start() is not null);

commit;
