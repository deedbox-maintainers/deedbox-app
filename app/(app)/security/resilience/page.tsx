// Resilience screen: restore tests and backup verifications with
// measured recovery figures, the published control documents, and the
// stated objectives.

import { requirePrincipal } from '@/lib/auth'
import { resilienceScreen } from '@/lib/reads/security'
import { Page, Panel, DataTable, Badge, fmtDate, fmtDateTime } from '@/components/ui'

export default async function ResiliencePage() {
  const p = await requirePrincipal()
  const { events, documents } = await resilienceScreen(p)
  return (
    <Page
      title="Resilience"
      lead="Objectives: at most 15 minutes of data at risk (recovery point), service back within 4 hours (recovery time). Verification runs prove them."
    >
      <Panel title="Verification runs">
        <DataTable
          headers={['Started', 'Kind', 'Environment', 'Outcome', 'Recovery point (min)', 'Recovery time (min)']}
          emptyState="No verification runs recorded yet."
          rows={events.map((e) => [
            fmtDateTime(e.started_at),
            e.kind,
            e.environment,
            e.outcome === 'passed' ? (
              <Badge tone="green">passed</Badge>
            ) : e.outcome === 'failed' ? (
              <Badge tone="red">failed</Badge>
            ) : (
              <Badge tone="amber">running</Badge>
            ),
            e.measured_recovery_point_minutes ?? '—',
            e.measured_recovery_minutes ?? '—',
          ])}
        />
      </Panel>
      <Panel title="Control documents">
        <DataTable
          headers={['Document', 'Version', 'Effective from']}
          emptyState="No control documents published yet."
          rows={documents.map((d) => [d.key.replaceAll('_', ' '), d.version, fmtDate(d.effective_from)])}
        />
      </Panel>
    </Page>
  )
}
