// The payment-details capture screen: versioned firm bank details, the
// payee exactly as typed (never assembled), pack-declared identifier
// fields, optional second-person approval with the prior version governing
// meanwhile, and the live preview of what clients will see.

import { requirePrincipal } from '@/lib/auth'
import { paymentDetailsScreen } from '@/lib/reads/billing'
import { Page, Panel, DataTable, DetailList, Notices, Badge, fmtDateTime } from '@/components/ui'
import { Field, TextInput, SubmitButton, InlineAction } from '@/components/forms'
import { readParams, type SearchParams } from '@/lib/screens/action'
import { savePaymentDetailsAction, approvePaymentDetailsAction } from '../actions'

export default async function PaymentDetailsPage({ searchParams }: { searchParams: SearchParams }) {
  const p = await requirePrincipal()
  const sp = await readParams(searchParams)
  const d = await paymentDetailsScreen(p)
  // pack-silent installations get the catalogue's own neutral default —
  // an account label and an account number, both required (0002)
  const fields = d.identifierSchema?.fields ?? [
    { key: 'account_label', label: 'Account label' },
    { key: 'account_number', label: 'Account number' },
  ]

  return (
    <Page
      title="Payment details on bills"
      lead="The bank account clients are told to pay bills into. Versioned and audited: every bill despatch renders the details governing AT THAT MOMENT, and issued documents' own content never changes."
    >
      <Notices searchParams={sp} />

      <p className="mb-4 rounded-md border border-sky-200 bg-sky-50 px-3 py-2 text-sm text-sky-900">
        <strong>Which account?</strong> These are the firm's WORKING account details for bills.
        Client money (trust) has its own accounts and its own rules — never enter a client-money
        account here.
      </p>

      <div className="grid grid-cols-1 gap-x-6 lg:grid-cols-2">
        <div>
          <Panel title="Governing now">
            {d.governing ? (
              <DetailList
                items={[
                  ['Payee (exactly as it renders)', String(d.governing.account_holder_name)],
                  ['Bank', String(d.governing.bank_name)],
                  ...Object.entries(d.governing.identifier_values as Record<string, string>).map(
                    ([k, v]) => [k.replace(/_/g, ' '), v] as [string, string],
                  ),
                  ['Version', String(d.governing.version_no)],
                  ['Approved', fmtDateTime(d.governing.approved_at)],
                ]}
              />
            ) : (
              <p className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-800">
                <strong>Incomplete:</strong> no governing details exist — bills render WITHOUT a
                payment block until this is finished. Clients cannot be asked to guess.
              </p>
            )}
          </Panel>

          {d.pending ? (
            <Panel title="Pending approval">
              <DetailList
                items={[
                  ['Payee', String(d.pending.account_holder_name)],
                  ['Bank', String(d.pending.bank_name)],
                  ['Entered by', String((d.pending.created_by_name as { family?: string })?.family ?? '')],
                  ['Entered', fmtDateTime(d.pending.created_at)],
                ]}
              />
              <p className="mb-2 text-sm text-neutral-500">
                A different authorised person must approve; the prior version keeps governing until
                then.
              </p>
              <InlineAction
                action={approvePaymentDetailsAction}
                fields={{ version: d.pending.id as number }}
                label="Approve — takes over every future despatch"
                tone="primary"
              />
            </Panel>
          ) : null}

          <Panel title="History">
            <DataTable
              headers={['Version', 'Payee', 'State', 'Entered', 'Approved']}
              rows={d.versions.map((v) => [
                String(v.version_no),
                String(v.account_holder_name),
                v.superseded_at ? (
                  <Badge key="s">superseded</Badge>
                ) : v.state === 'approved' ? (
                  <Badge key="s" tone="green">governing</Badge>
                ) : (
                  <Badge key="s" tone="amber">pending</Badge>
                ),
                fmtDateTime(v.created_at),
                v.approved_at ? fmtDateTime(v.approved_at) : '—',
              ])}
              emptyState="No versions yet."
            />
          </Panel>
        </div>

        <Panel title="Enter new details">
          <form action={savePaymentDetailsAction} className="max-w-md">
            <Field
              label="Account holder name — the payee, EXACTLY as it should render"
              hint="The product never assembles a payee name for you"
            >
              <TextInput name="account_holder_name" required />
            </Field>
            <Field label="Bank name">
              <TextInput name="bank_name" required />
            </Field>
            {fields.map((f) => (
              <Field key={f.key} label={f.label ?? f.key.replace(/_/g, ' ')}>
                <input type="hidden" name="id_key" value={f.key} />
                <TextInput name="id_value" required />
              </Field>
            ))}
            <p className="mb-2 text-xs text-neutral-400">
              {d.requireApproval
                ? 'Second-person approval is ON: this saves as pending and a different authorised person approves it.'
                : 'Second-person approval is OFF (setting billing.payment_details_require_approval): this governs immediately.'}
            </p>
            <SubmitButton>Save details</SubmitButton>
          </form>
        </Panel>
      </div>
    </Page>
  )
}
