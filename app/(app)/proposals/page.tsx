// Proposals queue: pending date-recompute and assignment re-resolution
// proposals across visible matters, oldest first. Nothing moves until a
// person confirms on the proposal's own screen.

import { requirePrincipal } from '@/lib/auth'
import { proposalsQueue } from '@/lib/reads/experience'
import { Page, Panel, DataTable, EmptyState, Notices, RowLink, fmtDateTime } from '@/components/ui'
import { readParams, type SearchParams } from '@/lib/screens/action'

export default async function ProposalsPage({ searchParams }: { searchParams: SearchParams }) {
  const p = await requirePrincipal()
  const sp = await readParams(searchParams)
  const d = await proposalsQueue(p)

  const table = (rows: typeof d.dates, kind: 'date' | 'slot') =>
    rows.length === 0 ? (
      <EmptyState>No date or assignment changes await confirmation.</EmptyState>
    ) : (
      <DataTable
        headers={['Raised', 'Matter', 'Items', '']}
        rows={rows.map((x) => [
          fmtDateTime(x.created_at),
          String(x.matter_number),
          String(
            kind === 'date'
              ? ((x.changes as { items?: unknown[] } | null)?.items?.length ?? '—')
              : Array.isArray(x.changes)
                ? (x.changes as unknown[]).length
                : '—',
          ),
          <RowLink key="o" href={`/proposals/${kind}/${x.id}`}>
            Review & decide
          </RowLink>,
        ])}
      />
    )

  return (
    <Page
      title="Awaiting confirmation"
      lead="Anchor-date changes and staffing changes never move dates or owners silently — each proposal is confirmed here, item by item if need be."
    >
      <Notices searchParams={sp} />
      <Panel title="Date recomputations">{table(d.dates, 'date')}</Panel>
      <Panel title="Assignment re-resolutions">{table(d.slots, 'slot')}</Panel>
    </Page>
  )
}
