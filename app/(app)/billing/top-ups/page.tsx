// Top-up queue: pending-confirmation and issued requests with their
// numbers, matter, amounts and references; confirm/cancel.

import { requirePrincipal } from '@/lib/auth'
import { topUpQueue } from '@/lib/reads/billing'
import { Page, Panel, DataTable, Notices, RowLink, Badge, fmtDateTime } from '@/components/ui'
import { TextInput, SubmitButton, InlineAction } from '@/components/forms'
import { readParams, type SearchParams } from '@/lib/screens/action'
import { confirmTopUpAction, cancelTopUpAction } from '../actions'

export default async function TopUpsPage({ searchParams }: { searchParams: SearchParams }) {
  const p = await requirePrincipal()
  const sp = await readParams(searchParams)
  const rows = await topUpQueue(p)
  return (
    <Page
      title="Top-up requests"
      lead="Raised when a matter's held money falls under its policy minimum. A pending request waits for the responsible lawyer's confirmation before anything reaches the client."
    >
      <Notices searchParams={sp} />
      <Panel>
        <DataTable
          headers={['Request', 'Matter', 'Amount', 'Raised', 'Alerted', 'State', '', '']}
          rows={rows.map((r) => [
            String(r.request_number),
            <RowLink key="m" href={`/matters/${r.matter}/billing`}>
              {String(r.matter_number)}
            </RowLink>,
            Number(r.amount_requested).toFixed(2),
            fmtDateTime(r.raised_at),
            String((r.alerted_name as { family?: string })?.family ?? ''),
            <span key="s">
              <Badge tone={r.state === 'issued' ? 'blue' : 'amber'}>
                {String(r.state).replace('_', ' ')}
              </Badge>
              {r.reference_code ? <span className="ml-1 text-neutral-400">{String(r.reference_code)}</span> : null}
              {r.attach_to_next_bill ? <Badge tone="neutral"> rides the next bill</Badge> : null}
            </span>,
            r.state === 'pending_confirmation' ? (
              <InlineAction key="c" action={confirmTopUpAction} fields={{ request: r.id as number }} label="Confirm & issue" tone="primary" />
            ) : (
              ''
            ),
            <form key="x" action={cancelTopUpAction} className="flex items-center gap-1">
              <input type="hidden" name="request" value={r.id as number} />
              <TextInput name="reason" placeholder="Cancel — reason" className="!w-36" />
              <SubmitButton tone="quiet">Cancel</SubmitButton>
            </form>,
          ])}
          emptyState="No top-up requests."
        />
      </Panel>
    </Page>
  )
}
