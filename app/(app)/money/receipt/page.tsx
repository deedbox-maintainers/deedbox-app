// Receipt entry: the default account pre-selected from the setting,
// method-driven identifier fields, and the instrument number where the
// method demands one. Save allocates the gapless receipt number and stores
// the printable form in the same act.

import { requirePrincipal } from '@/lib/auth'
import { receiptFormData } from '@/lib/reads/money'
import { Page, Panel, Notices } from '@/components/ui'
import { Field, TextInput, Select, SubmitButton } from '@/components/forms'
import { readParams, type SearchParams } from '@/lib/screens/action'
import MatterPicker from '@/components/matter-picker'
import PartyPicker from '@/components/party-picker'
import { recordReceiptAction } from '../actions'

export default async function ReceiptPage({ searchParams }: { searchParams: SearchParams }) {
  const p = await requirePrincipal()
  const sp = await readParams(searchParams)
  const f = await receiptFormData(p)

  return (
    <Page
      title="Record a client-money receipt"
      lead="Money received into a client account. The ledger opens itself on first money; the receipt number is gapless and the printable form stores with the save."
    >
      <Notices searchParams={sp} />
      <Panel>
        <form action={recordReceiptAction} className="max-w-lg">
          <div className="grid grid-cols-2 gap-3">
            <MatterPicker
              name="matter"
              label="Matter"
              hint="Type the client's name or the matter number, then pick"
            />
            <Field label="Account">
              <Select name="account" defaultValue={f.defaultAccount ?? undefined}>
                {f.accounts.map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.name}
                  </option>
                ))}
              </Select>
            </Field>
          </div>
          <div className="grid grid-cols-3 gap-3">
            <Field label="Amount">
              <TextInput name="amount" required inputMode="decimal" />
            </Field>
            <Field label="Method">
              <Select name="method">
                {f.methods.map((m) => (
                  <option key={m.key} value={m.key}>
                    {m.key.replace(/_/g, ' ')}
                    {m.instrument_backed ? ' (instrument)' : ''}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="Received" hint="Defaults to today">
              <TextInput name="received_date" type="date" />
            </Field>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <PartyPicker
              name="payer_party"
              label="Payer"
              hint="Type the payer's name and pick — or describe below"
            />
            <Field label="Payer description">
              <TextInput name="payer_description" />
            </Field>
          </div>
          <Field label="Instrument number" hint="Required for instrument-backed methods (e.g. cheque)">
            <TextInput name="instrument_number" />
          </Field>
          <SubmitButton>Record receipt</SubmitButton>
        </form>
      </Panel>
    </Page>
  )
}
