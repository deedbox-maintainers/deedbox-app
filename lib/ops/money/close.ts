// The close obligation materialiser and the certify-close ceremony. Where
// the active pack declares a close calendar the materialiser inserts DUE
// obligations ahead of each deadline so a missed close is visible before it
// is late; with no declaration it is inert — the neutral posture is close
// on demand, and an on-demand close is born in_progress with no deadline
// and can never be late. Certification is ONE transaction: the SCHEMA
// recomputes every ledger balance from lines, writes the balance listing
// for every ledger of every kind, and refuses unless the listing totals the
// bank position; this side generates the report artefact, flips the status,
// and registers privileged. A certified close locks its period on the
// posting path forever.

import type { Principal } from '@/lib/db'
import { withPrincipal, emitRegister, OperationRefused } from '@/lib/db'
import { requireStaff, requireCapability } from '@/lib/ops/shared'
import { createHash } from 'node:crypto'

/** Materialise due obligations from the pack calendar (inert without). */
export async function materialiseCloseObligations(
  p: Principal,
): Promise<{ created: { id: number; periodEnd: string }[] }> {
  return withPrincipal(p, async (tx) => {
    const decl = await tx.query(
      `select d.body from deedbox.pack_declaration d
         join deedbox.firm f on f.id = $1
         join deedbox.country_pack cp on cp.id = f.country_pack
         join deedbox.pack_version v on v.id = d.pack_version and v.id = cp.active_version
        where d.rule_point = 'money.close'`,
      [p.firm],
    )
    let calendar: { period_months?: number; due_days_after?: number } | null = null
    for (const row of decl.rows) {
      const b = row.body as { period_months?: number; due_days_after?: number }
      if (b.period_months !== undefined) calendar = b
    }
    if (!calendar) return { created: [] } // the neutral posture: on demand

    // the next period boundary behind today, firm time
    const period = await tx.query(
      `select date_trunc('month', (now() at time zone (select timezone from deedbox.firm order by id limit 1))::date)::date as this_month`,
    )
    const months = calendar.period_months ?? 1
    const bounds = await tx.query(
      `select (($1::date) - make_interval(months => $2::int))::date::text as period_start,
              (($1::date) - 1)::text as period_end,
              (($1::date) - 1 + make_interval(days => $3::int))::date::text as due_by`,
      [period.rows[0].this_month, months, calendar.due_days_after ?? 14],
    )
    const b = bounds.rows[0]
    const created: { id: number; periodEnd: string }[] = []
    const dup = await tx.query(
      `select 1 from deedbox.period_close
        where scope = 'all_accounts' and period_start = $1::date`,
      [b.period_start],
    )
    if (dup.rowCount === 0) {
      const r = await tx.query(
        `insert into deedbox.period_close (scope, period_start, period_end, due_by, status)
         values ('all_accounts', $1::date, $2::date, $3::date, 'due') returning id`,
        [b.period_start, b.period_end, b.due_by],
      )
      created.push({ id: r.rows[0].id as number, periodEnd: b.period_end as string })
      await emitRegister(tx, p, {
        kind: 'record.created',
        subjectType: 'period_close',
        subject: r.rows[0].id as number,
        detail: { period_start: b.period_start, period_end: b.period_end, due_by: b.due_by },
      })
    }
    return { created }
  })
}

/**
 * Open a close: a due obligation, or on demand with no deadline
 * (never late). An on-demand close may scope one account or all accounts.
 */
export async function openPeriodClose(
  p: Principal,
  input: { obligation?: number; periodStart?: string; periodEnd?: string; account?: number },
): Promise<{ id: number }> {
  requireStaff(p)
  return withPrincipal(p, async (tx) => {
    await requireCapability(tx, p, 'money.certify_close')
    if (input.obligation !== undefined) {
      const r = await tx.query(
        `update deedbox.period_close set status = 'in_progress'
          where id = $1 and status = 'due' returning id`,
        [input.obligation],
      )
      if (r.rowCount === 0) throw new OperationRefused('not_due', 'no due obligation by that id')
      await emitRegister(tx, p, {
        kind: 'record.changed',
        subjectType: 'period_close',
        subject: input.obligation,
        detail: { before: { status: 'due' }, after: { status: 'in_progress' } },
      })
      return { id: input.obligation }
    }
    if (!input.periodStart || !input.periodEnd) {
      throw new OperationRefused('period_required', 'an on-demand close names its period')
    }
    const r = await tx.query(
      `insert into deedbox.period_close (scope, account, period_start, period_end, status)
       values ($3, $4, $1::date, $2::date, 'in_progress') returning id`,
      [
        input.periodStart,
        input.periodEnd,
        input.account !== undefined ? 'account' : 'all_accounts',
        input.account ?? null,
      ],
    )
    await emitRegister(tx, p, {
      kind: 'record.created',
      subjectType: 'period_close',
      subject: r.rows[0].id as number,
      detail: {
        on_demand: true,
        scope: input.account !== undefined ? 'account' : 'all_accounts',
        account: input.account ?? null,
        period_start: input.periodStart,
        period_end: input.periodEnd,
      },
    })
    return { id: r.rows[0].id as number }
  })
}

