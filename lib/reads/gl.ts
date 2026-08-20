// GL reads: module status, the chart, journals, bills, contacts, the
// reconciliation workbench (with rule and bill suggestions), and the
// financial reports — plain SQL over posted journal lines. Every read is
// gated gl.manage; the status read alone answers un-gated so the index
// door can render honestly.

import type { Principal, Tx } from '@/lib/db'
import { withPrincipal, OperationRefused } from '@/lib/db'
import { hasCapability } from '@/lib/ops/shared'
import { glConfigInTx, toIsoDate } from '@/lib/ops/gl/shared'
import { ruleMatchesLine, type RuleRow } from '@/lib/ops/gl/banking'

async function requireGlRead(tx: Tx, p: Principal): Promise<void> {
  if (!(await hasCapability(tx, p.id, 'gl.manage'))) {
    throw new OperationRefused('capability_missing', 'this screen requires gl.manage')
  }
}

export interface GlStatus {
  mayManage: boolean
  enabled: boolean
  conversionDate: string | null
  accounts: number
  unmatchedLines: number
  draftBills: number
}

export async function glStatus(p: Principal): Promise<GlStatus> {
  return withPrincipal(
    p,
    async (tx) => {
      const mayManage = await hasCapability(tx, p.id, 'gl.manage')
      const cfg = await glConfigInTx(tx)
      if (!mayManage || !cfg.enabled) {
        return {
          mayManage,
          enabled: cfg.enabled,
          conversionDate: cfg.conversionDate,
          accounts: 0,
          unmatchedLines: 0,
          draftBills: 0,
        }
      }
      const c = await tx.query(
        `select
           (select count(*)::int from deedbox.gl_account where firm = $1 and active) as accounts,
           (select count(*)::int from deedbox.gl_statement_line where firm = $1 and status = 'unmatched') as unmatched,
           (select count(*)::int from deedbox.gl_bill where firm = $1 and status = 'draft') as drafts`,
        [p.firm],
      )
      return {
        mayManage,
        enabled: cfg.enabled,
        conversionDate: cfg.conversionDate,
        accounts: c.rows[0].accounts as number,
        unmatchedLines: c.rows[0].unmatched as number,
        draftBills: c.rows[0].drafts as number,
      }
    },
    { readOnly: true },
  )
}

export async function glChart(p: Principal) {
  return withPrincipal(
    p,
    async (tx) => {
      await requireGlRead(tx, p)
      const accounts = await tx.query(
        `select a.id, a.code, a.name, a.account_type, a.system_purpose, a.is_bank, a.active,
                coalesce(sum(l.debit - l.credit) filter (where j.status = 'posted'), 0) as balance
           from deedbox.gl_account a
           left join deedbox.gl_journal_line l on l.account = a.id
           left join deedbox.gl_journal j on j.id = l.journal
          where a.firm = $1
          group by a.id
          order by a.code`,
        [p.firm],
      )
      const taxCodes = await tx.query(
        `select id, code, name, rate, active from deedbox.gl_tax_code where firm = $1 order by code`,
        [p.firm],
      )
      return { accounts: accounts.rows, taxCodes: taxCodes.rows }
    },
    { readOnly: true },
  )
}

export async function glContacts(p: Principal) {
  return withPrincipal(
    p,
    async (tx) => {
      await requireGlRead(tx, p)
      const r = await tx.query(
        `select c.*, count(b.id)::int as bills
           from deedbox.gl_contact c
           left join deedbox.gl_bill b on b.contact = c.id
          where c.firm = $1 group by c.id order by c.name`,
        [p.firm],
      )
      return r.rows
    },
    { readOnly: true },
  )
}

export async function glJournals(p: Principal, limit = 100) {
  return withPrincipal(
    p,
    async (tx) => {
      await requireGlRead(tx, p)
      const r = await tx.query(
        `select j.id, j.journal_no, j.journal_date, j.description, j.source_type, j.status,
                coalesce(sum(l.debit), 0) as amount
           from deedbox.gl_journal j
           left join deedbox.gl_journal_line l on l.journal = j.id
          where j.firm = $1
          group by j.id
          order by j.id desc
          limit $2`,
        [p.firm, limit],
      )
      return r.rows
    },
    { readOnly: true },
  )
}

