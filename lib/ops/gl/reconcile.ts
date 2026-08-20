// Reconciliation: every verb is ONE transaction — the journal posts (or is
// found), the statement line flips, the match evidence lands. Tax splits
// are cents-exact from tax-inclusive bank amounts.

import type { Principal, Tx } from '@/lib/db'
import { withPrincipal, emitRegister, OperationRefused } from '@/lib/db'
import {
  requireGl,
  purposeAccountInTx,
  createPostedJournalInTx,
  taxSplitCents,
  toCents,
  fromCents,
  toIsoDate,
  type JournalLineInput,
} from './shared'
import { ruleMatchesLine, type RuleRow } from './banking'

interface LineRow {
  id: number
  firm: number
  bank_account: number
  transaction_date: string
  amount: string
  direction: string
  description: string | null
  reference: string | null
  status: string
  bank_gl_account: number
  bank_name: string
}

async function loadUnmatchedLine(tx: Tx, p: Principal, lineId: number): Promise<LineRow> {
  const r = await tx.query(
    `select l.*, b.account as bank_gl_account, b.name as bank_name
       from deedbox.gl_statement_line l
       join deedbox.gl_bank_account b on b.id = l.bank_account
      where l.id = $1 and l.firm = $2
      for update of l`,
    [lineId, p.firm],
  )
  if (r.rowCount === 0) throw new OperationRefused('line_not_found', 'no such statement line')
  const line = r.rows[0] as unknown as LineRow
  if (line.status !== 'unmatched') {
    throw new OperationRefused('line_settled', `that line is already ${line.status}`)
  }
  return line
}

async function settleLineInTx(
  tx: Tx,
  p: Principal,
  line: LineRow,
  matchType: 'receive' | 'spend' | 'bill' | 'transfer' | 'ignore',
  journal: number | null,
  bill: number | null,
  method: 'manual' | 'rule' | 'auto',
): Promise<void> {
  await tx.query(
    `update deedbox.gl_statement_line
        set status = $2, matched_journal = $3, reconciled_at = now(), reconciled_by = $4
      where id = $1`,
    [line.id, matchType === 'ignore' ? 'ignored' : 'matched', journal, p.kind === 'staff' ? p.id : null],
  )
  await tx.query(
    `insert into deedbox.gl_match (firm, statement_line, match_type, journal, bill, amount, method, created_by)
     values ($1,$2,$3,$4,$5,$6,$7,$8)`,
    [
      p.firm,
      line.id,
      matchType,
      journal,
      bill,
      line.amount,
      method,
      p.kind === 'staff' ? p.id : null,
    ],
  )
  await emitRegister(tx, p, {
    kind: 'record.changed',
    subjectType: 'gl_statement_line',
    subject: line.id,
    detail: {
      before: { status: 'unmatched' },
      after: { status: matchType === 'ignore' ? 'ignored' : 'matched', match: matchType },
    },
  })
}

export interface ReceiveSpendInput {
  lineId: number
  account: number
  taxCode?: number | null
  contact?: number | null
  matter?: number | null
  description?: string | null
}

export async function reconcileReceive(
  p: Principal,
  input: ReceiveSpendInput,
  method: 'manual' | 'rule' | 'auto' = 'manual',
): Promise<{ journalNo: string }> {
  return withPrincipal(p, async (tx) => {
    await requireGl(tx, p)
    return receiveInTx(tx, p, input, method)
  })
}

async function taxRate(tx: Tx, firm: number, taxCode: number | null | undefined): Promise<number> {
  if (!taxCode) return 0
  const r = await tx.query(`select rate from deedbox.gl_tax_code where id = $1 and firm = $2`, [
    taxCode,
    firm,
  ])
  if (r.rowCount === 0) throw new OperationRefused('tax_code_not_found', 'no such tax code')
  return Number(r.rows[0].rate)
}

