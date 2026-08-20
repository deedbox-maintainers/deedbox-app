// Receipt history: every recorded receipt, searchable by payer, receipt
// number, matter (current or prior number) or title words, within a date
// range. Born from the first real installation's second support email —
// receipts could be recorded but nowhere listed or found. The recording
// form stays at /money/receipt; this is the finding side.

import Link from 'next/link'
import { requirePrincipal } from '@/lib/auth'
import { receiptHistory } from '@/lib/reads/money'
import { Page, Panel, DataTable, Notices, RowLink } from '@/components/ui'
import { Field, TextInput, SubmitButton } from '@/components/forms'
import { readParams, type SearchParams } from '@/lib/screens/action'
import MatterPicker from '@/components/matter-picker'
import { emailReceiptAction } from '../actions'

export default async function ReceiptHistoryPage({ searchParams }: { searchParams: SearchParams }) {
  const p = await requirePrincipal()
  const sp = await readParams(searchParams)
  const rows = await receiptHistory(p, {
    q: sp.q || undefined,
    from: sp.from || undefined,
    to: sp.to || undefined,
  })

  return (
    <Page
      title="Client-money receipts"
      lead="Every recorded receipt. Search by payer, receipt number, matter number (new or old) or words from the matter; narrow by date."
    >
      <Notices searchParams={sp} />
      <Panel>
        <form method="get" className="flex flex-wrap items-end gap-2">
          <div className="w-72">
            <MatterPicker
              name="q"
              mode="text"
              label="Search"
              placeholder="payer, R-number, matter…"
              initialText={sp.q ?? ''}
            />
          </div>
          <Field label="From">
            <TextInput name="from" type="date" defaultValue={sp.from ?? ''} />
          </Field>
          <Field label="To">
            <TextInput name="to" type="date" defaultValue={sp.to ?? ''} />
          </Field>
          <SubmitButton>Search</SubmitButton>
          <Link href="/money/receipt" className="ml-auto text-sm underline">
            Record a receipt
          </Link>
        </form>
      </Panel>
      <Panel title={`Receipts (${rows.length}${rows.length === 100 ? '+' : ''})`}>
        <DataTable
          headers={['Receipt', 'Date', 'Payer', 'Amount', 'Method', 'Matter', '', '']}
          rows={rows.map((r) => [
            r.receiptNumber,
            r.receivedDate,
            r.payer,
            <span key="a" className="tabular-nums">{r.amount.toFixed(2)}</span>,
            r.method.replace(/_/g, ' '),
            `${r.matterNumber} — ${r.matterTitle}`,
            <RowLink key="m" href={`/matters/${r.matter}/money`}>Open</RowLink>,
            <details key="e">
              <summary className="cursor-pointer text-sm text-sky-700">Email…</summary>
              <form action={emailReceiptAction} className="mt-2 w-64 space-y-1">
                <input type="hidden" name="receipt" value={r.id} />
                <TextInput name="recipients" required defaultValue={r.clientEmail ?? ''} placeholder="client@example.com" />
                <label className="flex items-center gap-1 text-xs text-neutral-600">
                  <input type="checkbox" name="confirmed" className="h-3.5 w-3.5" /> I have checked the recipient
                </label>
                <SubmitButton tone="quiet">Send receipt PDF</SubmitButton>
              </form>
            </details>,
          ])}
          emptyState="No receipts match — widen the search or the dates."
        />
      </Panel>
    </Page>
  )
}