export async function glJournalView(p: Principal, id: number) {
  return withPrincipal(
    p,
    async (tx) => {
      await requireGlRead(tx, p)
      const j = await tx.query(`select * from deedbox.gl_journal where id = $1 and firm = $2`, [
        id,
        p.firm,
      ])
      if (j.rowCount === 0) return null
      const lines = await tx.query(
        `select l.*, a.code, a.name as account_name, t.code as tax_code_label
           from deedbox.gl_journal_line l
           join deedbox.gl_account a on a.id = l.account
           left join deedbox.gl_tax_code t on t.id = l.tax_code
          where l.journal = $1 order by l.line_no`,
        [id],
      )
      return { journal: j.rows[0], lines: lines.rows }
    },
    { readOnly: true },
  )
}

export async function glBills(p: Principal) {
  return withPrincipal(
    p,
    async (tx) => {
      await requireGlRead(tx, p)
      const r = await tx.query(
        `select b.*, c.name as contact_name
           from deedbox.gl_bill b join deedbox.gl_contact c on c.id = b.contact
          where b.firm = $1 order by b.bill_date desc, b.id desc limit 200`,
        [p.firm],
      )
      return r.rows
    },
    { readOnly: true },
  )
}

export interface WorkbenchLine {
  id: number
  transaction_date: string
  amount: string
  direction: string
  description: string | null
  reference: string | null
  ruleSuggestion: { rule: string; action: string; account: number | null } | null
  billCandidates: { id: number; bill_number: string | null; contact_name: string; owing: string }[]
}

export async function glWorkbench(p: Principal, bankAccountId: number) {
  return withPrincipal(
    p,
    async (tx) => {
      await requireGlRead(tx, p)
      const cfg = await glConfigInTx(tx)
      if (!cfg.enabled) throw new OperationRefused('gl_not_enabled', 'set the module up first')
      const account = await tx.query(
        `select b.*, a.code from deedbox.gl_bank_account b
           join deedbox.gl_account a on a.id = b.account
          where b.id = $1 and b.firm = $2`,
        [bankAccountId, p.firm],
      )
      if (account.rowCount === 0) {
        throw new OperationRefused('bank_account_not_found', 'no such bank account')
      }
      const rules = await tx.query(
        `select * from deedbox.gl_bank_rule where firm = $1 and active order by priority, id`,
        [p.firm],
      )
      const lines = await tx.query(
        `select * from deedbox.gl_statement_line
          where firm = $1 and bank_account = $2 and status = 'unmatched'
          order by transaction_date, id limit 200`,
        [p.firm, bankAccountId],
      )
      const openBills = await tx.query(
        `select b.id, b.bill_number, b.total, b.amount_paid, c.name as contact_name
           from deedbox.gl_bill b join deedbox.gl_contact c on c.id = b.contact
          where b.firm = $1 and b.status = 'approved'`,
        [p.firm],
      )
      const out: WorkbenchLine[] = (lines.rows as Record<string, unknown>[]).map((l) => {
        const rule = (rules.rows as unknown as RuleRow[]).find((r) =>
          ruleMatchesLine(r, {
            bank_account: l.bank_account as number,
            direction: l.direction as string,
            amount: l.amount,
            description: (l.description as string | null) ?? null,
            reference: (l.reference as string | null) ?? null,
          }),
        )
        const amountCents = Math.round(Number(l.amount) * 100)
        const candidates =
          amountCents < 0
            ? (openBills.rows as Record<string, unknown>[])
                .filter(
                  (b) =>
                    Math.round((Number(b.total) - Number(b.amount_paid)) * 100) >= -amountCents,
                )
                .slice(0, 5)
                .map((b) => ({
                  id: b.id as number,
                  bill_number: (b.bill_number as string | null) ?? null,
                  contact_name: b.contact_name as string,
                  owing: (Number(b.total) - Number(b.amount_paid)).toFixed(2),
                }))
            : []
        return {
          id: l.id as number,
          transaction_date: toIsoDate(l.transaction_date),
          amount: String(l.amount),
          direction: l.direction as string,
          description: (l.description as string | null) ?? null,
          reference: (l.reference as string | null) ?? null,
          ruleSuggestion: rule
            ? { rule: rule.name, action: rule.action, account: rule.account }
            : null,
          billCandidates: candidates,
        }
      })
      const accounts = await tx.query(
        `select id, code, name, account_type from deedbox.gl_account
          where firm = $1 and active order by code`,
        [p.firm],
      )
      const taxCodes = await tx.query(
        `select id, code, name from deedbox.gl_tax_code where firm = $1 and active order by code`,
        [p.firm],
      )
      const otherBanks = await tx.query(
        `select id, name from deedbox.gl_bank_account where firm = $1 and active and id <> $2`,
        [p.firm, bankAccountId],
      )
      return {
        account: account.rows[0],
        lines: out,
        accounts: accounts.rows,
        taxCodes: taxCodes.rows,
        otherBanks: otherBanks.rows,
      }
    },
    { readOnly: true },
  )
}

