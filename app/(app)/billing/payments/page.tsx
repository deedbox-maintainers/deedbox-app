// Payment entry & the allocation workbench: record a receipt, allocate
// it across the payer's open bills (auto-fill oldest-first is the firm
// setting; every figure here is editable before commit), and the
// unallocated-receipts tab with the nightly routing outcome visible.

import { requirePrincipal } from '@/lib/auth'
import { paymentWorkbench } from '@/lib/reads/billing'
import { Page, Panel, DataTable, Notices, RowLink, fmtDate } from '@/components/ui'
import { Field, TextInput, Select, SubmitButton } from '@/components/forms'
import { readParams, type SearchParams } from '@/lib/screens/action'
import { recordPaymentAction, allocatePaymentAction, correctPaymentAction } from '../actions'

export default async function PaymentsPage({ searchParams }: { searchParams: SearchParams }) {
  const p = await requirePrincipal()
  const sp = await readParams(searchParams)
  const payer = sp.payer ? Number(sp.payer) : undefined
  const w = await paymentWorkbench(p, { payer })

  return (
    <Page
      title="Payments"
      lead={`Record money received against bills and allocate it. Auto-fill order per the firm setting: ${w.allocationOrder.replace('_', ' ')}.`}
    >
      <Notices searchParams={sp} />

      <div className="grid grid-cols-1 gap-x-6 lg:grid-cols-2">
        <Panel title="Record a payment">
          <form method="get" className="mb-3 flex items-end gap-2">
            <div className="w-32">
              <Field label="Payer (party #)" hint="Loads their open bills">
                <TextInput name="payer" defaultValue={sp.payer ?? ''} inputMode="numeric" />
              </Field>
            </div>
            <div className="pb-3">
              <SubmitButton tone="quiet">Load bills</SubmitButton>
            </div>
          </form>
          <form action={recordPaymentAction}>
            {payer ? <input type="hidden" name="payer_party" value={payer} /> : null}
            <div className="grid grid-cols-3 gap-3">
              <Field label="Received">
                <TextInput name="received_date" type="date" required />
              </Field>
              <Field label="Amount">
                <TextInput name="amount" required inputMode="decimal" />
              </Field>
              <Field label="Method">
                <Select name="method" defaultValue="electronic_transfer">
                  <option value="electronic_transfer">Transfer</option>
                  <option value="card">Card</option>
                  <option value="cheque">Cheque</option>
                  <option value="cash">Cash</option>
                </Select>
              </Field>
            </div>
            <Field label="Reference" hint="Optional">
              <TextInput name="reference" />
            </Field>
            {w.openBills.length > 0 ? (
              <>
                <p className="mb-1 text-sm font-medium text-neutral-700">Allocate in the same act</p>
                <DataTable
                  headers={['Bill', 'Due', 'Outstanding', 'Allocate']}
                  rows={w.openBills.map((b) => [
                    <span key="b">
                      {String(b.bill_number)} <span className="text-neutral-400">({String(b.matter_number)})</span>
                      <input type="hidden" name="alloc_bill" value={b.id as number} />
                    </span>,
                    fmtDate(b.due_date),
                    Number(b.outstanding).toFixed(2),
                    <TextInput key="a" name="alloc_amount" inputMode="decimal" className="!w-24" />,
                  ])}
                />
              </>
            ) : payer ? (
              <p className="mb-3 text-sm text-neutral-500">No open bills for this payer — the receipt records unallocated.</p>
            ) : null}
            <div className="mt-3">
              <SubmitButton>Record payment</SubmitButton>
            </div>
          </form>
        </Panel>

        <Panel title="Unallocated receipts">
          <p className="mb-2 text-xs text-neutral-400">
            Fully-unallocated remainders may route to the client's trust ledger by the nightly rule
            where the firm's pack directs it; partial remainders always wait for a person.
          </p>
          <DataTable
            headers={['Receipt', 'Payer', 'Received', 'Amount', 'Unallocated', 'Allocate / correct']}
            rows={w.unallocated.map((r) => [
              String(r.receipt_number),
              r.payer_name ? String(r.payer_name) : <RowLink key="p" href={`/parties/${r.payer_party}`}>#{String(r.payer_party)}</RowLink>,
              fmtDate(r.received_date),
              Number(r.amount).toFixed(2),
              Number(r.remainder).toFixed(2),
              <div key="acts" className="space-y-1">
                <form action={allocatePaymentAction} className="flex items-center gap-1">
                  <input type="hidden" name="payment" value={r.id as number} />
                  <TextInput name="alloc_bill" placeholder="Bill #" inputMode="numeric" className="!w-20" />
                  <TextInput name="alloc_amount" placeholder="Amount" inputMode="decimal" className="!w-24" />
                  <SubmitButton tone="quiet">Allocate</SubmitButton>
                </form>
                <form action={correctPaymentAction} className="flex items-center gap-1">
                  <input type="hidden" name="payment" value={r.id as number} />
                  <TextInput name="reason" placeholder="Correct — reason" className="!w-44" />
                  <SubmitButton tone="quiet">Correct</SubmitButton>
                </form>
              </div>,
            ])}
            emptyState="No unallocated receipts."
          />
        </Panel>
      </div>
    </Page>
  )
}
