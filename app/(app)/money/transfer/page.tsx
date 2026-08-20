// Transfers: same-account and cross-account, both under a transfer
// intent authorised by someone OTHER than the executor, reason always
// recorded, both sides previewed by the ledger numbers entered.

import { requirePrincipal } from '@/lib/auth'
import { moneyViewerFlags } from '@/lib/reads/money'
import { Page, Panel, Notices } from '@/components/ui'
import { Field, TextInput, SubmitButton } from '@/components/forms'
import { readParams, type SearchParams } from '@/lib/screens/action'
import { authoriseIntentAction, ledgerTransferAction, crossAccountTransferAction } from '../actions'

export default async function TransferPage({ searchParams }: { searchParams: SearchParams }) {
  const p = await requirePrincipal()
  const sp = await readParams(searchParams)
  await moneyViewerFlags(p) // capability presence checked by the operations themselves

  return (
    <Page
      title="Transfer between ledgers"
      lead="Two people, two steps: one authorises the exact intent (from, to, amount, reason); a different person executes it quoting the authorisation number. Same-account transfers post two lines net zero; cross-account transfers pair a payment and a receipt in one act."
    >
      <Notices searchParams={sp} />
      <div className="grid grid-cols-1 gap-x-6 lg:grid-cols-3">
        <Panel title="1 · Authorise the intent">
          <form action={authoriseIntentAction}>
            <div className="grid grid-cols-2 gap-3">
              <Field label="From ledger #">
                <TextInput name="from_ledger" required inputMode="numeric" />
              </Field>
              <Field label="To ledger #">
                <TextInput name="to_ledger" required inputMode="numeric" />
              </Field>
            </div>
            <Field label="Amount">
              <TextInput name="amount" required inputMode="decimal" />
            </Field>
            <Field label="Reason">
              <TextInput name="reason" required />
            </Field>
            <SubmitButton>Authorise intent</SubmitButton>
          </form>
        </Panel>
        <Panel title="2a · Execute (same account)">
          <form action={ledgerTransferAction}>
            <div className="grid grid-cols-2 gap-3">
              <Field label="From ledger #">
                <TextInput name="from_ledger" required inputMode="numeric" />
              </Field>
              <Field label="To ledger #">
                <TextInput name="to_ledger" required inputMode="numeric" />
              </Field>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <Field label="Amount">
                <TextInput name="amount" required inputMode="decimal" />
              </Field>
              <Field label="Authorisation #">
                <TextInput name="authorisation" required inputMode="numeric" />
              </Field>
            </div>
            <Field label="Reason (must match the intent)">
              <TextInput name="reason" required />
            </Field>
            <SubmitButton tone="danger">Execute transfer</SubmitButton>
          </form>
        </Panel>
        <Panel title="2b · Execute (across accounts)">
          <form action={crossAccountTransferAction}>
            <div className="grid grid-cols-2 gap-3">
              <Field label="From ledger #">
                <TextInput name="from_ledger" required inputMode="numeric" />
              </Field>
              <Field label="To ledger #">
                <TextInput name="to_ledger" required inputMode="numeric" />
              </Field>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <Field label="Amount">
                <TextInput name="amount" required inputMode="decimal" />
              </Field>
              <Field label="Authorisation #">
                <TextInput name="authorisation" required inputMode="numeric" />
              </Field>
            </div>
            <Field label="Reason (must match the intent)">
              <TextInput name="reason" required />
            </Field>
            <SubmitButton tone="danger">Execute cross-account</SubmitButton>
          </form>
        </Panel>
      </div>
    </Page>
  )
}
