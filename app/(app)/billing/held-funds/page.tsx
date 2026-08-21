// Held-funds application runs: preview → commit → per-item
// authorisation by a DIFFERENT person (the run actor is always the
// requester), with the run history.

import { requirePrincipal } from '@/lib/auth'
import { heldFundsRuns } from '@/lib/reads/billing'
import { Page, Panel, DataTable, Notices, RowLink, Badge, fmtDateTime } from '@/components/ui'
import { SubmitButton } from '@/components/forms'
import { readParams, type SearchParams } from '@/lib/screens/action'
import MatterPicker from '@/components/matter-picker'
import { previewHeldFundsAction } from '../actions'

export default async function HeldFundsPage({ searchParams }: { searchParams: SearchParams }) {
  const p = await requirePrincipal()
  const sp = await readParams(searchParams)
  const runs = await heldFundsRuns(p)
  return (
    <Page
      title="Apply held client money to bills"
      lead="Where an entitlement to held money is actionable, this bridge pays the firm's bill from it — every step recorded, every item needing a different authoriser, refusals typed and kept."
    >
      <Notices searchParams={sp} />
      <Panel title="Preview a run — nothing moves">
        <form action={previewHeldFundsAction} className="flex max-w-xl items-end gap-2">
          <div className="w-96">
            <MatterPicker
              name="matter"
              label="Matter"
              hint="Pick one matter — or leave blank to sweep the whole firm: every issued bill still owing on a matter holding available client money is found and prepared for approval"
            />
          </div>
          <div className="pb-8">
            <SubmitButton>Preview</SubmitButton>
          </div>
        </form>
      </Panel>
      <Panel title="Runs">
        <DataTable
          headers={['Run', 'When', 'By', 'Scope', 'Items', 'State']}
          rows={runs.map((r) => [
            <RowLink key="r" href={`/billing/held-funds/${r.id}`}>
              #{String(r.id)}
            </RowLink>,
            fmtDateTime(r.run_at),
            String((r.run_by_name as { family?: string })?.family ?? ''),
            String(r.scope).replace('_', ' '),
            String(r.items),
            <Badge
              key="s"
              tone={
                r.state === 'completed'
                  ? 'green'
                  : r.state === 'completed_with_refusals'
                    ? 'amber'
                    : r.state === 'abandoned'
                      ? 'neutral'
                      : 'blue'
              }
            >
              {String(r.state).replace(/_/g, ' ')}
            </Badge>,
          ])}
          emptyState="No runs."
        />
      </Panel>
    </Page>
  )
}