export async function glBankAccounts(p: Principal) {
  return withPrincipal(
    p,
    async (tx) => {
      await requireGlRead(tx, p)
      const r = await tx.query(
        `select b.*, a.code,
                (select count(*)::int from deedbox.gl_statement_line l
                  where l.bank_account = b.id and l.status = 'unmatched') as unmatched
           from deedbox.gl_bank_account b join deedbox.gl_account a on a.id = b.account
          where b.firm = $1 order by b.id`,
        [p.firm],
      )
      return r.rows
    },
    { readOnly: true },
  )
}

// ---- reports: plain SQL over POSTED journal lines --------------------------

export async function glTrialBalance(p: Principal, asOf: string) {
  return withPrincipal(
    p,
    async (tx) => {
      await requireGlRead(tx, p)
      const r = await tx.query(
        `select a.code, a.name, a.account_type,
                coalesce(sum(l.debit), 0) as debit,
                coalesce(sum(l.credit), 0) as credit,
                coalesce(sum(l.debit - l.credit), 0) as balance
           from deedbox.gl_account a
           left join deedbox.gl_journal_line l on l.account = a.id
           left join deedbox.gl_journal j on j.id = l.journal
                and j.status = 'posted' and j.journal_date <= $2::date
          where a.firm = $1
          group by a.id
         having coalesce(sum(l.debit), 0) <> 0 or coalesce(sum(l.credit), 0) <> 0
          order by a.code`,
        [p.firm, asOf],
      )
      return r.rows
    },
    { readOnly: true },
  )
}

export async function glProfitAndLoss(p: Principal, from: string, to: string) {
  return withPrincipal(
    p,
    async (tx) => {
      await requireGlRead(tx, p)
      const r = await tx.query(
        `select a.code, a.name, a.account_type,
                case when a.account_type = 'income'
                     then coalesce(sum(l.credit - l.debit), 0)
                     else coalesce(sum(l.debit - l.credit), 0) end as amount
           from deedbox.gl_account a
           join deedbox.gl_journal_line l on l.account = a.id
           join deedbox.gl_journal j on j.id = l.journal
          where a.firm = $1 and a.account_type in ('income','expense')
            and j.status = 'posted' and j.journal_date between $2::date and $3::date
          group by a.id
          order by a.account_type desc, a.code`,
        [p.firm, from, to],
      )
      return r.rows
    },
    { readOnly: true },
  )
}

