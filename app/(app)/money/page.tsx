// Accounts overview: every client account with its book total, ledger
// count, last certified reconciliation and next close due. The money reports
// are the reporting catalogue's — linked, not duplicated.

import Link from 'next/link'
import { requirePrincipal } from '@/lib/auth'
import { accountsOverview } from '@/lib/reads/money'
import { Page, Panel, DataTable, Notices, RowLink, Badge, fmtDate } from '@/components/ui'
import { Field, TextInput, Select, SubmitButton } from '@/components/forms'
import { readParams, type SearchParams } from '@/lib/screens/action'
import { createAccountAction, deactivateAccountAction } from './actions'

export default async function MoneyOverviewPage({ searchParams }: { searchParams: SearchParams }) {
  const p = await requirePrincipal()
  const sp = await readParams(searchParams)
  const accounts = await accountsOverview(p)

  return (
    <Page
      title="Client money"
      lead="The firm's client-money accounts. Every figure is the books' own — balances derive from the journal and can never be edited, only moved by recorded transactions."
    >
      <Notices searchParams={sp} />
      <Panel title="Accounts">
        <DataTable
          headers={['Account', 'Kind', 'Book total', 'Ledgers', 'Last certified recon', 'Next close due', '']}
          rows={accounts.map((a) => [
            <span key="n">
              {String(a.name)} {!a.active ? <Badge tone="neutral">deactivated</Badge> : null}
            </span>,
            String(a.account_kind).replace(/_/g, ' '),
            <span key="t" className="tabular-nums">{Number(a.book_total).toFixed(2)}</span>,
            String(a.ledgers),
            a.last_certified ? fmtDate(a.last_certified) : <Badge tone="amber">never</Badge>,
            a.next_close_due ? fmtDate(a.next_close_due) : '—',
            <span key="acts" className="flex gap-2">
              <RowLink href={`/money/recon/${a.id}`}>Reconcile</RowLink>
            </span>,
          ])}
          emptyState="No client-money accounts yet — create the firm's first designated account."
        />
      </Panel>

      <div className="grid grid-cols-1 gap-x-6 lg:grid-cols-2">
        <Panel title="New account">
          <form action={createAccountAction} className="max-w-sm">
            <Field label="Name">
              <TextInput name="name" required />
            </Field>
            <Field label="Kind">
              <Select name="account_kind" defaultValue="pooled">
                <option value="pooled">Pooled (many matters, one bank account)</option>
                <option value="separate_per_matter">Separate — one matter</option>
                <option value="statutory_set_aside">Statutory set-aside</option>
              </Select>
            </Field>
            <Field label="Linked matter #" hint="Separate accounts only">
              <TextInput name="linked_matter" inputMode="numeric" />
            </Field>
            <SubmitButton>Create account</SubmitButton>
          </form>
        </Panel>
        <Panel title="Deactivate an account">
          <p className="mb-2 text-sm text-neutral-500">
            Refused unless the book is at zero, every ledger closed, and a final-position
            reconciliation certified — the schema holds that line.
          </p>
          <form action={deactivateAccountAction} className="flex max-w-sm items-end gap-2">
            <div className="w-28">
              <Field label="Account #">
                <TextInput name="account" required inputMode="numeric" />
              </Field>
            </div>
            <div className="grow">
              <Field label="Reason">
                <TextInput name="reason" required />
              </Field>
            </div>
            <div className="pb-3">
              <SubmitButton tone="danger">Deactivate</SubmitButton>
            </div>
          </form>
        </Panel>
      </div>

      <Panel title="Working screens">
        <div className="flex flex-wrap gap-3 text-sm">
          {[
            ['/money/receipt', 'Record a receipt'],
            ['/money/payments', 'Payments & authorisations'],
            ['/money/transfer', 'Transfers'],
            ['/money/close', 'Period closes'],
            ['/money/instruments', 'Instruments'],
            ['/money/refusals', 'Refusal register'],
            ['/money/incidents', 'Deficiency incidents'],
            ['/money/receipts', 'Receipts'],
            ['/money/dormant', 'Dormant balances'],
            ['/money/registers', 'Statutory registers'],
            ['/money/statements', 'Client statements'],
          ].map(([href, label]) => (
            <Link
              key={href}
              href={href}
              className="rounded-md border border-neutral-300 bg-white px-3 py-1.5 text-neutral-700 hover:bg-neutral-50"
            >
              {label}
            </Link>
          ))}
        </div>
        <p className="mt-3 text-xs text-neutral-400">
          Timeliness, ageing and exception REPORTS live in the reporting catalogue (Reports →
          client-money keys) — the same definitions feed the tiles, so a figure and its list can
          never disagree.
        </p>
      </Panel>
    </Page>
  )
}