async function receiveInTx(
  tx: Tx,
  p: Principal,
  input: ReceiveSpendInput,
  method: 'manual' | 'rule' | 'auto',
): Promise<{ journalNo: string }> {
  const line = await loadUnmatchedLine(tx, p, input.lineId)
  const cents = toCents(line.amount)
  if (cents <= 0) throw new OperationRefused('wrong_direction', 'receive is for money-in lines')
  const rate = await taxRate(tx, p.firm, input.taxCode)
  const { net, tax } = taxSplitCents(cents, rate)
  const lines: JournalLineInput[] = [
    {
      account: line.bank_gl_account,
      debitCents: cents,
      description: `Received into ${line.bank_name}`,
    },
    {
      account: input.account,
      creditCents: net,
      taxCode: input.taxCode ?? null,
      description: input.description ?? line.description ?? 'Income',
      matter: input.matter ?? null,
      contact: input.contact ?? null,
    },
  ]
  if (tax > 0) {
    lines.push({
      account: await purposeAccountInTx(tx, p.firm, 'tax_collected'),
      creditCents: tax,
      description: 'Tax collected',
    })
  }
  const j = await createPostedJournalInTx(tx, p, {
    journalDate: toIsoDate(line.transaction_date),
    description: input.description ?? `Receipt: ${line.description ?? line.reference ?? 'bank credit'}`,
    sourceType: 'bank_receive',
    sourceRef: `stmt:${line.id}`,
    lines,
  })
  await settleLineInTx(tx, p, line, 'receive', j.id, null, method)
  return { journalNo: j.journalNo }
}

export async function reconcileSpend(
  p: Principal,
  input: ReceiveSpendInput,
  method: 'manual' | 'rule' | 'auto' = 'manual',
): Promise<{ journalNo: string }> {
  return withPrincipal(p, async (tx) => {
    await requireGl(tx, p)
    return spendInTx(tx, p, input, method)
  })
}

async function spendInTx(
  tx: Tx,
  p: Principal,
  input: ReceiveSpendInput,
  method: 'manual' | 'rule' | 'auto',
): Promise<{ journalNo: string }> {
  const line = await loadUnmatchedLine(tx, p, input.lineId)
  const cents = toCents(line.amount)
  if (cents >= 0) throw new OperationRefused('wrong_direction', 'spend is for money-out lines')
  const out = -cents
  const rate = await taxRate(tx, p.firm, input.taxCode)
  const { net, tax } = taxSplitCents(out, rate)
  const lines: JournalLineInput[] = [
    {
      account: input.account,
      debitCents: net,
      taxCode: input.taxCode ?? null,
      description: input.description ?? line.description ?? 'Expense',
      matter: input.matter ?? null,
      contact: input.contact ?? null,
    },
  ]
  if (tax > 0) {
    lines.push({
      account: await purposeAccountInTx(tx, p.firm, 'tax_paid'),
      debitCents: tax,
      description: 'Tax paid',
    })
  }
  lines.push({
    account: line.bank_gl_account,
    creditCents: out,
    description: `Paid from ${line.bank_name}`,
  })
  const j = await createPostedJournalInTx(tx, p, {
    journalDate: toIsoDate(line.transaction_date),
    description: input.description ?? `Spend: ${line.description ?? line.reference ?? 'bank payment'}`,
    sourceType: 'bank_spend',
    sourceRef: `stmt:${line.id}`,
    lines,
  })
  await settleLineInTx(tx, p, line, 'spend', j.id, null, method)
  return { journalNo: j.journalNo }
}

