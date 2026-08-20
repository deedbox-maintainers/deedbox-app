// Statements. A statement is an insert-only snapshot of the outstanding
// position for a client or a matter, numbered from the `statement` purpose,
// rendered as a stored artefact, optionally carrying a payment reference.
// Per-payer views are produced by filtering, never by a separate scope. The
// one-action allocation orders the statement's bills per the firm's
// allocation-order setting — skipping bills with an open dispute or covered
// by an ACTIVE arrangement, itemising every skip — and executes the per-bill
// payment allocation across the ordered set in one transaction under the
// canonical lock order.
//
// Implementation notes: the snapshot carries the governing payment details,
// exactly as the bill rendering does — the one-render-definition rule binds
// every client-bound rendering to the one resolver, and the statement is
// client-bound. The optional payment reference is created AFTER the
// statement row and points at it by target — the statement's own
// payment_reference column stays null because the row is insert-only
// (append-only by trigger) and cannot learn its reference after birth; every
// consumer (settlement included) navigates reference → target, and the send
// ceremony resolves the link at despatch.

import type { Principal, Tx } from '@/lib/db'
import { withPrincipal, emitRegister, OperationRefused } from '@/lib/db'
import { requireStaff, settingText } from '@/lib/ops/shared'
import { allocateInTx } from './payments'
import { createHash, randomBytes } from 'node:crypto'

interface StatementBillRow {
  bill: number
  bill_number: string
  matter: number
  issue_date: string
  due_date: string
  total: number
  outstanding: number
  days_overdue: number
  ageing_bucket: string
}

function ageingBucket(daysOverdue: number): string {
  if (daysOverdue <= 0) return 'current'
  if (daysOverdue <= 30) return '1-30'
  if (daysOverdue <= 60) return '31-60'
  if (daysOverdue <= 90) return '61-90'
  return '90+'
}

async function outstandingBills(
  tx: Tx,
  scopeKind: 'client' | 'matter',
  scope: number,
): Promise<StatementBillRow[]> {
  const rows = await tx.query(
    `select b.id, b.bill_number, b.matter, b.issue_date::text as issue_date,
            b.due_date::text as due_date,
            (select j.signed_amount from deedbox.bill_journal_entry j
              where j.bill = b.id and j.entry_kind = 'issue_total') as total,
            deedbox.bill_outstanding(b.id) as outstanding,
            greatest(0, (current_date - b.due_date))::int as days_overdue
       from deedbox.bill b
       join deedbox.matter m on m.id = b.matter
      where b.state = 'issued'
        and (($1 = 'matter' and b.matter = $2)
          or ($1 = 'client' and m.client_party = $2))
        and deedbox.bill_outstanding(b.id) > 0
      order by b.due_date, b.issue_date, b.bill_number`,
    [scopeKind, scope],
  )
  return rows.rows.map((r) => ({
    bill: r.id as number,
    bill_number: r.bill_number as string,
    matter: r.matter as number,
    issue_date: r.issue_date as string,
    due_date: r.due_date as string,
    total: Number(r.total),
    outstanding: Number(r.outstanding),
    days_overdue: r.days_overdue as number,
    ageing_bucket: ageingBucket(r.days_overdue as number),
  }))
}

/** Generate a statement for a client or a matter. */
export async function generateStatement(
  p: Principal,
  input: {
    scopeKind: 'client' | 'matter'
    scope: number
    withPaymentReference?: boolean
  },
): Promise<{
  id: number
  statementNumber: string
  totalOutstanding: number
  bills: StatementBillRow[]
}> {
  requireStaff(p)
  return withPrincipal(p, async (tx) => {
    if (input.scopeKind === 'matter') {
      const m = await tx.query(`select id from deedbox.matter where id = $1`, [input.scope])
      if (m.rowCount === 0) throw new OperationRefused('not_found', 'matter not found')
    } else {
      const c = await tx.query(`select id from deedbox.party where id = $1`, [input.scope])
      if (c.rowCount === 0) throw new OperationRefused('not_found', 'party not found')
    }
    const bills = await outstandingBills(tx, input.scopeKind, input.scope)
    if (bills.length === 0) {
      throw new OperationRefused('nothing_outstanding', 'no outstanding bills in this scope')
    }
    const totalOutstanding =
      Math.round(bills.reduce((s, b) => s + b.outstanding, 0) * 100) / 100

    const num = await tx.query(`select deedbox.allocate_number('statement') as n`)
    const statementNumber = num.rows[0].n as string

    const details = await tx.query(`select to_jsonb(deedbox.governing_payment_details()) as d`)
    const snapshot = {
      document: 'statement',
      scope_kind: input.scopeKind,
      scope: input.scope,
      statement_number: statementNumber,
      bills,
      total_outstanding: totalOutstanding,
      payment_details: details.rows[0].d,
    }
    const content = JSON.stringify(snapshot)
    const artefact = await tx.query(
      `insert into deedbox.stored_artefact (kind, content_ref, content_hash, content_type, size_bytes)
       values ('statement_rendering', $1, $2, 'application/json', $3) returning id`,
      [content, createHash('sha256').update(content).digest('hex'), Buffer.byteLength(content)],
    )

    const stmt = await tx.query(
      `insert into deedbox.receivable_statement
         (scope_kind, scope, statement_number, content_snapshot, artefact)
       values ($1, $2, $3, $4, $5) returning id`,
      [input.scopeKind, input.scope, statementNumber, content, String(artefact.rows[0].id)],
    )
    const statementId = stmt.rows[0].id as number

    if (input.withPaymentReference) {
      const code = randomBytes(24).toString('base64url') // 192 bits, opaque
      await tx.query(
        `insert into deedbox.payment_reference (code, target_kind, target, expected_amount)
         values ($1, 'statement', $2, $3)`,
        [code, statementId, totalOutstanding],
      )
    }

    await emitRegister(tx, p, {
      kind: 'record.created',
      subjectType: 'receivable_statement',
      subject: statementId,
      matter: input.scopeKind === 'matter' ? input.scope : undefined,
      detail: {
        statement_number: statementNumber,
        bills: bills.length,
        total_outstanding: totalOutstanding,
      },
    })
    return { id: statementId, statementNumber, totalOutstanding, bills }
  })
}

