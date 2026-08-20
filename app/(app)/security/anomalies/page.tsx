// Anomaly alerts: unacknowledged first, triggering entries linked into
// the register screen, acknowledge action.

import { requirePrincipal } from '@/lib/auth'
import { anomalyAlerts } from '@/lib/reads/security'
import { Page, Panel, DataTable, Badge, Notices, RowLink, fmtDateTime } from '@/components/ui'
import { InlineAction } from '@/components/forms'
import { readParams, type SearchParams } from '@/lib/screens/action'
import { acknowledge } from '../actions'

export default async function AnomaliesPage({ searchParams }: { searchParams: SearchParams }) {
  const p = await requirePrincipal()
  const sp = await readParams(searchParams)
  const alerts = await anomalyAlerts(p)
  return (
    <Page
      title="Anomaly alerts"
      lead="Patterns in the register worth a human look: repeated sign-in failures, unusually large exports, permission escalations, private-layer violations."
    >
      <Notices searchParams={sp} />
      <Panel>
        <DataTable
          headers={['Raised', 'Rule', 'Summary', 'Entries', 'State', '']}
          emptyState="No anomalies detected."
          rows={alerts.map((a) => [
            fmtDateTime(a.raised_at),
            <Badge key="r" tone="amber">{a.rule_key}</Badge>,
            a.summary,
            <RowLink key="e" href="/security/register">
              {Array.isArray(a.triggering_register_entries)
                ? `${(a.triggering_register_entries as unknown[]).length} entries`
                : 'view'}
            </RowLink>,
            a.acknowledged_at ? <Badge tone="green">acknowledged</Badge> : <Badge tone="red">open</Badge>,
            a.acknowledged_at ? null : (
              <InlineAction action={acknowledge} fields={{ alert: a.id }} label="Acknowledge" />
            ),
          ])}
        />
      </Panel>
    </Page>
  )
}