/** Pay an approved supplier bill from a money-out line. */
export async function reconcileMatchBill(
  p: Principal,
  input: { lineId: number; billId: number },
): Promise<{ journalNo: string }> {
  return withPrincipal(p, async (tx) => {
    await requireGl(tx, p)
    const line = await loadUnmatchedLine(tx, p, input.lineId)
    const cents = toCents(line.amount)
    if (cents >= 0) throw new OperationRefused('wrong_direction', 'a bill is paid by a money-out line')
    const out = -cents
    const b = await tx.query(
      `select * from deedbox.gl_bill where id = $1 and firm = $2 for update`,
      [input.billId, p.firm],
    )
    if (b.rowCount === 0) throw new OperationRefused('bill_not_found', 'no such bill')
    const bill = b.rows[0] as Record<string, unknown>
    if (bill.status !== 'approved') {
      throw new OperationRefused('not_approved', `a ${bill.status} bill cannot take payments`)
    }
    const owing = toCents(bill.total) - toCents(bill.amount_paid)
    if (out > owing) {
      throw new OperationRefused(
        'overpays_bill',
        `that line (${fromCents(out)}) exceeds what the bill still owes (${fromCents(owing)})`,
      )
    }
    const ap = await purposeAccountInTx(tx, p.firm, 'accounts_payable')
    const j = await createPostedJournalInTx(tx, p, {
      journalDate: toIsoDate(line.transaction_date),
      description: `Payment of bill ${bill.bill_number ?? input.billId}`,
      sourceType: 'bill_payment',
      sourceRef: `stmt:${line.id}`,
      lines: [
        { account: ap, debitCents: out, description: 'Accounts payable', contact: bill.contact as number },
        { account: line.bank_gl_account, creditCents: out, description: `Paid from ${line.bank_name}` },
      ],
    })
    const newPaid = toCents(bill.amount_paid) + out
    await tx.query(
      `update deedbox.gl_bill set amount_paid = $2, status = case when $2::numeric = total then 'paid' else status end
        where id = $1`,
      [input.billId, fromCents(newPaid)],
    )
    await settleLineInTx(tx, p, line, 'bill', j.id, input.billId, 'manual')
    return { journalNo: j.journalNo }
  })
}

/** Money moved between two of the firm's own bank accounts. */
export async function reconcileTransfer(
  p: Principal,
  input: { lineId: number; otherBankAccount: number },
): Promise<{ journalNo: string }> {
  return withPrincipal(p, async (tx) => {
    await requireGl(tx, p)
    const line = await loadUnmatchedLine(tx, p, input.lineId)
    const other = await tx.query(
      `select b.id, b.name, b.account from deedbox.gl_bank_account b where b.id = $1 and b.firm = $2`,
      [input.otherBankAccount, p.firm],
    )
    if (other.rowCount === 0) throw new OperationRefused('bank_account_not_found', 'no such bank account')
    if ((other.rows[0].id as number) === line.bank_account) {
      throw new OperationRefused('same_account', 'a transfer involves two different accounts')
    }
    const cents = toCents(line.amount)
    const abs = Math.abs(cents)
    const otherAcct = other.rows[0].account as number
    const lines =
      cents > 0
        ? [
            { account: line.bank_gl_account, debitCents: abs, description: `Into ${line.bank_name}` },
            { account: otherAcct, creditCents: abs, description: `From ${other.rows[0].name as string}` },
          ]
        : [
            { account: otherAcct, debitCents: abs, description: `Into ${other.rows[0].name as string}` },
            { account: line.bank_gl_account, creditCents: abs, description: `From ${line.bank_name}` },
          ]
    const j = await createPostedJournalInTx(tx, p, {
      journalDate: toIsoDate(line.transaction_date),
      description: `Transfer between accounts`,
      sourceType: 'bank_transfer',
      sourceRef: `stmt:${line.id}`,
      lines,
    })
    await settleLineInTx(tx, p, line, 'transfer', j.id, null, 'manual')
    return { journalNo: j.journalNo }
  })
}

export async function reconcileIgnore(
  p: Principal,
  input: { lineId: number },
): Promise<void> {
  await withPrincipal(p, async (tx) => {
    await requireGl(tx, p)
    const line = await loadUnmatchedLine(tx, p, input.lineId)
    await settleLineInTx(tx, p, line, 'ignore', null, null, 'manual')
  })
}