export async function glBalanceSheet(p: Principal, asOf: string) {
  return withPrincipal(
    p,
    async (tx) => {
      await requireGlRead(tx, p)
      const r = await tx.query(
        `select a.code, a.name, a.account_type,
                case when a.account_type = 'asset'
                     then coalesce(sum(l.debit - l.credit), 0)
                     else coalesce(sum(l.credit - l.debit), 0) end as balance,
                coalesce(sum(l.debit - l.credit), 0) as signed
           from deedbox.gl_account a
           join deedbox.gl_journal_line l on l.account = a.id
           join deedbox.gl_journal j on j.id = l.journal
          where a.firm = $1 and a.account_type in ('asset','liability','equity')
            and j.status = 'posted' and j.journal_date <= $2::date
          group by a.id
          order by a.account_type, a.code`,
        [p.firm, asOf],
      )
      // current earnings: income less expenses to date fold into equity
      const income = await tx.query(
        `select coalesce(sum(case when a.account_type = 'income' then l.credit - l.debit
                                  else -(l.debit - l.credit) end), 0) as profit
           from deedbox.gl_account a
           join deedbox.gl_journal_line l on l.account = a.id
           join deedbox.gl_journal j on j.id = l.journal
          where a.firm = $1 and a.account_type in ('income','expense')
            and j.status = 'posted' and j.journal_date <= $2::date`,
        [p.firm, asOf],
      )
      return { rows: r.rows, currentEarnings: String(income.rows[0].profit) }
    },
    { readOnly: true },
  )
}

export async function glGeneralLedger(
  p: Principal,
  from: string,
  to: string,
  accountId?: number | null,
) {
  return withPrincipal(
    p,
    async (tx) => {
      await requireGlRead(tx, p)
      const r = await tx.query(
        `select j.journal_no, j.journal_date, j.description as journal_description,
                a.code, a.name as account_name, l.debit, l.credit, l.description
           from deedbox.gl_journal j
           join deedbox.gl_journal_line l on l.journal = j.id
           join deedbox.gl_account a on a.id = l.account
          where j.firm = $1 and j.status = 'posted'
            and j.journal_date between $2::date and $3::date
            and ($4::bigint is null or l.account = $4)
          order by j.journal_date, j.id, l.line_no
          limit 1000`,
        [p.firm, from, to, accountId ?? null],
      )
      return r.rows
    },
    { readOnly: true },
  )
}

export async function glApAgeing(p: Principal, asOf: string) {
  return withPrincipal(
    p,
    async (tx) => {
      await requireGlRead(tx, p)
      const r = await tx.query(
        `select c.name as contact_name, b.bill_number, b.bill_date, b.due_date,
                b.total, b.amount_paid, (b.total - b.amount_paid) as owing,
                greatest(0, ($2::date - coalesce(b.due_date, b.bill_date)))::int as days_overdue
           from deedbox.gl_bill b join deedbox.gl_contact c on c.id = b.contact
          where b.firm = $1 and b.status = 'approved' and b.total > b.amount_paid
          order by days_overdue desc, owing desc`,
        [p.firm, asOf],
      )
      return r.rows
    },
    { readOnly: true },
  )
}

export async function glSettingsPanel(p: Principal) {
  return withPrincipal(
    p,
    async (tx) => {
      await requireGlRead(tx, p)
      const cfg = await glConfigInTx(tx)
      const periods = await tx.query(
        `select * from deedbox.gl_period where firm = $1 order by period_start desc limit 24`,
        [p.firm],
      )
      const rules = await tx.query(
        `select r.*, a.code as account_code from deedbox.gl_bank_rule r
           left join deedbox.gl_account a on a.id = r.account
          where r.firm = $1 order by r.priority, r.id`,
        [p.firm],
      )
      const openingPosted = await tx.query(
        `select journal_no from deedbox.gl_journal
          where firm = $1 and source_type = 'opening_balance' and status <> 'reversed'`,
        [p.firm],
      )
      const accounts = await tx.query(
        `select id, code, name, account_type from deedbox.gl_account
          where firm = $1 and active order by code`,
        [p.firm],
      )
      return {
        config: cfg,
        periods: periods.rows,
        rules: rules.rows,
        openingJournal: (openingPosted.rows[0]?.journal_no as string | undefined) ?? null,
        accounts: accounts.rows,
      }
    },
    { readOnly: true },
  )
}
