// Chart of accounts + tax codes. Purposes shown; balances
// from posted lines.

import { requirePrincipal } from '@/lib/auth'
import { glChart } from '@/lib/reads/gl'
import { Page, Panel, Badge, Notices, DataTable } from '@/components/ui'
import { Field, TextInput, Select, SubmitButton } from '@/components/forms'
import { readParams, type SearchParams } from '@/lib/screens/action'
import { createAccountAction, createTaxCodeAction } from '../actions'

export default async function AccountsPage({ searchParams }: { searchParams: SearchParams }) {
  const p = await requirePrincipal()
  const sp = await readParams(searchParams)
  const { accounts, taxCodes } = await glChart(p)
  return (
    <Page title="Chart of accounts" lead="Codes and names are yours to change; the tagged purposes keep postings working wherever the numbers move.">
      <Notices searchParams={sp} />
      <Panel title="Accounts">
        <DataTable
          headers={['Code', 'Name', 'Type', 'Purpose', 'Balance', 'Active']}
          rows={(accounts as Record<string, unknown>[]).map((a) => [
            <span key="c" className="font-mono text-xs">{a.code as string}</span>,
            a.name as string,
            a.account_type as string,
            a.system_purpose ? <Badge key="p" tone="violet">{a.system_purpose as string}</Badge> : '—',
            <span key="b" className="tabular-nums">{Number(a.balance).toFixed(2)}</span>,
            a.active ? 'yes' : 'no',
          ])}
          emptyState="No accounts — switch the module on under Settings."
        />
        <form action={createAccountAction} className="mt-3 flex flex-wrap items-end gap-2">
          <Field label="Code"><TextInput name="code" required className="w-24" /></Field>
          <Field label="Name"><TextInput name="name" required className="w-64" /></Field>
          <Field label="Type">
            <Select name="account_type" defaultValue="expense">
              {['asset','liability','equity','income','expense'].map((t) => (
                <option key={t} value={t}>{t}</option>
              ))}
            </Select>
          </Field>
          <SubmitButton tone="quiet">Add account</SubmitButton>
        </form>
      </Panel>
      <Panel title="Tax codes">
        <DataTable
          headers={['Code', 'Name', 'Rate']}
          rows={(taxCodes as Record<string, unknown>[]).map((t) => [
            t.code as string,
            t.name as string,
            `${(Number(t.rate) * 100).toFixed(2)}%`,
          ])}
          emptyState="No tax codes yet."
        />
        <form action={createTaxCodeAction} className="mt-3 flex flex-wrap items-end gap-2">
          <Field label="Code"><TextInput name="code" required className="w-28" /></Field>
          <Field label="Name"><TextInput name="name" required className="w-56" /></Field>
          <Field label="Rate %"><TextInput name="rate_percent" required className="w-20" /></Field>
          <SubmitButton tone="quiet">Add tax code</SubmitButton>
        </form>
      </Panel>
    </Page>
  )
}
