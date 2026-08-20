// GL setup: the enable ceremony — seed the default chart (once,
// purpose-tagged, renumber-freely-after), then light the module by writing
// the two effective-dated settings. Also the one-way month lock.

import type { Principal, Tx } from '@/lib/db'
import { withPrincipal, emitRegister, OperationRefused } from '@/lib/db'
import { requireCapability } from '@/lib/ops/shared'
import { glConfigInTx } from './shared'

// The starter chart: purposes make it functional; names and codes are the
// firm's to change. Country-neutral wording.
const DEFAULT_CHART: [string, string, string, string | null, boolean][] = [
  // code, name, type, system_purpose, is_bank
  ['1000', 'Operating bank account', 'asset', 'operating_bank', true],
  ['1050', 'Bank clearing', 'asset', 'bank_clearing', false],
  ['1100', 'Trade receivables', 'asset', 'accounts_receivable', false],
  ['1300', 'Tax paid on purchases', 'asset', 'tax_paid', false],
  ['2000', 'Trade payables', 'liability', 'accounts_payable', false],
  ['2100', 'Tax collected on income', 'liability', 'tax_collected', false],
  ['3000', 'Opening balance equity', 'equity', 'opening_balance_equity', false],
  ['3100', 'Retained earnings', 'equity', 'retained_earnings', false],
  ['4000', 'Professional fees', 'income', 'revenue_default', false],
  ['4900', 'Other income', 'income', null, false],
  ['5000', 'Bad debts written off', 'expense', 'bad_debts', false],
  ['5100', 'Rounding differences', 'expense', 'rounding', false],
  ['6000', 'Office expenses', 'expense', null, false],
  ['6100', 'Rent and outgoings', 'expense', null, false],
  ['6200', 'Salaries and wages', 'expense', null, false],
  ['6300', 'Software and subscriptions', 'expense', null, false],
  ['6400', 'Insurance', 'expense', null, false],
  ['6500', 'Professional development', 'expense', null, false],
  ['6900', 'Sundry expenses', 'expense', null, false],
]

async function writeSetting(tx: Tx, key: string, value: unknown): Promise<void> {
  await tx.query(
    `insert into deedbox.firm_setting (definition, value, effective_from)
     select id, $2::jsonb, now() from deedbox.setting_definition where key = $1`,
    [key, JSON.stringify(value)],
  )
}

export async function enableGl(
  p: Principal,
  input: { conversionDate: string },
): Promise<{ seededAccounts: number }> {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(input.conversionDate)) {
    throw new OperationRefused('bad_date', 'the conversion date is a plain ISO date')
  }
  return withPrincipal(p, async (tx) => {
    await requireCapability(tx, p, 'gl.manage')
    const existing = await tx.query(
      `select count(*)::int as n from deedbox.gl_account where firm = $1`,
      [p.firm],
    )
    let seeded = 0
    if ((existing.rows[0].n as number) === 0) {
      for (const [code, name, type, purpose, isBank] of DEFAULT_CHART) {
        await tx.query(
          `insert into deedbox.gl_account (firm, code, name, account_type, system_purpose, is_bank)
           values ($1, $2, $3, $4, $5, $6)`,
          [p.firm, code, name, type, purpose, isBank],
        )
        seeded += 1
      }
      await tx.query(
        `insert into deedbox.gl_tax_code (firm, code, name, rate)
         values ($1, 'NOTAX', 'No tax', 0)`,
        [p.firm],
      )
    }
    const cfg = await glConfigInTx(tx)
    await writeSetting(tx, 'gl.conversion_date', input.conversionDate)
    if (!cfg.enabled) await writeSetting(tx, 'gl.enabled', true)
    await emitRegister(tx, p, {
      kind: 'record.changed',
      subjectType: 'gl_module',
      subject: p.firm,
      detail: {
        before: { enabled: cfg.enabled },
        after: { enabled: true, conversion_date: input.conversionDate },
      },
    })
    return { seededAccounts: seeded }
  })
}

export async function lockGlMonth(p: Principal, input: { monthStart: string }): Promise<void> {
  if (!/^\d{4}-\d{2}-01$/.test(input.monthStart)) {
    throw new OperationRefused('bad_date', 'a month lock starts on the first of the month')
  }
  await withPrincipal(p, async (tx) => {
    await requireCapability(tx, p, 'gl.manage')
    const r = await tx.query(
      `insert into deedbox.gl_period (firm, period_start, period_end, status, locked_by, locked_at)
       values ($1, $2::date, ($2::date + interval '1 month - 1 day')::date, 'locked', $3, now())
       on conflict (firm, period_start) do nothing
       returning id`,
      [p.firm, input.monthStart, p.id],
    )
    if (r.rowCount === 0) {
      const upd = await tx.query(
        `update deedbox.gl_period
            set status = 'locked', locked_by = $3, locked_at = now()
          where firm = $1 and period_start = $2 and status = 'open'
          returning id`,
        [p.firm, input.monthStart, p.id],
      )
      if (upd.rowCount === 0) {
        throw new OperationRefused('already_locked', 'that month is already locked')
      }
      await emitRegister(tx, p, {
        kind: 'record.changed',
        subjectType: 'gl_period',
        subject: upd.rows[0].id as number,
        detail: { before: { status: 'open' }, after: { status: 'locked' } },
      })
      return
    }
    await emitRegister(tx, p, {
      kind: 'record.created',
      subjectType: 'gl_period',
      subject: r.rows[0].id as number,
      detail: { month: input.monthStart, status: 'locked' },
    })
  })
}