/**
 * The statement ordering + skip logic, callable in a caller-owned transaction
 * (channel settlement of a statement target rides it). Returns the
 * computed splits and the itemised skips; the caller allocates.
 */
export async function statementSplitsInTx(
  tx: Tx,
  statementId: number,
  amountAvailable: number,
  manualOrder?: number[],
): Promise<{
  splits: { bill: number; amount: number }[]
  skips: { bill: number; reason: string }[]
  ordered: number[]
}> {
  const stmt = await tx.query(
    `select id, content_snapshot from deedbox.receivable_statement where id = $1`,
    [statementId],
  )
  if (stmt.rowCount === 0) throw new OperationRefused('not_found', 'statement not found')
  const rawSnap = stmt.rows[0].content_snapshot
  const snap = (typeof rawSnap === 'string' ? JSON.parse(rawSnap) : rawSnap) as {
    bills: { bill: number }[]
  }
  const snapshotBills: number[] = snap.bills.map((b) => b.bill)

  const order = (await settingText(tx, 'statement.allocation_order')) ?? 'oldest_first'
  let ordered: number[]
  if (manualOrder && manualOrder.length > 0) {
    const set = new Set(snapshotBills)
    for (const b of manualOrder) {
      if (!set.has(b)) {
        throw new OperationRefused('not_on_statement', `bill ${b} is not on this statement`)
      }
    }
    ordered = manualOrder
  } else {
    const r = await tx.query(
      `select b.id from deedbox.bill b where b.id = any($1)
        order by b.due_date ${order === 'newest_first' ? 'desc' : 'asc'},
                 b.issue_date ${order === 'newest_first' ? 'desc' : 'asc'},
                 b.bill_number ${order === 'newest_first' ? 'desc' : 'asc'}`,
      [snapshotBills],
    )
    ordered = r.rows.map((x) => x.id as number)
  }

  const splits: { bill: number; amount: number }[] = []
  const skips: { bill: number; reason: string }[] = []
  let remaining = Math.round(amountAvailable * 100)
  for (const billId of ordered) {
    if (remaining <= 0) break
    const disputed = await tx.query(
      `select 1 from deedbox.bill_dispute where bill = $1 and resolved_at is null`,
      [billId],
    )
    if (disputed.rowCount! > 0) {
      skips.push({ bill: billId, reason: 'open dispute' })
      continue
    }
    const arranged = await tx.query(
      `select 1 from deedbox.arrangement_bill ab
        join deedbox.payment_arrangement a on a.id = ab.arrangement
       where ab.bill = $1 and a.state = 'active'`,
      [billId],
    )
    if (arranged.rowCount! > 0) {
      skips.push({ bill: billId, reason: 'active payment arrangement' })
      continue
    }
    const o = await tx.query(`select deedbox.bill_outstanding($1) as o`, [billId])
    const outstandingCents = Math.round(Number(o.rows[0].o) * 100)
    if (outstandingCents <= 0) continue
    const cut = Math.min(outstandingCents, remaining)
    splits.push({ bill: billId, amount: cut / 100 })
    remaining -= cut
  }
  return { splits, skips, ordered }
}

/** One-action statement allocation of one payment. */
export async function allocateStatementPayment(
  p: Principal,
  input: { payment: number; statement: number; manualOrder?: number[] },
): Promise<{
  allocated: { bill: number; amount: number }[]
  skips: { bill: number; reason: string }[]
}> {
  requireStaff(p)
  return withPrincipal(p, async (tx) => {
    const remainder = await tx.query(
      `select pmt.amount + coalesce((
          select sum(j.signed_amount) from deedbox.bill_journal_entry j
           where j.source_type = 'receivable_payment' and j.source = pmt.id
             and j.entry_kind in ('payment_allocation','reversal')
        ), 0) as rem
         from deedbox.receivable_payment pmt where pmt.id = $1`,
      [input.payment],
    )
    if (remainder.rowCount === 0) throw new OperationRefused('not_found', 'payment not found')
    const available = Number(remainder.rows[0].rem)
    if (!(available > 0)) {
      throw new OperationRefused('nothing_unallocated', 'the payment has no unallocated remainder')
    }
    const { splits, skips } = await statementSplitsInTx(
      tx,
      input.statement,
      available,
      input.manualOrder,
    )
    if (splits.length === 0) {
      throw new OperationRefused(
        'nothing_to_allocate',
        skips.length > 0
          ? `every statement bill was skipped: ${skips.map((s) => `${s.bill} (${s.reason})`).join('; ')}`
          : 'nothing outstanding on the statement',
      )
    }
    await allocateInTx(tx, p, input.payment, splits)
    await emitRegister(tx, p, {
      kind: 'record.changed',
      subjectType: 'receivable_statement',
      subject: input.statement,
      detail: {
        payment: input.payment,
        splits,
        skips,
        manual_order: (input.manualOrder?.length ?? 0) > 0,
      },
    })
    return { allocated: splits, skips }
  })
}
