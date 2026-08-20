// GL shared plumbing: the dark-until-configured gate, purpose
// resolution (never code literals), cents-safe tax splitting, and the one
// posted-journal builder every verb and the bridge ride.

import type { Principal, Tx } from '@/lib/db'
import { OperationRefused, emitRegister } from '@/lib/db'
import { requireCapability } from '@/lib/ops/shared'

export interface GlConfig {
  enabled: boolean
  conversionDate: string | null
}

export async function glConfigInTx(tx: Tx): Promise<GlConfig> {
  const r = await tx.query(
    `select deedbox.current_setting_value('gl.enabled') #>> '{}' as enabled,
            deedbox.current_setting_value('gl.conversion_date') #>> '{}' as conversion`,
  )
  const row = r.rows[0] as { enabled: string | null; conversion: string | null }
  const conversion = (row.conversion ?? '').trim()
  return {
    enabled: row.enabled === 'true',
    conversionDate: /^\d{4}-\d{2}-\d{2}$/.test(conversion) ? conversion : null,
  }
}

export async function requireGl(tx: Tx, p: Principal): Promise<GlConfig> {
  await requireCapability(tx, p, 'gl.manage')
  const cfg = await glConfigInTx(tx)
  if (!cfg.enabled || !cfg.conversionDate) {
    throw new OperationRefused(
      'gl_not_enabled',
      'the office-accounting module is not switched on — set it up under Firm accounts',
    )
  }
  return cfg
}

export async function purposeAccountInTx(
  tx: Tx,
  firm: number,
  purpose: string,
): Promise<number> {
  const r = await tx.query(`select deedbox.gl_purpose_account($1, $2) as id`, [firm, purpose])
  const id = r.rows[0]?.id as number | null
  if (!id) {
    throw new OperationRefused(
      'gl_purpose_missing',
      `the chart has no active account for the ${purpose} purpose`,
    )
  }
  return id
}

/** Money as integer cents; pg numeric(18,2) strings convert exactly. */
export function toCents(v: unknown): number {
  return Math.round(Number(v ?? 0) * 100)
}
export function fromCents(c: number): string {
  return (c / 100).toFixed(2)
}

/** Tax-inclusive split, cents-exact: gst = amount × rate ÷ (1 + rate). */
export function taxSplitCents(amountCents: number, rate: number): { net: number; tax: number } {
  const tax = Math.round((amountCents * rate) / (1 + rate))
  return { net: amountCents - tax, tax }
}

/**
 * A calendar date as 'YYYY-MM-DD'. pg hands date columns back as JS Date
 * objects at LOCAL midnight — String() renders 'Sat Aug 15 …' (which
 * postgres refuses as a date) and toISOString() shifts a Sydney midnight
 * onto the previous UTC day, so format the local parts. Strings pass
 * through on their first ten characters.
 */
export function toIsoDate(value: unknown): string {
  if (value instanceof Date) {
    const m = String(value.getMonth() + 1).padStart(2, '0')
    const d = String(value.getDate()).padStart(2, '0')
    return `${value.getFullYear()}-${m}-${d}`
  }
  return String(value).slice(0, 10)
}

/** Today as 'YYYY-MM-DD' in the firm's own timezone (the issue-op pattern). */
export async function firmTodayInTx(tx: Tx, firm: number): Promise<string> {
  const r = await tx.query(
    `select (now() at time zone (select timezone from deedbox.firm where id = $1))::date::text as d`,
    [firm],
  )
  return r.rows[0].d as string
}

export interface JournalLineInput {
  account: number
  debitCents?: number
  creditCents?: number
  taxCode?: number | null
  description?: string | null
  matter?: number | null
  contact?: number | null
}

/**
 * One posted journal in the caller's transaction: draft + lines inserted,
 * the gapless number allocated, the posting transition flipped (the schema
 * guard proves balance, value, accounts and the period lock), the register
 * written. Returns the journal id and number.
 */
export async function createPostedJournalInTx(
  tx: Tx,
  p: Principal,
  input: {
    journalDate: string
    description: string
    sourceType: string
    sourceRef?: string | null
    reversalOf?: number | null
    lines: JournalLineInput[]
  },
): Promise<{ id: number; journalNo: string }> {
  const j = await tx.query(
    `insert into deedbox.gl_journal
       (firm, journal_date, description, source_type, source_ref, reversal_of, created_by)
     values ($1, $2, $3, $4, $5, $6, $7) returning id`,
    [
      p.firm,
      input.journalDate,
      input.description.slice(0, 255),
      input.sourceType,
      input.sourceRef ?? null,
      input.reversalOf ?? null,
      p.kind === 'staff' ? p.id : null,
    ],
  )
  const id = j.rows[0].id as number
  let lineNo = 0
  for (const l of input.lines) {
    lineNo += 1
    await tx.query(
      `insert into deedbox.gl_journal_line
         (journal, line_no, account, tax_code, debit, credit, description, matter, contact)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
      [
        id,
        lineNo,
        l.account,
        l.taxCode ?? null,
        fromCents(l.debitCents ?? 0),
        fromCents(l.creditCents ?? 0),
        l.description ?? null,
        l.matter ?? null,
        l.contact ?? null,
      ],
    )
  }
  const num = await tx.query(`select deedbox.allocate_number('gl_journal', null, $1) as n`, [
    input.journalDate,
  ])
  const journalNo = num.rows[0].n as string
  await tx.query(
    `update deedbox.gl_journal
        set status = 'posted', journal_no = $2, posted_by = $3, posted_at = now()
      where id = $1`,
    [id, journalNo, p.kind === 'staff' ? p.id : null],
  )
  await emitRegister(tx, p, {
    kind: 'record.created',
    subjectType: 'gl_journal',
    subject: id,
    detail: {
      journal_no: journalNo,
      source_type: input.sourceType,
      journal_date: input.journalDate,
    },
  })
  return { id, journalNo }
}
