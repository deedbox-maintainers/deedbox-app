// Report catalogue: the standard set the release ships (an empty
// catalogue is impossible), plus shared and personal saved reports.

import { requirePrincipal } from '@/lib/auth'
import { reportCatalogue } from '@/lib/reads/operations'
import { Page, Panel, DataTable, EmptyState, Notices, RowLink, Badge, personName } from '@/components/ui'
import { readParams, type SearchParams } from '@/lib/screens/action'

export default async function ReportCataloguePage({ searchParams }: { searchParams: SearchParams }) {
  const p = await requirePrincipal()
  const sp = await readParams(searchParams)
  const d = await reportCatalogue(p)

  return (
    <Page
      title="Reports"
      lead="Every list opens its records; rows and totals always share one query at one instant."
    >
      <Notices searchParams={sp} />
      <Panel title="Standard reports">
        <DataTable
          headers={['Report', 'Key', 'Schedulable', '']}
          rows={d.definitions.map((r) => [
            String(r.title),
            String(r.key),
            r.schedulable ? 'yes' : 'no',
            <RowLink key="o" href={`/reports/${r.key}`}>
              Run
            </RowLink>,
          ])}
        />
      </Panel>
      <Panel title="Saved reports">
        {d.saved.length === 0 ? (
          <EmptyState>Nothing saved — run a report and save it with its filters.</EmptyState>
        ) : (
          <DataTable
            headers={['Name', 'Base report', 'Owner', 'Shared', '']}
            rows={d.saved.map((s) => [
              String(s.name),
              String(s.title),
              personName(s.owner_name),
              s.shared ? <Badge key="s" tone="blue">shared</Badge> : '—',
              <RowLink key="o" href={`/reports/${s.key}?saved=${s.id}`}>
                Run
              </RowLink>,
            ])}
          />
        )}
        <p className="mt-2 text-xs text-neutral-500">
          <RowLink href="/reports/schedules">Schedules</RowLink> ·{' '}
          <RowLink href="/reports/targets">Targets & groups</RowLink> ·{' '}
          <RowLink href="/security/exports">Export history</RowLink>
        </p>
      </Panel>
    </Page>
  )
}
