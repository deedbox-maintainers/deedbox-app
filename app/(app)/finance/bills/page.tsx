// Supplier bills: the register, a new-bill form, approve/void.

import { requirePrincipal } from '@/lib/auth'
import { glBills, glContacts, glChart } from '@/lib/reads/gl'
import { Page, Panel, Badge, Notices, DataTable, fmtDate } from '@/components/ui'
import { Field, TextInput, Select, SubmitButton } from '@/components/forms'
import { readParams, type SearchParams } from '@/lib/screens/action'
import { createBillAction, approveBillAction, voidBillAction, createContactAction } from '../actions'

const TONE: Record<string, 'green' | 'amber' | 'blue' | 'neutral'> = {
  draft: 'amber',
  approved: 'blue',
  paid: 'green',
  void: 'neutral',
}

export default async function BillsPage({ searchParams }: { searchParams: SearchParams }) {
  const p = await requirePrincipal()
  const sp = await readParams(searchParams)
  const [bills, contacts, chart] = await Promise.all([glBills(p), glContacts(p), glChart(p)])
  const expenseAccounts = (chart.accounts as Record<string, unknown>[]).filter(
    (a) => a.active && (a.account_type === 'expense' || a.account_type === 'asset'),
  )
  return (
    <Page title="Supplier bills" lead="Approve a bill to put the payable on the books; it is paid at the bank reconciliation when the money leaves.">
      <Notices searchParams={sp} />
      <Panel title="Bills">
        <DataTable
          headers={['Contact', 'Number', 'Date', 'Total', 'Paid', 'Status', '']}
          rows={(bills as Record<string, unknown>[]).map((b) => [
            b.contact_name as string,
            (b.bill_number as string | null) ?? `#${b.id}`,
            fmtDate(b.bill_date),
            <span key="t" className="tabular-nums">{Number(b.total).toFixed(2)}</span>,
            <span key="p" className="tabular-nums">{Number(b.amount_paid).toFixed(2)}</span>,
            <Badge key="s" tone={TONE[b.status as string] ?? 'neutral'}>{b.status as string}</Badge>,
            b.status === 'draft' ? (
              <span key="a" className="flex gap-1.5">
                <form action={approveBillAction} className="inline">
                  <input type="hidden" name="id" value={b.id as number} />
                  <SubmitButton tone="quiet">Approve</SubmitButton>
                </form>
                <form action={voidBillAction} className="inline">
                  <input type="hidden" name="id" value={b.id as number} />
                  <SubmitButton tone="quiet">Void</SubmitButton>
                </form>
              </span>
            ) : (
              <span key="a" />
            ),
          ])}
          emptyState="No supplier bills yet."
        />
      </Panel>
      <Panel title="New bill">
        <form action={createBillAction} className="max-w-3xl">
          <div className="flex flex-wrap gap-3">
            <Field label="Contact">
              <Select name="contact" required defaultValue="">
                <option value="" disabled>choose…</option>
                {(contacts as Record<string, unknown>[]).map((c) => (
                  <option key={c.id as number} value={c.id as number}>{c.name as string}</option>
                ))}
              </Select>
            </Field>
            <Field label="Their bill number"><TextInput name="bill_number" /></Field>
            <Field label="Bill date"><TextInput name="bill_date" type="date" required /></Field>
            <Field label="Due date"><TextInput name="due_date" type="date" /></Field>
          </div>
          <table className="mt-1 w-full text-sm">
            <thead>
              <tr className="text-left text-xs text-neutral-500">
                <th className="py-1">Account</th><th>Net</th><th>Tax</th><th>Line note</th>
              </tr>
            </thead>
            <tbody>
              {[0, 1, 2].map((i) => (
                <tr key={i}>
                  <td className="py-1 pr-2">
                    <Select name={`line_${i}_account`} defaultValue="">
                      <option value="">—</option>
                      {expenseAccounts.map((a) => (
                        <option key={a.id as number} value={a.id as number}>
                          {a.code as string} {a.name as string}
                        </option>
                      ))}
                    </Select>
                  </td>
                  <td className="pr-2"><TextInput name={`line_${i}_net`} placeholder="0.00" className="w-28" /></td>
                  <td className="pr-2"><TextInput name={`line_${i}_tax`} placeholder="0.00" className="w-24" /></td>
                  <td><TextInput name={`line_${i}_description`} /></td>
                </tr>
              ))}
            </tbody>
          </table>
          <div className="mt-3"><SubmitButton>Save draft</SubmitButton></div>
        </form>
        <details className="mt-3">
          <summary className="cursor-pointer text-xs text-neutral-500">Add a contact</summary>
          <form action={createContactAction} className="mt-2 flex flex-wrap items-end gap-2">
            <Field label="Name"><TextInput name="name" required /></Field>
            <Field label="Email"><TextInput name="email" /></Field>
            <SubmitButton tone="quiet">Add</SubmitButton>
          </form>
        </details>
      </Panel>
    </Page>
  )
}
