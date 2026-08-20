// Predicate-governed reads for the examiner workspace. Read-only
// withPrincipal transactions AS THE EXAMINER: the 0025 row policies do ALL
// the scoping — money records within the grant's examined period, nothing
// else — and identity is served ONLY by the definer header pinhole (ledger
// number, client display name, matter reference). Every read records
// examiner.read BEFORE returning; a recording failure withholds the content
// (the error propagates instead of rendering).
//
// Implementation notes:
//   * Figures are presented exactly as stored — running balances are the
//     line guard's ASSIGNED values; no read here recomputes a balance, and
//     none calls the shared available() definition (a period-scoped sum
//     would masquerade as a balance).
//   * The refusal register renders reason, date, ledger and promotion state
//     — not the attempted operation's raw parameter payload; the sanctioned
//     identity path is the header pinhole alone.
//   * Reconciliation members whose counterpart sits outside the examined
//     period (a late-presented instrument's transaction) render as
//     "outside the examined period" — the row policies hide the row, the
//     surface says so honestly.

import type { Principal, Tx } from '@/lib/db'
import { withPrincipal, OperationRefused } from '@/lib/db'
import { requireExaminer, recordExaminerReads } from '@/lib/ops/security'

export interface ExaminerContext {
  grant: number
  examinerName: string
  periodStart: string
  periodEnd: string
  startsAt: Date
  expiresAt: Date
}

/** The grant's own window and examined period — the workspace's badge. */
export async function examinerContext(p: Principal): Promise<ExaminerContext> {
  requireExaminer(p)
  return withPrincipal(
    p,
    async (tx) => {
      const g = await tx.query(
        `select id, examiner_name, period_start::text as ps, period_end::text as pe,
                starts_at, expires_at
           from deedbox.examiner_grant where id = $1`,
        [p.id],
      )
      if (g.rowCount === 0) throw new OperationRefused('not_found', 'examiner grant not found')
      return {
        grant: g.rows[0].id as number,
        examinerName: g.rows[0].examiner_name as string,
        periodStart: g.rows[0].ps as string,
        periodEnd: g.rows[0].pe as string,
        startsAt: g.rows[0].starts_at as Date,
        expiresAt: g.rows[0].expires_at as Date,
      }
    },
    { readOnly: true },
  )
}

async function ledgerHeader(tx: Tx, ledger: number) {
  const h = await tx.query(`select * from deedbox.examiner_ledger_header($1)`, [ledger])
  return h.rows[0] as
    | { ledger_number: string; client_display_name: string | null; matter_reference: string | null }
    | undefined
}

/** Examiner home: accounts with their in-period cash-book totals + pack exports. */
export async function examinerHome(p: Principal) {
  requireExaminer(p)
  const data = await withPrincipal(
    p,
    async (tx) => {
      const accounts = await tx.query(
        `select a.id, a.name, a.account_kind, a.active,
                (select count(*)::int from deedbox.ledger_line l
                  where l.account = a.id and l.side = 'cash_book') as period_lines,
                (select coalesce(sum(l.signed_amount), 0) from deedbox.ledger_line l
                  where l.account = a.id and l.side = 'cash_book') as period_net
           from deedbox.client_account a
          order by a.name`,
      )
      const exports = await tx.query(
        `select id, period, exported_at, artefact
           from deedbox.examination_pack_export
          where exported_by_kind = 'examiner' and exported_by = $1
          order by id desc`,
        [p.id],
      )
      return { accounts: accounts.rows, exports: exports.rows }
    },
    { readOnly: true },
  )
  await recordExaminerReads(p, 'examiner_home')
  return data
}

/** Cash book: one account's cash-book lines within the period. */
export async function examinerCashBook(p: Principal, account: number) {
  requireExaminer(p)
  const data = await withPrincipal(
    p,
    async (tx) => {
      const a = await tx.query(
        `select id, name, account_kind from deedbox.client_account where id = $1`,
        [account],
      )
      if (a.rowCount === 0) throw new OperationRefused('not_found', 'account not found')
      const lines = await tx.query(
        `select l.id, l.signed_amount, t.id as txn, t.txn_kind, t.effective_date, t.reason
           from deedbox.ledger_line l
           join deedbox.money_transaction t on t.id = l.transaction
          where l.account = $1 and l.side = 'cash_book'
          order by t.effective_date, l.id`,
        [account],
      )
      return { account: a.rows[0], lines: lines.rows }
    },
    { readOnly: true },
  )
  await recordExaminerReads(p, 'examiner_cash_book')
  return data
}

