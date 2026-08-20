// Firm-wide critical dates: overdue first, then upcoming within the
// horizon — independent of any external calendar.

import { requirePrincipal } from '@/lib/auth'
import { criticalDatesView } from '@/lib/reads/experience'
import { Page, Panel, DataTable, EmptyState, Notices, RowLink, Badge, fmtDateTime, personName } from '@/components/ui'
import { readParams, type SearchParams } from '@/lib/screens/action'
import { keyDateDoneAction } from '../tasks/actions'
import { SubmitButton } from '@/components/forms'

export default async function CriticalDatesPage({ searchParams }: { searchParams: SearchParams }) {
  const p = await requirePrincipal()
  const sp = await readParams(searchParams)
  const d = await criticalDatesView(p)

  return (
    <Page
      title="Critical dates"
      lead={`Every critical date across the matters you can see — overdue first, then the next ${d.horizon} days.`}
    >
      <Notices searchParams={sp} />
      <Panel title={`${d.rows.length} critical`}>
        {d.rows.length === 0 ? (
          <EmptyState>No critical dates in the next {d.horizon} days.</EmptyState>
        ) : (
          <DataTable
            headers={['When', 'Matter', 'Type', 'Title', 'Owner lawyer', '']}
            rows={d.rows.map((k) => [
              <span key="w">
                {fmtDateTime(k.starts_at)} {k.overdue ? <Badge tone="red">overdue</Badge> : null}
              </span>,
              <RowLink key="m" href={`/matters/${k.matter}/workflow`}>
                {String(k.matter_number)}
              </RowLink>,
              String(k.type_label),
              String(k.title),
              k.owner_lawyer ? personName(k.owner_lawyer) : '—',
              <form key="d" action={keyDateDoneAction}>
                <input type="hidden" name="key_date" value={String(k.id)} />
                <input type="hidden" name="done" value="true" />
                <input type="hidden" name="back" value="/dates" />
                <SubmitButton>Done</SubmitButton>
              </form>,
            ])}
          />
        )}
      </Panel>
    </Page>
  )
}
