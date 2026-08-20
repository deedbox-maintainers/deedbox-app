// Billed attribution and line-item export. Attribution is replaced whole,
// never row-edited; collection fans already written stand structurally —
// there is no retroactive restatement path. The export is read-only over
// the documented stable structure; the export itself is a PRIVILEGED
// register event carrying the exact generated artefact, and it supplies
// the restricted-matter count the anomaly rules read (any export touching
// a restricted matter trips the large-export rule).

import type { Principal } from '@/lib/db'
import { withPrincipal, emitRegister, OperationRefused } from '@/lib/db'
import { requireStaff, hasCapability } from '@/lib/ops/shared'
import { createHash } from 'node:crypto'

function cents(x: number | string): number {
  return Math.round(Number(x) * 100)
}

/** Replace the billed attribution set, whole. */
export async function replaceBillAttribution(
  p: Principal,
  input: { bill: number; shares: { staff: number; amount: number }[] },
): Promise<void> {
  requireStaff(p)
  if (input.shares.length === 0) {
    throw new OperationRefused('nothing_to_set', 'name at least one share')
  }
  await withPrincipal(p, async (tx) => {
    const bill = await tx.query(
      `select b.id, b.matter, b.state, m.responsible_lawyer,
              (select j.signed_amount from deedbox.bill_journal_entry j
                where j.bill = b.id and j.entry_kind = 'issue_total') as issue_total
         from deedbox.bill b join deedbox.matter m on m.id = b.matter
        where b.id = $1 for update of b`,
      [input.bill],
    )
    if (bill.rowCount === 0) throw new OperationRefused('not_found', 'bill not found')
    if (bill.rows[0].state !== 'issued') {
      throw new OperationRefused('not_issued', 'attribution belongs to issued bills')
    }
    if (
      bill.rows[0].responsible_lawyer !== p.id &&
      !(await hasCapability(tx, p.id, 'see_firm_money'))
    ) {
      throw new OperationRefused(
        'capability_missing',
        'attribution changes belong to see_firm_money holders or the responsible lawyer',
      )
    }
    const total = cents(bill.rows[0].issue_total)
    const sum = input.shares.reduce((s, x) => s + cents(x.amount), 0)
    if (sum !== total) {
      throw new OperationRefused(
        'bad_sum',
        `the shares total ${(sum / 100).toFixed(2)} but the bill's issue total is ${(total / 100).toFixed(2)}`,
      )
    }
    const before = await tx.query(
      `select staff, billed_share from deedbox.bill_attribution
        where bill = $1 and superseded_at is null order by staff`,
      [input.bill],
    )
    await tx.query(
      `update deedbox.bill_attribution set superseded_at = now()
        where bill = $1 and superseded_at is null`,
      [input.bill],
    )
    for (const s of input.shares) {
      await tx.query(
        `insert into deedbox.bill_attribution (bill, staff, billed_share)
         values ($1, $2, $3)`,
        [input.bill, s.staff, s.amount],
      )
    }
    await emitRegister(tx, p, {
      kind: 'record.changed',
      subjectType: 'bill_attribution',
      subject: input.bill,
      matter: bill.rows[0].matter as number,
      detail: {
        before: before.rows.map((r) => ({ staff: r.staff, share: Number(r.billed_share) })),
        after: input.shares.map((s) => ({ staff: s.staff, share: s.amount })),
      },
    })
  })
}

/** Export the documented, stable line structure for bills. */
export async function exportBillLines(
  p: Principal,
  input: { matter?: number; bills?: number[] },
): Promise<{ artefact: number; rows: number; restrictedMatters: number }> {
  requireStaff(p)
  if (input.matter === undefined && (input.bills?.length ?? 0) === 0) {
    throw new OperationRefused('no_scope', 'name a matter or a bill selection')
  }
  return withPrincipal(p, async (tx) => {
    const rows = await tx.query(
      `select b.id as bill, b.bill_number, b.issue_date::text as issue_date,
              b.due_date::text as due_date, b.matter, m.restricted,
              l.position, l.kind, l.description, l.quantity_units, l.rate,
              l.original_value, l.written_down_to, l.amount,
              l.tax_treatment, l.tax_amount, l.category_key,
              te.work_date::text as source_date, te.staff as source_staff
         from deedbox.bill b
         join deedbox.matter m on m.id = b.matter
         join deedbox.bill_line l on l.bill = b.id
         left join deedbox.time_entry te on te.id = l.source_entry and l.kind in ('time','fixed_fee')
        where b.state = 'issued'
          and ($1::bigint is null or b.matter = $1)
          and (cardinality($2::bigint[]) = 0 or b.id = any($2))
        order by b.id, l.position`,
      [input.matter ?? null, input.bills ?? []],
    )
    if (rows.rowCount === 0) {
      throw new OperationRefused('nothing_to_export', 'no issued bill lines in this scope')
    }
    const restricted = new Set(rows.rows.filter((r) => r.restricted).map((r) => r.matter as number))
    const structure = {
      document: 'bill_line_export',
      generated_at_register: true,
      rows: rows.rows.map((r) => ({
        bill: r.bill,
        bill_number: r.bill_number,
        issue_date: r.issue_date,
        due_date: r.due_date,
        position: r.position,
        kind: r.kind,
        description: r.description,
        quantity_units: r.quantity_units,
        rate: r.rate === null ? null : Number(r.rate),
        original_value: Number(r.original_value),
        written_down_to: r.written_down_to === null ? null : Number(r.written_down_to),
        amount: Number(r.amount),
        tax_treatment: r.tax_treatment,
        tax_amount: Number(r.tax_amount),
        category_key: r.category_key,
        source_date: r.source_date,
        source_staff: r.source_staff,
      })),
    }
    const content = JSON.stringify(structure)
    const artefact = await tx.query(
      `insert into deedbox.stored_artefact (kind, content_ref, content_hash, content_type, size_bytes)
       values ('bill_line_export', $1, $2, 'application/json', $3) returning id`,
      [content, createHash('sha256').update(content).digest('hex'), Buffer.byteLength(content)],
    )
    // the export event is privileged and carries the exact artefact; its
    // detail supplies what the large-export anomaly rule reads
    await emitRegister(tx, p, {
      kind: 'export.performed',
      subjectType: 'bill_line_export',
      subject: artefact.rows[0].id as number,
      matter: input.matter,
      privileged: true,
      artefact: String(artefact.rows[0].id),
      detail: {
        before: null,
        after: {
          rows: rows.rowCount,
          bills: new Set(rows.rows.map((r) => r.bill)).size,
          restricted_matters: restricted.size,
        },
      },
    })
    return {
      artefact: artefact.rows[0].id as number,
      rows: rows.rowCount!,
      restrictedMatters: restricted.size,
    }
  })
}
