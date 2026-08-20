// Banking: bank accounts (each owning its asset account), the
// CSV statement import (hash-deduped, batch-counted), and bank rules.

import { createHash } from 'node:crypto'
import type { Principal } from '@/lib/db'
import { withPrincipal, emitRegister, OperationRefused } from '@/lib/db'
import { requireGl, fromCents, toCents } from './shared'

export async function createGlBankAccount(
  p: Principal,
  input: { name: string; code: string; kind?: 'bank' | 'credit_card'; bankIdentifier?: string | null; accountNumber?: string | null },
): Promise<number> {
  return withPrincipal(p, async (tx) => {
    await requireGl(tx, p)
    const acct = await tx.query(
      `insert into deedbox.gl_account (firm, code, name, account_type, is_bank)
       values ($1, $2, $3, 'asset', true) returning id`,
      [p.firm, input.code.trim(), input.name.trim()],
    )
    const r = await tx.query(
      `insert into deedbox.gl_bank_account (firm, account, name, kind, bank_identifier, account_number)
       values ($1, $2, $3, $4, $5, $6) returning id`,
      [
        p.firm,
        acct.rows[0].id as number,
        input.name.trim(),
        input.kind ?? 'bank',
        input.bankIdentifier || null,
        input.accountNumber || null,
      ],
    )
    await emitRegister(tx, p, {
      kind: 'record.created',
      subjectType: 'gl_bank_account',
      subject: r.rows[0].id as number,
      detail: { name: input.name.trim(), code: input.code.trim() },
    })
    return r.rows[0].id as number
  })
}

export interface StatementRow {
  date: string // ISO
  amountCents: number // signed: in > 0, out < 0
  description?: string | null
  reference?: string | null
  balanceCents?: number | null
}

/**
 * Plain CSV → rows using the account's column profile
 * ({ date, amount, description?, reference?, balance?, skip_header? } —
 * zero-based column indexes). Dates accepted as YYYY-MM-DD or DD/MM/YYYY.
 */
