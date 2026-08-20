// Close screen: the live position computed fresh from the journals,
// each condition with its warn/block badge from the setting in force,
// dormancy warnings, reason capture, and submit-or-close per the approval
// setting. The closing transaction re-verifies everything under lock.

import { requirePrincipal } from '@/lib/auth'
import { closeScreen } from '@/lib/reads/matters'
import { Page, Panel, Notices, Badge, DetailList, RowLink } from '@/components/ui'
import { Field, TextInput, SubmitButton, InlineAction } from '@/components/forms'
import { readParams, type SearchParams } from '@/lib/screens/action'
import { closeMatterAction, withdrawCloseAction } from '../../actions'

function ConditionRow({
  label,
  present,
  behaviour,
  amount,
}: {
  label: string
  present: boolean
  behaviour: string
  amount?: number
}) {
  return (
    <div className="flex items-center justify-between border-b border-neutral-100 py-2 text-sm">
      <span className="text-neutral-800">
        {label}
        {amount !== undefined && present ? (
          <span className="ml-2 tabular-nums text-neutral-500">{amount.toFixed(2)}</span>
        ) : null}
      </span>
      <span className="flex items-center gap-2">
        {present ? <Badge tone="amber">present</Badge> : <Badge tone="green">clear</Badge>}
        <Badge tone={behaviour === 'block' ? 'red' : 'neutral'}>
          {behaviour === 'block' ? 'blocks close' : 'warns only'}
        </Badge>
      </span>
    </div>
  )
}

export default async function CloseMatterPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>
  searchParams: SearchParams
}) {
  const p = await requirePrincipal()
  const { id } = await params
  const sp = await readParams(searchParams)
  const data = await closeScreen(p, Number(id))
  const m = data.matter
  const pos = data.position

  return (
    <Page
      title={`Close ${m.matterNumber}`}
      lead={
        <span>
          {m.title} — <RowLink href={`/matters/${m.id}`}>back to the matter</RowLink>. These figures
          are computed fresh from the books this moment; the close itself re-checks them under lock
          so nothing can slip in between.
        </span>
      }
    >
      <Notices searchParams={sp} />

      {data.pendingRequest ? (
        <Panel title="A close request is already pending">
          <p className="mb-3 text-sm text-neutral-600">
            Request #{data.pendingRequest.id} by {data.pendingRequest.requesterName} awaits a
            decision in <RowLink href="/matters/approvals">the approval queue</RowLink>.
          </p>
          {data.pendingRequest.requestedBy === p.id ? (
            <InlineAction
              action={withdrawCloseAction}
              fields={{ matter: m.id, request: data.pendingRequest.id }}
              label="Withdraw my request"
            />
          ) : null}
        </Panel>
      ) : null}

      <Panel title="Position right now">
        <DetailList
          items={[
            ['Unbilled work', pos.unbilled.toFixed(2)],
            ['Outstanding bills', pos.outstanding.toFixed(2)],
            [
              'Client money held',
              `${pos.heldGross.toFixed(2)} gross · ${pos.heldEarmarked.toFixed(2)} set aside · ${pos.heldAvailable.toFixed(2)} available`,
            ],
            [
              'Ledgers',
              pos.ledgers.length === 0
                ? 'None'
                : pos.ledgers.map((l) => `#${l.id}: ${l.balance.toFixed(2)}`).join(' · '),
            ],
          ]}
        />
        {pos.dormantWarnings.length > 0 ? (
          <p className="mt-3 rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-800">
            {pos.dormantWarnings.length} dormant-money case(s) are open on this matter’s ledgers.
            They never stop the matter closing — the money side resolves them on its own track —
            and they are recorded with the close.
          </p>
        ) : null}
      </Panel>

      <Panel title="Close conditions (firm settings)">
        <ConditionRow
          label="Unbilled work remains"
          present={data.evaluation.unbilled.present}
          behaviour={data.evaluation.unbilled.behaviour}
          amount={pos.unbilled}
        />
        <ConditionRow
          label="Bills remain outstanding"
          present={data.evaluation.outstanding.present}
          behaviour={data.evaluation.outstanding.behaviour}
          amount={pos.outstanding}
        />
        <ConditionRow
          label="Client money still held"
          present={data.evaluation.heldFunds.present}
          behaviour={data.evaluation.heldFunds.behaviour}
          amount={pos.heldGross}
        />
        <p className="mt-2 text-xs text-neutral-400">
          Held client money always stops the close itself, whatever the setting — money must reach
          zero first. Warn-level conditions are recorded with the close, not enforced.
        </p>
      </Panel>

      <Panel title={data.requiresApproval ? 'Submit for approval' : 'Close now'}>
        {data.refusals.length > 0 ? (
          <div className="mb-3 rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-800">
            <p className="mb-1 font-medium">As things stand, the close would refuse:</p>
            <ul className="list-inside list-disc">
              {data.refusals.map((r, i) => (
                <li key={i}>{r}</li>
              ))}
            </ul>
          </div>
        ) : null}
        <p className="mb-3 text-sm text-neutral-500">
          {data.requiresApproval
            ? 'This firm requires a second person: your request records the position, and a different matter.close holder decides it.'
            : 'The close happens in one act: the position is re-computed, the money guard holds the ledgers, and the register records it all.'}
        </p>
        <form action={closeMatterAction} className="max-w-md">
          <input type="hidden" name="matter" value={m.id} />
          <Field label="Note" hint="Optional — kept on the close record">
            <TextInput name="note" />
          </Field>
          <SubmitButton tone="danger">
            {data.requiresApproval ? 'Submit close request' : 'Close the matter'}
          </SubmitButton>
        </form>
      </Panel>
    </Page>
  )
}
