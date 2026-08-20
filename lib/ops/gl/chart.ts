// Chart, tax codes and office contacts. Plain administration —
// the schema protects purpose rows and used-account types.

import type { Principal } from '@/lib/db'
import { withPrincipal, OperationRefused } from '@/lib/db'
import { requireGl } from './shared'

const TYPES = ['asset', 'liability', 'equity', 'income', 'expense']

export async function createGlAccount(
  p: Principal,
  input: { code: string; name: string; accountType: string; description?: string | null },
): Promise<number> {
  if (!TYPES.includes(input.accountType)) {
    throw new OperationRefused('bad_type', 'unknown account type')
  }
  return withPrincipal(p, async (tx) => {
    await requireGl(tx, p)
    const r = await tx.query(
      `insert into deedbox.gl_account (firm, code, name, account_type, description)
       values ($1, $2, $3, $4, $5) returning id`,
      [p.firm, input.code.trim(), input.name.trim(), input.accountType, input.description ?? null],
    )
    return r.rows[0].id as number
  })
}

export async function updateGlAccount(
  p: Principal,
  input: { id: number; code: string; name: string; active: boolean },
): Promise<void> {
  await withPrincipal(p, async (tx) => {
    await requireGl(tx, p)
    const r = await tx.query(
      `update deedbox.gl_account set code = $3, name = $4, active = $5
        where id = $1 and firm = $2 returning id`,
      [input.id, p.firm, input.code.trim(), input.name.trim(), input.active],
    )
    if (r.rowCount === 0) throw new OperationRefused('account_not_found', 'no such account')
  })
}

export async function createGlTaxCode(
  p: Principal,
  input: { code: string; name: string; ratePercent: number },
): Promise<number> {
  const rate = Number(input.ratePercent) / 100
  if (!(rate >= 0 && rate < 1)) {
    throw new OperationRefused('bad_rate', 'the rate is a percentage below 100')
  }
  return withPrincipal(p, async (tx) => {
    await requireGl(tx, p)
    const r = await tx.query(
      `insert into deedbox.gl_tax_code (firm, code, name, rate)
       values ($1, $2, $3, $4) returning id`,
      [p.firm, input.code.trim().toUpperCase(), input.name.trim(), rate.toFixed(4)],
    )
    return r.rows[0].id as number
  })
}

export async function createGlContact(
  p: Principal,
  input: { name: string; email?: string | null; phone?: string | null; taxIdentifier?: string | null },
): Promise<number> {
  return withPrincipal(p, async (tx) => {
    await requireGl(tx, p)
    const r = await tx.query(
      `insert into deedbox.gl_contact (firm, name, email, phone, tax_identifier)
       values ($1, $2, $3, $4, $5) returning id`,
      [p.firm, input.name.trim(), input.email || null, input.phone || null, input.taxIdentifier || null],
    )
    return r.rows[0].id as number
  })
}
