// Close approval queue: pending requests for matter.close holders. Own
// requests are flagged unapprovable — the requester never decides their own.

import { requirePrincipal } from '@/lib/auth'
import { closeApprovalQueue } from '@/lib/reads/matters'
import { Page, Panel, Notices, RowLink, Badge, EmptyState } from '@/components/ui'
import { Field, TextInput, SubmitButton, InlineAction } from '@/components/forms'
import { readParams, type SearchParams } from '@/lib/screens/action'
import { approveCloseAction, rejectCloseAction } from '../actions'

export default async function CloseApprovalsPage({ searchParams }: { searchParams: SearchParams }) {
  const p = await requirePrincipal()
  const sp = await readParams(searchParams)
  const rows = await closeApprovalQueue(p)
  return (
    <Page
      title="Close approvals"
      lead="Close requests awaiting a decision. The position shown was recorded at request time; approval re-computes everything fresh under lock before the matter actually closes."
    >
      <Notices searchParams={sp} />
      <Panel>
        {rows.length === 0 ? (
          <EmptyState>No closes awaiting approval.</EmptyState>
        ) : (
          <ul className="space-y-4">
            {rows.map((r) => (
              <li key={r.id} className="rounded-md border border-neutral-200 p-4">
                <div className="mb-2 flex items-center justify-between">
                  <p className="text-sm font-medium">
                    <RowLink href={`/matters/${r.matter}`}>{r.matterNumber}</RowLink> — {r.title}
                  </p>
                  <span className="text-xs text-neutral-500">requested by {r.requesterName}</span>
                </div>
                <p className="mb-3 text-sm text-neutral-600">
                  At request: unbilled {r.position.unbilled.toFixed(2)} · outstanding{' '}
                  {r.position.outstanding.toFixed(2)} · held {r.position.heldGross.toFixed(2)}
                </p>
                {r.own ? (
                  <p className="text-sm">
                    <Badge tone="amber">your own request</Badge>{' '}
                    <span className="text-neutral-500">— someone else must decide it.</span>
                  </p>
                ) : (
                  <div className="flex flex-wrap items-end gap-4">
                    <InlineAction
                      action={approveCloseAction}
                      fields={{ request: r.id }}
                      label="Approve & close"
                      tone="primary"
                    />
                    <form action={rejectCloseAction} className="flex items-end gap-2">
                      <input type="hidden" name="request" value={r.id} />
                      <div className="w-64">
                        <Field label="Reject — reason for the requester">
                          <TextInput name="note" required />
                        </Field>
                      </div>
                      <div className="pb-3">
                        <SubmitButton tone="quiet">Reject</SubmitButton>
                      </div>
                    </form>
                  </div>
                )}
              </li>
            ))}
          </ul>
        )}
      </Panel>
    </Page>
  )
}
