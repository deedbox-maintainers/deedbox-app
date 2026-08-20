// Manual journals: draft → posted → (controlled) reversed. The
// schema guard owns every posting invariant; these operations sequence it
// and write the register.

import type { Principal } from '@/lib/db'
import { withPrincipal, emitRegister, OperationRefused } from '@/lib/db'
import { requireGl, createPostedJournalInTx, fromCents, firmTodayInTx, type JournalLineInput } from './shared'

export async function createManualJournal(
  p: Principal,
  input: { journalDate: string; description: string; lines: JournalLineInput[] },
): Promise<{ id: number; journalNo: string }> {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(input.journalDate)) {
    throw new OperationRefused('bad_date', 'the journal date is a plain ISO date')
  }
  if (!input.description.trim()) {
    throw new OperationRefused('description_required', 'say what the journal records')
  }
  const debits = input.lines.reduce((s, l) => s + (l.debitCents ?? 0), 0)
  const credits = input.lines.reduce((s, l) => s + (l.creditCents ?? 0), 0)
  if (input.lines.length < 2 || debits !== credits || debits === 0) {
    throw new OperationRefused(
      'unbalanced',
      `debits ${fromCents(debits)} must equal credits ${fromCents(credits)}, above zero`,
    )
  }
  return withPrincipal(p, async (tx) => {
    await requireGl(tx, p)
    return createPostedJournalInTx(tx, p, {
      journalDate: input.journalDate,
      description: input.description.trim(),
      sourceType: 'manual',
      lines: input.lines,
    })
  })
}

/** The controlled reversal: a posted mirror, then the original's transition. */
export async function reverseGlJournal(
  p: Principal,
  input: { id: number; reversalDate?: string | null },
): Promise<{ reversalId: number; reversalNo: string }> {
  return withPrincipal(p, async (tx) => {
    await requireGl(tx, p)
    const j = await tx.query(
      `select * from deedbox.gl_journal where id = $1 and firm = $2 for update`,
      [input.id, p.firm],
    )
    if (j.rowCount === 0) throw new OperationRefused('journal_not_found', 'no such journal')
    const row = j.rows[0] as Record<string, unknown>
    if (row.status !== 'posted') {
      throw new OperationRefused('not_posted', `a ${row.status} journal cannot be reversed`)
    }
    const lines = await tx.query(
      `select account, tax_code, debit, credit, description, matter, contact
         from deedbox.gl_journal_line where journal = $1 order by line_no`,
      [input.id],
    )
    const date =
      input.reversalDate && /^\d{4}-\d{2}-\d{2}$/.test(input.reversalDate)
        ? input.reversalDate
        : await firmTodayInTx(tx, p.firm)
    const mirror = await createPostedJournalInTx(tx, p, {
      journalDate: date,
      description: `Reversal of ${row.journal_no}: ${row.description}`,
      sourceType: 'reversal',
      reversalOf: input.id,
      lines: (lines.rows as Record<string, unknown>[]).map((l) => ({
        account: l.account as number,
        taxCode: (l.tax_code as number | null) ?? null,
        debitCents: Math.round(Number(l.credit) * 100),
        creditCents: Math.round(Number(l.debit) * 100),
        description: (l.description as string | null) ?? null,
        matter: (l.matter as number | null) ?? null,
        contact: (l.contact as number | null) ?? null,
      })),
    })
    await tx.query(
      `update deedbox.gl_journal
          set status = 'reversed', reversed_by = $2, reversed_at = now()
        where id = $1`,
      [input.id, p.id],
    )
    await emitRegister(tx, p, {
      kind: 'record.changed',
      subjectType: 'gl_journal',
      subject: input.id,
      detail: {
        before: { status: 'posted' },
        after: { status: 'reversed', reversal_no: mirror.journalNo },
      },
    })
    return { reversalId: mirror.id, reversalNo: mirror.journalNo }
  })
}

/** Opening balances: caller lines plus an equity plug, one posted journal. */
export async function postOpeningBalances(
  p: Principal,
  input: {
    asOf: string
    lines: { account: number; debitCents?: number; creditCents?: number }[]
  },
): Promise<{ id: number; journalNo: string }> {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(input.asOf)) {
    throw new OperationRefused('bad_date', 'the opening date is a plain ISO date')
  }
  if (input.lines.length === 0) {
    throw new OperationRefused('lines_required', 'enter at least one opening balance')
  }
  return withPrincipal(p, async (tx) => {
    await requireGl(tx, p)
    const existing = await tx.query(
      `select 1 from deedbox.gl_journal
        where firm = $1 and source_type = 'opening_balance' and status <> 'reversed'`,
      [p.firm],
    )
    if ((existing.rowCount ?? 0) > 0) {
      throw new OperationRefused(
        'opening_exists',
        'opening balances are already posted — reverse that journal first if they were wrong',
      )
    }
    const lines: JournalLineInput[] = input.lines.map((l) => ({
      account: l.account,
      debitCents: l.debitCents ?? 0,
      creditCents: l.creditCents ?? 0,
      description: 'Opening balance',
    }))
    const debits = lines.reduce((s, l) => s + (l.debitCents ?? 0), 0)
    const credits = lines.reduce((s, l) => s + (l.creditCents ?? 0), 0)
    if (debits !== credits) {
      const eq = await tx.query(
        `select deedbox.gl_purpose_account($1, 'opening_balance_equity') as id`,
        [p.firm],
      )
      const plug = eq.rows[0]?.id as number | null
      if (!plug) {
        throw new OperationRefused(
          'gl_purpose_missing',
          'the chart has no opening-balance-equity account for the balancing entry',
        )
      }
      lines.push(
        debits > credits
          ? { account: plug, creditCents: debits - credits, description: 'Opening balance equity' }
          : { account: plug, debitCents: credits - debits, description: 'Opening balance equity' },
      )
    }
    return createPostedJournalInTx(tx, p, {
      journalDate: input.asOf,
      description: `Opening balances as at ${input.asOf}`,
      sourceType: 'opening_balance',
      sourceRef: `opening:${input.asOf}`,
      lines,
    })
  })
}