/** Match a line to an ALREADY-POSTED journal touching this bank account
 *  for the same signed amount (the bridge posts receipts before the bank
 *  statement arrives — this closes that loop without double-booking). */
export async function reconcileMatchJournal(
  p: Principal,
  input: { lineId: number; journalId: number },
): Promise<void> {
  await withPrincipal(p, async (tx) => {
    await requireGl(tx, p)
    const line = await loadUnmatchedLine(tx, p, input.lineId)
    const cents = toCents(line.amount)
    const j = await tx.query(
      `select j.id, j.status,
              coalesce(sum(case when l.account = $3 then l.debit - l.credit else 0 end), 0) as bank_delta
         from deedbox.gl_journal j
         join deedbox.gl_journal_line l on l.journal = j.id
        where j.id = $1 and j.firm = $2
        group by j.id, j.status`,
      [input.journalId, p.firm, line.bank_gl_account],
    )
    if (j.rowCount === 0) throw new OperationRefused('journal_not_found', 'no such journal')
    if (j.rows[0].status !== 'posted') {
      throw new OperationRefused('not_posted', 'only a posted journal matches a bank line')
    }
    if (toCents(j.rows[0].bank_delta) !== cents) {
      throw new OperationRefused(
        'amount_mismatch',
        `that journal moves ${fromCents(toCents(j.rows[0].bank_delta))} on this account, the line is ${fromCents(cents)}`,
      )
    }
    const already = await tx.query(
      `select 1 from deedbox.gl_statement_line where matched_journal = $1 and status = 'matched'`,
      [input.journalId],
    )
    if ((already.rowCount ?? 0) > 0) {
      throw new OperationRefused('journal_taken', 'that journal is already matched to another line')
    }
    await settleLineInTx(tx, p, line, cents > 0 ? 'receive' : 'spend', input.journalId, null, 'manual')
  })
}

/** Apply auto-posting rules across an account's unmatched lines. */
export async function autoReconcile(
  p: Principal,
  input: { bankAccount: number },
): Promise<{ posted: number; leftForReview: number }> {
  return withPrincipal(p, async (tx) => {
    await requireGl(tx, p)
    const rules = await tx.query(
      `select * from deedbox.gl_bank_rule
        where firm = $1 and active and auto_post and action <> 'suggest_only'
        order by priority, id`,
      [p.firm],
    )
    const lines = await tx.query(
      `select l.id from deedbox.gl_statement_line l
        where l.firm = $1 and l.bank_account = $2 and l.status = 'unmatched'
        order by l.transaction_date, l.id`,
      [p.firm, input.bankAccount],
    )
    let posted = 0
    for (const lr of lines.rows as { id: number }[]) {
      const fresh = await tx.query(
        `select l.*, b.account as bank_gl_account, b.name as bank_name
           from deedbox.gl_statement_line l
           join deedbox.gl_bank_account b on b.id = l.bank_account
          where l.id = $1`,
        [lr.id],
      )
      const line = fresh.rows[0] as unknown as LineRow & Record<string, unknown>
      const rule = (rules.rows as unknown as RuleRow[]).find((r) =>
        ruleMatchesLine(r, {
          bank_account: line.bank_account,
          direction: line.direction,
          amount: line.amount,
          description: line.description,
          reference: line.reference,
        }),
      )
      if (!rule || !rule.account) continue
      const args = {
        lineId: line.id,
        account: rule.account,
        taxCode: rule.tax_code,
        contact: rule.contact,
        description: null,
      }
      if (rule.action === 'receive_money' && toCents(line.amount) > 0) {
        await receiveInTx(tx, p, args, 'rule')
        posted += 1
      } else if (rule.action === 'spend_money' && toCents(line.amount) < 0) {
        await spendInTx(tx, p, args, 'rule')
        posted += 1
      }
    }
    return { posted, leftForReview: lines.rowCount! - posted }
  })
}