/**
 * Certify: the schema writes the every-ledger listing and
 * refuses unless it totals the bank position; a certified reconciliation
 * must stand at the period end for every in-scope account; the report
 * artefact is generated here and stored on the row.
 */
export async function certifyPeriodClose(
  p: Principal,
  input: { close: number },
): Promise<{ reportArtefact: number; late: boolean }> {
  requireStaff(p)
  return withPrincipal(p, async (tx) => {
    await requireCapability(tx, p, 'money.certify_close')
    const close = await tx.query(
      `select id, scope, account, period_start::text as ps, period_end::text as pe, status, due_by::text as due
         from deedbox.period_close where id = $1 for update`,
      [input.close],
    )
    if (close.rowCount === 0) throw new OperationRefused('not_found', 'period close not found')
    if (close.rows[0].status !== 'in_progress') {
      throw new OperationRefused('wrong_state', `a ${close.rows[0].status} close cannot certify`)
    }
    const c = close.rows[0]
    // a certified reconciliation at the period end for every in-scope account
    const uncovered = await tx.query(
      `select ca.id from deedbox.client_account ca
        where ca.active and ($1 = 'all_accounts' or ca.id = $2)
          and exists (select 1 from deedbox.ledger_line l where l.account = ca.id)
          and not exists (
            select 1 from deedbox.reconciliation r
             where r.account = ca.id and r.status = 'certified'
               and r.statement_date >= $3::date)
        limit 1`,
      [c.scope, c.account ?? null, c.pe],
    )
    if (uncovered.rowCount! > 0) {
      throw new OperationRefused(
        'reconciliation_missing',
        `account ${uncovered.rows[0].id} has no certified reconciliation at the period end`,
      )
    }
    // the report set: the engine default — every ledger's recomputed
    // balance, the account totals, the period bounds — one artefact
    const balances = await tx.query(
      `select ml.id as ledger, ml.ledger_number, ml.ledger_kind, ml.account,
              deedbox.ledger_balance(ml.id) as balance
         from deedbox.matter_ledger ml
        where ($1 = 'all_accounts' or ml.account = $2)
        order by ml.account, ml.id`,
      [c.scope, c.account ?? null],
    )
    const report = JSON.stringify({
      document: 'period_close_report',
      period_start: c.ps,
      period_end: c.pe,
      ledgers: balances.rows.map((r) => ({
        ledger: r.ledger,
        ledger_number: r.ledger_number,
        kind: r.ledger_kind,
        account: r.account,
        balance: Number(r.balance),
      })),
      total: balances.rows.reduce((s, r) => s + Math.round(Number(r.balance) * 100), 0) / 100,
    })
    const artefact = await tx.query(
      `insert into deedbox.stored_artefact (kind, content_ref, content_hash, content_type, size_bytes)
       values ('period_close_report', $1, $2, 'application/json', $3) returning id`,
      [report, createHash('sha256').update(report).digest('hex'), Buffer.byteLength(report)],
    )
    // the flip: the schema recomputes, writes the listing, verifies the
    // totals, stamps late, and refuses on any discrepancy
    const r = await tx.query(
      `update deedbox.period_close
          set status = 'certified', certified_by = $2, report_artefact = $3
        where id = $1
        returning late`,
      [input.close, p.id, String(artefact.rows[0].id)],
    )
    await emitRegister(tx, p, {
      kind: 'record.changed',
      subjectType: 'period_close',
      subject: input.close,
      privileged: true,
      artefact: String(artefact.rows[0].id),
      detail: {
        before: { status: 'in_progress' },
        after: { status: 'certified', late: r.rows[0].late },
      },
    })
    return { reportArtefact: artefact.rows[0].id as number, late: r.rows[0].late as boolean }
  })
}
