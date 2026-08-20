// Deferred duplicate review queue: records created by outside systems
// with possible duplicates were created verbatim and queued here — a person
// confirms them, or opens the merge screen. Test-mode rows never appear.

import { requirePrincipal } from '@/lib/auth'
import { duplicateReviewQueue } from '@/lib/reads/matters'
import { Page, Panel, DataTable, Notices, RowLink, fmtDateTime } from '@/components/ui'
import { InlineAction } from '@/components/forms'
import { readParams, type SearchParams } from '@/lib/screens/action'
import { confirmDuplicateAction } from '../actions'

export default async function DuplicateReviewPage({ searchParams }: { searchParams: SearchParams }) {
  const p = await requirePrincipal()
  const sp = await readParams(searchParams)
  const rows = await duplicateReviewQueue(p)
  return (
    <Page
      title="Duplicate review"
      lead="Records delivered by outside systems that looked like possible duplicates. They were created as sent — never silently merged — and wait here for a person's decision."
    >
      <Notices searchParams={sp} />
      <Panel>
        <DataTable
          headers={['Created record', 'Kind', 'Possible duplicates shown', 'Received', '', '']}
          rows={rows.map((r) => [
            r.createdEntityType === 'party' ? (
              <RowLink key="l" href={`/parties/${r.createdEntity}`}>
                {r.createdLabel}
              </RowLink>
            ) : (
              <RowLink key="l" href={`/intake/${r.createdEntity}`}>
                {r.createdLabel}
              </RowLink>
            ),
            r.createdEntityType.replace('_', ' '),
            String(Array.isArray(r.candidatesShown) ? r.candidatesShown.length : '—'),
            fmtDateTime(r.decidedAt),
            r.createdEntityType === 'party' ? (
              <RowLink key="m" href={`/parties/${r.createdEntity}/merge`}>
                Open merge
              </RowLink>
            ) : (
              ''
            ),
            <InlineAction
              key="c"
              action={confirmDuplicateAction}
              fields={{ decision: r.id }}
              label="Confirm — not a duplicate"
            />,
          ])}
          emptyState="Nothing awaiting review."
        />
      </Panel>
    </Page>
  )
}