/** Ledgers: every ledger with in-period movement, minimal header only. */
export async function examinerLedgers(p: Principal) {
  requireExaminer(p)
  const rows = await withPrincipal(
    p,
    async (tx) => {
      const r = await tx.query(
        `select ml.id, ml.matter, ml.ledger_kind, ml.status,
                h.ledger_number, h.client_display_name, h.matter_reference
           from deedbox.matter_ledger ml
           cross join lateral deedbox.examiner_ledger_header(ml.id) h
          where exists (select 1 from deedbox.ledger_line l where l.matter_ledger = ml.id)
          order by h.ledger_number`,
      )
      return r.rows
    },
    { readOnly: true },
  )
  await recordExaminerReads(
    p,
    'examiner_ledger_list',
    rows.map((r) => r.matter as number | null),
  )
  return rows
}

/** One ledger: the header and its in-period lines, balances as stored. */
export async function examinerLedger(p: Principal, ledger: number) {
  requireExaminer(p)
  const data = await withPrincipal(
    p,
    async (tx) => {
      const ml = await tx.query(
        `select id, matter, ledger_kind, status from deedbox.matter_ledger where id = $1`,
        [ledger],
      )
      if (ml.rowCount === 0) throw new OperationRefused('not_found', 'ledger not found')
      const header = await ledgerHeader(tx, ledger)
      const lines = await tx.query(
        `select l.entry_no, l.signed_amount, l.running_balance,
                t.id as txn, t.txn_kind, t.effective_date, t.reason
           from deedbox.ledger_line l
           join deedbox.money_transaction t on t.id = l.transaction
          where l.matter_ledger = $1 and l.side = 'matter_ledger'
          order by l.entry_no`,
        [ledger],
      )
      return { ledger: ml.rows[0], header, lines: lines.rows }
    },
    { readOnly: true },
  )
  await recordExaminerReads(p, 'examiner_ledger', [data.ledger.matter as number | null])
  return data
}

/** Reconciliations within the period, with their certification state. */
export async function examinerRecons(p: Principal) {
  requireExaminer(p)
  const rows = await withPrincipal(
    p,
    async (tx) => {
      const r = await tx.query(
        `select r.id, r.account, a.name as account_name, r.statement_date, r.statement_balance,
                r.status, r.certified_at, r.equation_snapshot,
                (select count(*)::int from deedbox.recon_match m where m.reconciliation = r.id) as match_groups,
                (select count(*)::int from deedbox.recon_exception e where e.reconciliation = r.id) as exceptions
           from deedbox.reconciliation r
           join deedbox.client_account a on a.id = r.account
          order by r.statement_date desc, r.id desc`,
      )
      return r.rows
    },
    { readOnly: true },
  )
  await recordExaminerReads(p, 'examiner_recons')
  return rows
}

/** One reconciliation: matches, members and exceptions in full. */
export async function examinerRecon(p: Principal, recon: number) {
  requireExaminer(p)
  const data = await withPrincipal(
    p,
    async (tx) => {
      const r = await tx.query(
        `select r.id, r.account, a.name as account_name, r.statement_date, r.statement_balance,
                r.status, r.certified_at, r.equation_snapshot
           from deedbox.reconciliation r
           join deedbox.client_account a on a.id = r.account
          where r.id = $1`,
        [recon],
      )
      if (r.rowCount === 0) throw new OperationRefused('not_found', 'reconciliation not found')
      const members = await tx.query(
        `select mm.match_group, mm.member_kind,
                bl.line_date, bl.amount as line_amount, bl.description,
                t.id as txn, t.txn_kind, t.effective_date
           from deedbox.recon_match m
           join deedbox.recon_match_member mm on mm.match_group = m.id
           left join deedbox.bank_statement_line bl on bl.id = mm.statement_line
           left join deedbox.money_transaction t on t.id = mm.transaction
          where m.reconciliation = $1
          order by mm.match_group, mm.id`,
        [recon],
      )
      const exceptions = await tx.query(
        `select e.id, e.exception_type, e.amount, e.arising_date, e.state, e.resolution_note
           from deedbox.recon_exception e
          where e.reconciliation = $1
          order by e.arising_date, e.id`,
        [recon],
      )
      return { recon: r.rows[0], members: members.rows, exceptions: exceptions.rows }
    },
    { readOnly: true },
  )
  await recordExaminerReads(p, 'examiner_recon')
  return data
}