export function parseStatementCsv(
  text: string,
  profile: Record<string, unknown>,
): StatementRow[] {
  const dateCol = Number(profile.date ?? 0)
  const amountCol = Number(profile.amount ?? 1)
  const descCol = profile.description === undefined ? null : Number(profile.description)
  const refCol = profile.reference === undefined ? null : Number(profile.reference)
  const balCol = profile.balance === undefined ? null : Number(profile.balance)
  const skip = profile.skip_header === false ? 0 : 1
  const out: StatementRow[] = []
  const lines = text.split(/\r?\n/)
  for (let i = skip; i < lines.length; i++) {
    const raw = lines[i].trim()
    if (!raw) continue
    // simple CSV: quoted fields with commas supported
    const cells: string[] = []
    let cur = ''
    let q = false
    for (const ch of raw) {
      if (ch === '"') q = !q
      else if (ch === ',' && !q) {
        cells.push(cur)
        cur = ''
      } else cur += ch
    }
    cells.push(cur)
    const dRaw = (cells[dateCol] ?? '').trim()
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dRaw) ?? null
    const dmy = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(dRaw) ?? null
    const date = m
      ? dRaw
      : dmy
        ? `${dmy[3]}-${dmy[2].padStart(2, '0')}-${dmy[1].padStart(2, '0')}`
        : null
    const amount = Number((cells[amountCol] ?? '').replace(/[",$\s]/g, ''))
    if (!date || !Number.isFinite(amount) || amount === 0) continue
    out.push({
      date,
      amountCents: Math.round(amount * 100),
      description: descCol !== null ? (cells[descCol] ?? '').trim() || null : null,
      reference: refCol !== null ? (cells[refCol] ?? '').trim() || null : null,
      balanceCents:
        balCol !== null && (cells[balCol] ?? '').trim()
          ? Math.round(Number((cells[balCol] ?? '').replace(/[",$\s]/g, '')) * 100)
          : null,
    })
  }
  return out
}

export async function importStatementRows(
  p: Principal,
  input: { bankAccount: number; filename?: string | null; rows: StatementRow[] },
): Promise<{ batchId: number; inserted: number; duplicates: number }> {
  if (input.rows.length === 0) {
    throw new OperationRefused('rows_required', 'the file had no readable transaction rows')
  }
  return withPrincipal(p, async (tx) => {
    await requireGl(tx, p)
    const ba = await tx.query(
      `select id from deedbox.gl_bank_account where id = $1 and firm = $2`,
      [input.bankAccount, p.firm],
    )
    if (ba.rowCount === 0) throw new OperationRefused('bank_account_not_found', 'no such bank account')
    const batch = await tx.query(
      `insert into deedbox.gl_import_batch (firm, bank_account, imported_by, filename, row_count)
       values ($1, $2, $3, $4, $5) returning id`,
      [p.firm, input.bankAccount, p.id, input.filename ?? null, input.rows.length],
    )
    const batchId = batch.rows[0].id as number
    let inserted = 0
    for (const row of input.rows) {
      const hash = createHash('sha256')
        .update(
          [input.bankAccount, row.date, row.amountCents, row.description ?? '', row.reference ?? ''].join('|'),
        )
        .digest('hex')
      const r = await tx.query(
        `insert into deedbox.gl_statement_line
           (firm, bank_account, import_batch, transaction_date, amount, description,
            reference, balance_after, source_hash)
         values ($1,$2,$3,$4,$5,$6,$7,$8,$9)
         on conflict (bank_account, source_hash) do nothing
         returning id`,
        [
          p.firm,
          input.bankAccount,
          batchId,
          row.date,
          fromCents(row.amountCents),
          row.description ?? null,
          row.reference ?? null,
          row.balanceCents != null ? fromCents(row.balanceCents) : null,
          hash,
        ],
      )
      if ((r.rowCount ?? 0) > 0) inserted += 1
    }
    await tx.query(
      `update deedbox.gl_import_batch
          set inserted_count = $2, duplicate_count = $3 where id = $1`,
      [batchId, inserted, input.rows.length - inserted],
    )
    await tx.query(
      `update deedbox.gl_bank_account set last_imported_at = now() where id = $1`,
      [input.bankAccount],
    )
    await emitRegister(tx, p, {
      kind: 'record.created',
      subjectType: 'gl_import_batch',
      subject: batchId,
      detail: { inserted, duplicates: input.rows.length - inserted },
    })
    return { batchId, inserted, duplicates: input.rows.length - inserted }
  })
}

export async function createGlBankRule(
  p: Principal,
  input: {
    name: string
    bankAccount?: number | null
    matchDescOp?: 'contains' | 'equals' | null
    matchDesc?: string | null
    matchRef?: string | null
    amountMinCents?: number | null
    amountMaxCents?: number | null
    direction: 'in' | 'out' | 'any'
    action: 'receive_money' | 'spend_money' | 'suggest_only'
    account?: number | null
    taxCode?: number | null
    contact?: number | null
    autoPost?: boolean
  },
): Promise<number> {
  if (input.action !== 'suggest_only' && !input.account) {
    throw new OperationRefused('account_required', 'a posting rule names the account it posts to')
  }
  return withPrincipal(p, async (tx) => {
    await requireGl(tx, p)
    const r = await tx.query(
      `insert into deedbox.gl_bank_rule
         (firm, name, bank_account, match_desc_op, match_desc, match_ref,
          amount_min, amount_max, match_direction, action, account, tax_code,
          contact, auto_post, created_by)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15) returning id`,
      [
        p.firm,
        input.name.trim(),
        input.bankAccount ?? null,
        input.matchDescOp ?? null,
        input.matchDesc || null,
        input.matchRef || null,
        input.amountMinCents != null ? fromCents(input.amountMinCents) : null,
        input.amountMaxCents != null ? fromCents(input.amountMaxCents) : null,
        input.direction,
        input.action,
        input.account ?? null,
        input.taxCode ?? null,
        input.contact ?? null,
        input.autoPost ?? false,
        p.id,
      ],
    )
    return r.rows[0].id as number
  })
}

export interface RuleRow {
  id: number
  name: string
  bank_account: number | null
  match_desc_op: string | null
  match_desc: string | null
  match_ref: string | null
  amount_min: string | null
  amount_max: string | null
  match_direction: string
  action: string
  account: number | null
  tax_code: number | null
  contact: number | null
  auto_post: boolean
  priority: number
}

/** The rule matcher: every named condition must hold. */
export function ruleMatchesLine(
  r: RuleRow,
  line: { bank_account: number; direction: string; amount: unknown; description: string | null; reference: string | null },
): boolean {
  const abs = Math.abs(toCents(line.amount))
  if (r.bank_account !== null && r.bank_account !== line.bank_account) return false
  if (r.match_direction !== 'any' && r.match_direction !== line.direction) return false
  if (r.amount_min !== null && abs < toCents(r.amount_min)) return false
  if (r.amount_max !== null && abs > toCents(r.amount_max)) return false
  if (r.match_ref && !(line.reference ?? '').toLowerCase().includes(r.match_ref.toLowerCase()))
    return false
  if (r.match_desc && r.match_desc_op) {
    const d = (line.description ?? '').toLowerCase()
    const m = r.match_desc.toLowerCase()
    if (r.match_desc_op === 'contains' && !d.includes(m)) return false
    if (r.match_desc_op === 'equals' && d !== m) return false
  }
  return true
}
