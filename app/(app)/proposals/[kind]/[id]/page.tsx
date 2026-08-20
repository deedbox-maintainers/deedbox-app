// The proposal confirm screen: every item old → new with per-item
// keep/apply; confirm applies the ticked items through the one-run bulk
// machinery, reject stands everything down.

import { requirePrincipal } from '@/lib/auth'
import { proposalDetail } from '@/lib/reads/experience'
import { Page, Panel, Notices, RowLink, fmtDateTime } from '@/components/ui'
import { SubmitButton, TextInput, Field } from '@/components/forms'
import { readParams, type SearchParams } from '@/lib/screens/action'
import { decideDateProposalAction, decideSlotProposalAction } from '../../../tasks/actions'

interface ChangeItem {
  task: number
  title?: string
  old_value?: string | null
  new_value?: string | null
  current_owner?: number | null
  proposed_owner?: number | null
}

export default async function ProposalDetailPage({
  params,
  searchParams,
}: {
  params: Promise<{ kind: string; id: string }>
  searchParams: SearchParams
}) {
  const p = await requirePrincipal()
  const { kind, id } = await params
  const sp = await readParams(searchParams)
  const isDate = kind === 'date'
  const d = await proposalDetail(p, { kind: isDate ? 'date' : 'slot', id: Number(id) })
  // date proposals store {anchor_definition, old_value, new_value, items: [...]};
  // slot proposals' column IS the bare array (aliased as changes by the read)
  const changes = (isDate
    ? ((d.changes as { items?: ChangeItem[] } | null)?.items ?? [])
    : Array.isArray(d.changes)
      ? (d.changes as ChangeItem[])
      : []) as ChangeItem[]
  const action = isDate ? decideDateProposalAction : decideSlotProposalAction

  return (
    <Page
      title={isDate ? 'Date recomputation' : 'Assignment re-resolution'}
      lead={
        <span>
          {String(d.matter_number)} — raised {fmtDateTime(d.created_at)} · state {String(d.state)} ·{' '}
          <RowLink href="/proposals">Back to the queue</RowLink>
        </span>
      }
    >
      <Notices searchParams={sp} />
      <Panel title={`${changes.length} proposed change(s)`}>
        {d.state !== 'pending' ? (
          <p className="text-sm text-neutral-600">This proposal is already {String(d.state)}.</p>
        ) : (
          <form action={action}>
            <input type="hidden" name="proposal" value={String(d.id)} />
            <input type="hidden" name="back" value="/proposals" />
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-xs uppercase tracking-wide text-neutral-400">
                  <th className="py-1 pr-2">Apply</th>
                  <th className="py-1 pr-2">Item</th>
                  <th className="py-1 pr-2">From</th>
                  <th className="py-1">To</th>
                </tr>
              </thead>
              <tbody>
                {changes.map((c) => (
                  <tr key={c.task} className="border-t border-neutral-100">
                    <td className="py-1 pr-2">
                      <input type="checkbox" name="accept_task" value={String(c.task)} defaultChecked />
                    </td>
                    <td className="py-1 pr-2">{c.title ?? `task #${c.task}`}</td>
                    <td className="py-1 pr-2 tabular-nums">
                      {String(c.old_value ?? (c.current_owner != null ? `staff #${c.current_owner}` : '—'))}
                    </td>
                    <td className="py-1 tabular-nums">
                      {String(c.new_value ?? (c.proposed_owner != null ? `staff #${c.proposed_owner}` : '—'))}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            <div className="mt-3 flex items-end gap-3">
              <Field label="Note (optional)">
                <TextInput name="note" />
              </Field>
              <button
                type="submit"
                name="decision"
                value="confirm"
                className="rounded bg-neutral-900 px-3 py-1.5 text-sm font-medium text-white hover:bg-neutral-700"
              >
                Confirm ticked items
              </button>
              <button
                type="submit"
                name="decision"
                value="reject"
                className="rounded border border-neutral-300 px-3 py-1.5 text-sm text-neutral-700 hover:bg-neutral-50"
              >
                Reject all
              </button>
            </div>
          </form>
        )}
      </Panel>
    </Page>
  )
}
