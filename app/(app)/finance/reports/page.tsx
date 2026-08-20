// Financial reports: trial balance, profit and loss, balance
// sheet, general ledger, payables ageing — plain SQL over posted lines,
// date-ranged from the query string.

import { requirePrincipal } from '@/lib/auth'
import {
  glTrialBalance,
  glProfitAndLoss,
  glBalanceSheet,
  glGeneralLedger,
  glApAgeing,
} from '@/lib/reads/gl'
import { Page, Panel, Notices, DataTable, EmptyState, fmtDate } from '@/components/ui'
import { Field, TextInput, Select, SubmitButton } from '@/components/forms'
import { readParams, type SearchParams } from '@/lib/screens/action'

const REPORTS = [
  ['trial', 'Trial balance'],
  ['pl', 'Profit and loss'],
  ['bs', 'Balance sheet'],
  ['ledger', 'General ledger'],
  ['ap', 'Payables ageing'],
] as const

export default async function ReportsPage({ searchParams }: { searchParams: SearchParams }) {
  const p = await requirePrincipal()
  const sp = await readParams(searchParams)
  const today = new Date().toISOString().slice(0, 10)
  const kind = sp.report ?? 'trial'
  const from = sp.from ?? `${today.slice(0, 4)}-01-01`
  const to = sp.to ?? today

  let table: { headers: string[]; rows: (string | number)[][] } | null = null
  let footer: string | null = null
  if (kind === 'trial') {
    const rows = (await glTrialBalance(p, to)) as Record<string, unknown>[]
    const d = rows.reduce((s, r) => s + Number(r.debit), 0)
    const c = rows.reduce((s, r) => s + Number(r.credit), 0)
    table = {
      headers: ['Code', 'Account', 'Type', 'Debits', 'Credits', 'Balance'],
      rows: rows.map((r) => [
        r.code as string, r.name as string, r.account_type as string,
        Number(r.debit).toFixed(2), Number(r.credit).toFixed(2), Number(r.balance).toFixed(2),
      ]),
    }
    footer = `Totals: debits ${d.toFixed(2)} · credits ${c.toFixed(2)} · net ${(d - c).toFixed(2)}`
  } else if (kind === 'pl') {
    const rows = (await glProfitAndLoss(p, from, to)) as Record<string, unknown>[]
    const income = rows.filter((r) => r.account_type === 'income').reduce((s, r) => s + Number(r.amount), 0)
    const expense = rows.filter((r) => r.account_type === 'expense').reduce((s, r) => s + Number(r.amount), 0)
    table = {
      headers: ['Code', 'Account', 'Type', 'Amount'],
      rows: rows.map((r) => [
        r.code as string, r.name as string, r.account_type as string, Number(r.amount).toFixed(2),
      ]),
    }
    footer = `Income ${income.toFixed(2)} − expenses ${expense.toFixed(2)} = profit ${(income - expense).toFixed(2)}`
  } else if (kind === 'bs') {
    const { rows, currentEarnings } = await glBalanceSheet(p, to)
    table = {
      headers: ['Code', 'Account', 'Type', 'Balance'],
      rows: (rows as Record<string, unknown>[]).map((r) => [
        r.code as string, r.name as string, r.account_type as string, Number(r.balance).toFixed(2),
      ]),
    }
    footer = `Current earnings folded into equity: ${Number(currentEarnings).toFixed(2)}`
  } else if (kind === 'ledger') {
    const rows = (await glGeneralLedger(p, from, to)) as Record<string, unknown>[]
    table = {
      headers: ['Journal', 'Date', 'Account', 'Debit', 'Credit', 'Note'],
      rows: rows.map((r) => [
        r.journal_no as string, fmtDate(r.journal_date),
        `${r.code as string} ${r.account_name as string}`,
        Number(r.debit) ? Number(r.debit).toFixed(2) : '',
        Number(r.credit) ? Number(r.credit).toFixed(2) : '',
        (r.description as string | null) ?? (r.journal_description as string),
      ]),
    }
  } else if (kind === 'ap') {
    const rows = (await glApAgeing(p, to)) as Record<string, unknown>[]
    table = {
      headers: ['Contact', 'Bill', 'Due', 'Owing', 'Days overdue'],
      rows: rows.map((r) => [
        r.contact_name as string,
        (r.bill_number as string | null) ?? '—',
        fmtDate(r.due_date),
        Number(r.owing).toFixed(2),
        r.days_overdue as number,
      ]),
    }
  }

  return (
    <Page title="Financial reports" lead="Figures come straight from posted journals — what the ledger says is what the report says.">
      <Notices searchParams={sp} />
      <Panel>
        <form method="get" className="flex flex-wrap items-end gap-2">
          <Field label="Report">
            <Select name="report" defaultValue={kind}>
              {REPORTS.map(([k, label]) => (
                <option key={k} value={k}>{label}</option>
              ))}
            </Select>
          </Field>
          <Field label="From"><TextInput name="from" type="date" defaultValue={from} /></Field>
          <Field label="To / as at"><TextInput name="to" type="date" defaultValue={to} /></Field>
          <SubmitButton tone="quiet">Run</SubmitButton>
        </form>
      </Panel>
      {table ? (
        <Panel title={REPORTS.find(([k]) => k === kind)?.[1]}>
          {table.rows.length === 0 ? (
            <EmptyState>Nothing in the range.</EmptyState>
          ) : (
            <DataTable headers={table.headers} rows={table.rows} />
          )}
          {footer ? <p className="mt-2 text-sm font-medium text-neutral-700">{footer}</p> : null}
        </Panel>
      ) : null}
    </Page>
  )
}