/** The transfer journal: both shapes, one unbroken number series. */
export async function examinerTransfers(p: Principal) {
  requireExaminer(p)
  const data = await withPrincipal(
    p,
    async (tx) => {
      const same = await tx.query(
        `select lt.transfer_number, lt.amount, lt.reason, t.effective_date,
                fl.matter as from_matter, tl.matter as to_matter,
                fh.ledger_number as from_ledger, fh.client_display_name as from_client, fh.matter_reference as from_matter_ref,
                th.ledger_number as to_ledger, th.client_display_name as to_client, th.matter_reference as to_matter_ref
           from deedbox.ledger_transfer lt
           join deedbox.money_transaction t on t.id = lt.transaction
           join deedbox.matter_ledger fl on fl.id = lt.from_ledger
           join deedbox.matter_ledger tl on tl.id = lt.to_ledger
           cross join lateral deedbox.examiner_ledger_header(lt.from_ledger) fh
           cross join lateral deedbox.examiner_ledger_header(lt.to_ledger) th`,
      )
      const cross = await tx.query(
        `select cat.transfer_number, r.amount, cat.reason, r.received_date as effective_date,
                pl.matter as from_matter, rl.matter as to_matter,
                fh.ledger_number as from_ledger, fh.client_display_name as from_client, fh.matter_reference as from_matter_ref,
                th.ledger_number as to_ledger, th.client_display_name as to_client, th.matter_reference as to_matter_ref
           from deedbox.cross_account_transfer cat
           join deedbox.money_receipt r on r.id = cat.receipt
           join deedbox.money_payment pay on pay.id = cat.payment
           join deedbox.matter_ledger pl on pl.id = pay.matter_ledger
           join deedbox.matter_ledger rl on rl.id = r.matter_ledger
           cross join lateral deedbox.examiner_ledger_header(pay.matter_ledger) fh
           cross join lateral deedbox.examiner_ledger_header(r.matter_ledger) th`,
      )
      const rows = [...same.rows, ...cross.rows].sort((a, b) =>
        String(a.transfer_number).localeCompare(String(b.transfer_number)),
      )
      return rows
    },
    { readOnly: true },
  )
  await recordExaminerReads(
    p,
    'examiner_transfers',
    data.flatMap((r) => [r.from_matter as number | null, r.to_matter as number | null]),
  )
  return data
}

/** The refusal register within the period. */
export async function examinerRefusals(p: Principal) {
  requireExaminer(p)
  const rows = await withPrincipal(
    p,
    async (tx) => {
      const r = await tx.query(
        `select ro.id, ro.refusal_reason, ro.at, ro.promoted_incident,
                a.name as account_name, ml.matter,
                h.ledger_number, h.client_display_name, h.matter_reference
           from deedbox.refused_operation ro
           join deedbox.client_account a on a.id = ro.account
           left join deedbox.matter_ledger ml on ml.id = ro.matter_ledger
           left join lateral deedbox.examiner_ledger_header(ro.matter_ledger) h on ro.matter_ledger is not null
          order by ro.at desc, ro.id desc`,
      )
      return r.rows
    },
    { readOnly: true },
  )
  await recordExaminerReads(
    p,
    'examiner_refusals',
    rows.map((r) => r.matter as number | null),
  )
  return rows
}

/** The incident register up to the period end. */
export async function examinerIncidents(p: Principal) {
  requireExaminer(p)
  const rows = await withPrincipal(
    p,
    async (tx) => {
      const r = await tx.query(
        `select i.id, i.incident_date, i.amount, i.cause, i.narrative, i.state, i.origin,
                a.name as account_name, ml.matter,
                h.ledger_number, h.client_display_name, h.matter_reference
           from deedbox.deficiency_incident i
           join deedbox.client_account a on a.id = i.account
           left join deedbox.matter_ledger ml on ml.id = i.matter_ledger
           left join lateral deedbox.examiner_ledger_header(i.matter_ledger) h on i.matter_ledger is not null
          order by i.incident_date desc, i.id desc`,
      )
      return r.rows
    },
    { readOnly: true },
  )
  await recordExaminerReads(
    p,
    'examiner_incidents',
    rows.map((r) => r.matter as number | null),
  )
  return rows
}

/** The master-data journal: identity changes within the period. */
export async function examinerMasterData(p: Principal) {
  requireExaminer(p)
  const rows = await withPrincipal(
    p,
    async (tx) => {
      const r = await tx.query(
        `select e.id, e.occurred_at, e.subject_type, e.subject, e.matter, e.detail
           from deedbox.register_entry e
          where e.event_kind = 'master_data.changed' and e.firm = $1
          order by e.occurred_at desc, e.id desc`,
        [p.firm],
      )
      return r.rows
    },
    { readOnly: true },
  )
  await recordExaminerReads(
    p,
    'examiner_master_data',
    rows.map((r) => r.matter as number | null),
  )
  return rows
}
