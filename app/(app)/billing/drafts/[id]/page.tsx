// The draft bill editor: sibling bills per payer share, lines with
// remove/write-down/add-manual, submit or issue per the approval setting and
// capability. The open-hold banner shows prominently; direct issue stays
// available on a held matter by design.

import { requirePrincipal } from '@/lib/auth'
import { draftEditor } from '@/lib/reads/billing'
import { Page, Panel, DataTable, Notices, RowLink, Badge } from '@/components/ui'
import { Field, TextInput, SubmitButton, InlineAction } from '@/components/forms'
import { readParams, type SearchParams } from '@/lib/screens/action'
import {
  removeLineAction,
  writeDownLineAction,
  addManualLineAction,
  submitDraftAction,
  sendBackAction,
  issueGroupAction,
  abandonDraftAction,
} from '../../actions'

export default async function DraftEditorPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>
  searchParams: SearchParams
}) {
  const p = await requirePrincipal()
  const { id } = await params
  const sp = await readParams(searchParams)
  const d = await draftEditor(p, Number(id))
  const g = d.group
  const pending = d.bills.some((b) => b.state === 'pending_approval')
  const issued = d.bills.every((b) => b.state === 'issued')

  return (
    <Page
      title={`Draft bill — ${String(g.matter_number)}`}
      lead={
        <span>
          {String(g.title)} — matter total {Number(g.matter_total).toFixed(2)}.{' '}
          <RowLink href={`/matters/${g.matter}/billing`}>Back to the matter's billing</RowLink>.
          {pending ? ' Awaiting approval — new lines refuse until sent back.' : ''}
        </span>
      }
    >
      <Notices searchParams={sp} />

      {d.openHold ? (
        <p className="mb-4 rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-900">
          <strong>This matter is on billing hold:</strong> {String(d.openHold.reason)} — runs skip
          it; issuing directly from here remains available deliberately.
        </p>
      ) : null}

      {d.bills.map((b) => (
        <Panel
          key={b.id as number}
          title={
            <span>
              {String(b.payer_name)} — {String(b.share_pct)}%{' '}
              <Badge tone={b.state === 'issued' ? 'green' : b.state === 'pending_approval' ? 'amber' : 'blue'}>
                {String(b.state).replace(/_/g, ' ')}
              </Badge>
            </span>
          }
          actions={<span className="text-sm tabular-nums text-neutral-600">total {Number(b.total).toFixed(2)}</span>}
        >
          <DataTable
            headers={['#', 'Kind', 'Description', 'Units', 'Original', 'Now', 'Tax', '', '']}
            rows={d.lines
              .filter((l) => l.bill === b.id)
              .map((l) => [
                String(l.position),
                String(l.kind).replace('_', ' '),
                String(l.description),
                l.quantity_units === null ? '—' : String(l.quantity_units),
                Number(l.original_value).toFixed(2),
                <span key="n">
                  {Number(l.amount).toFixed(2)}
                  {l.written_down_to !== null ? (
                    <Badge tone="amber"> written down</Badge>
                  ) : null}
                </span>,
                Number(l.tax_amount).toFixed(2),
                b.state === 'draft' ? (
                  <details key="wd">
                    <summary className="cursor-pointer text-xs text-sky-700">Write down</summary>
                    <form action={writeDownLineAction} className="mt-2 flex items-center gap-1">
                      <input type="hidden" name="group" value={g.id as number} />
                      <input type="hidden" name="position" value={l.position as number} />
                      <TextInput name="written_down_to" placeholder="New amount" inputMode="decimal" className="!w-24" />
                      <TextInput name="reason" placeholder="Reason" className="!w-32" />
                      <SubmitButton tone="quiet">Apply</SubmitButton>
                    </form>
                  </details>
                ) : (
                  ''
                ),
                b.state === 'draft' ? (
                  <InlineAction
                    key="rm"
                    action={removeLineAction}
                    fields={{ group: g.id as number, position: l.position as number }}
                    label="Remove"
                  />
                ) : (
                  ''
                ),
              ])}
            emptyState="No lines on this sibling."
          />
        </Panel>
      ))}

      {!issued ? (
        <Panel title="Actions">
          <div className="flex flex-wrap items-end gap-6">
            {!pending ? (
              <form action={addManualLineAction} className="flex items-end gap-2">
                <input type="hidden" name="group" value={g.id as number} />
                <div className="w-64">
                  <Field label="Manual line — description">
                    <TextInput name="description" required />
                  </Field>
                </div>
                <div className="w-28">
                  <Field label="Amount">
                    <TextInput name="amount" required inputMode="decimal" />
                  </Field>
                </div>
                <div className="pb-3">
                  <SubmitButton tone="quiet">Add line</SubmitButton>
                </div>
              </form>
            ) : null}
            {d.approvalRequired && !pending ? (
              <InlineAction action={submitDraftAction} fields={{ group: g.id as number }} label="Submit for approval" tone="primary" />
            ) : null}
            {pending && d.mayApprove ? (
              <form action={sendBackAction} className="flex items-end gap-2">
                <input type="hidden" name="group" value={g.id as number} />
                <div className="w-56">
                  <Field label="Send back — note">
                    <TextInput name="note" />
                  </Field>
                </div>
                <div className="pb-3">
                  <SubmitButton tone="quiet">Send back to draft</SubmitButton>
                </div>
              </form>
            ) : null}
            {d.mayIssue && (!d.approvalRequired || pending) ? (
              // With approval on, issue lands here for the approver from the queue.
              <InlineAction
                action={issueGroupAction}
                fields={{ group: g.id as number }}
                label="Issue — numbers allocate only on commit"
                tone="danger"
              />
            ) : null}
            {!pending ? (
              <InlineAction
                action={abandonDraftAction}
                fields={{ matter: g.matter as number, group: g.id as number }}
                label="Abandon draft"
              />
            ) : null}
          </div>
          <p className="mt-2 text-xs text-neutral-400">
            Sibling bills issue together as one unit; the split is exact to the cent by
            largest-remainder. A refused issue consumes no bill number.
          </p>
        </Panel>
      ) : null}
    </Page>
  )
}
