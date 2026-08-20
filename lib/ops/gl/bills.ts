// Supplier bills: draft freely, approve = the accounts-payable journal
// posts in the same act (expense and tax debits, payables credit), paid
// arrives through reconciliation, void only untouched drafts/approved.

import type { Principal } from '@/lib/db'
import { withPrincipal, emitRegister, OperationRefused } from '@/lib/db'
import { requireGl, purposeAccountInTx, createPostedJournalInTx, toCents, fromCents, toIsoDate } from './shared'

export interface GlBillLineInput {
  account: number
  taxCode?: number | null
  description?: string | null
  netCents: number
  taxCents: number
}

export async function createGlBill(
  p: Principal,
  input: {
    contact: number
    billNumber?: string | null
    billDate: string
    dueDate?: string | null
    description?: string | null
    lines: GlBillLineInput[]
  },
): Promise<number> {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(input.billDate)) {
    throw new OperationRefused('bad_date', 'the bill date is a plain ISO date')
  }
  if (input.lines.length === 0) {
    throw new OperationRefused('lines_required', 'a bill needs at least one line')
  }
  const net = input.lines.reduce((s, l) => s + l.netCents, 0)
  const tax = input.lines.reduce((s, l) => s + l.taxCents, 0)
  return withPrincipal(p, async (tx) => {
    await requireGl(tx, p)
    const r = await tx.query(
      `insert into deedbox.gl_bill
         (firm, contact, bill_number, bill_date, due_date, description,
          net_amount, tax_amount, total, created_by)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) returning id`,
      [
        p.firm,
        input.contact,
        input.billNumber || null,
        input.billDate,
        input.dueDate || null,
        input.description || null,
        fromCents(net),
        fromCents(tax),
        fromCents(net + tax),
        p.id,
      ],
    )
    const id = r.rows[0].id as number
    let n = 0
    for (const l of input.lines) {
      n += 1
      await tx.query(
        `insert into deedbox.gl_bill_line (bill, line_no, account, tax_code, description, net_amount, tax_amount)
         values ($1,$2,$3,$4,$5,$6,$7)`,
        [id, n, l.account, l.taxCode ?? null, l.description ?? null, fromCents(l.netCents), fromCents(l.taxCents)],
      )
    }
    await emitRegister(tx, p, {
      kind: 'record.created',
      subjectType: 'gl_bill',
      subject: id,
      detail: { contact: input.contact, total: fromCents(net + tax) },
    })
    return id
  })
}

export async function approveGlBill(p: Principal, input: { id: number }): Promise<void> {
  await withPrincipal(p, async (tx) => {
    await requireGl(tx, p)
    const b = await tx.query(
      `select * from deedbox.gl_bill where id = $1 and firm = $2 for update`,
      [input.id, p.firm],
    )
    if (b.rowCount === 0) throw new OperationRefused('bill_not_found', 'no such bill')
    const bill = b.rows[0] as Record<string, unknown>
    if (bill.status !== 'draft') {
      throw new OperationRefused('not_draft', `a ${bill.status} bill cannot be approved`)
    }
    const lines = await tx.query(
      `select account, tax_code, description, net_amount, tax_amount
         from deedbox.gl_bill_line where bill = $1 order by line_no`,
      [input.id],
    )
    if (lines.rowCount === 0) {
      throw new OperationRefused('lines_required', 'a bill needs at least one line')
    }
    const ap = await purposeAccountInTx(tx, p.firm, 'accounts_payable')
    const journalLines = (lines.rows as Record<string, unknown>[]).map((l) => ({
      account: l.account as number,
      taxCode: (l.tax_code as number | null) ?? null,
      debitCents: toCents(l.net_amount),
      description: (l.description as string | null) ?? 'Supplier bill',
      contact: bill.contact as number,
    }))
    const taxTotal = (lines.rows as Record<string, unknown>[]).reduce(
      (s, l) => s + toCents(l.tax_amount),
      0,
    )
    if (taxTotal > 0) {
      const taxPaid = await purposeAccountInTx(tx, p.firm, 'tax_paid')
      journalLines.push({
        account: taxPaid,
        taxCode: null,
        debitCents: taxTotal,
        description: 'Tax paid on purchases',
        contact: bill.contact as number,
      })
    }
    const j = await createPostedJournalInTx(tx, p, {
      journalDate: toIsoDate(bill.bill_date),
      description: `Bill ${bill.bill_number ?? input.id} from contact ${bill.contact}`,
      sourceType: 'bill_ap',
      sourceRef: `glbill:${input.id}`,
      lines: [
        ...journalLines,
        {
          account: ap,
          creditCents: toCents(bill.total),
          description: 'Accounts payable',
          contact: bill.contact as number,
        },
      ],
    })
    await tx.query(`update deedbox.gl_bill set status = 'approved', journal = $2 where id = $1`, [
      input.id,
      j.id,
    ])
    await emitRegister(tx, p, {
      kind: 'record.changed',
      subjectType: 'gl_bill',
      subject: input.id,
      detail: { before: { status: 'draft' }, after: { status: 'approved', journal_no: j.journalNo } },
    })
  })
}

export async function voidGlBill(p: Principal, input: { id: number }): Promise<void> {
  await withPrincipal(p, async (tx) => {
    await requireGl(tx, p)
    const r = await tx.query(
      `update deedbox.gl_bill set status = 'void'
        where id = $1 and firm = $2 and status = 'draft' returning id`,
      [input.id, p.firm],
    )
    if (r.rowCount === 0) {
      throw new OperationRefused(
        'not_voidable',
        'only an untouched draft voids here — approved bills reverse their journal instead',
      )
    }
    await emitRegister(tx, p, {
      kind: 'record.changed',
      subjectType: 'gl_bill',
      subject: input.id,
      detail: { before: { status: 'draft' }, after: { status: 'void' } },
    })
  })
}
