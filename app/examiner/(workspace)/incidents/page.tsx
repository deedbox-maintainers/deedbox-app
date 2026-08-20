// The incident register: deficiency incidents in existence by the
// period end — an unrectified older deficiency is exactly what an
// examination exists to find.

import { requirePrincipal } from '@/lib/auth'
import { examinerIncidents } from '@/lib/reads/examiner'
import { Page, Panel, DataTable, EmptyState, Badge, fmtDate } from '@/components/ui'

export default async function ExaminerIncidentsPage() {
  const p = await requirePrincipal()
  const rows = await examinerIncidents(p)

  return (
    <Page
      title="Incident register"
      lead="Deficiency incidents arising on or before the examined period's end, with their rectification state."
    >
      <Panel title="Incidents">
        {rows.length === 0 ? (
          <EmptyState>No incidents by the examined period's end.</EmptyState>
        ) : (
          <DataTable
            headers={['Date', 'Amount', 'Cause', 'Account', 'Ledger', 'Client', 'State']}
            rows={rows.map((i) => [
              fmtDate(i.incident_date),
              <span key="a" className="tabular-nums">{Number(i.amount).toFixed(2)}</span>,
              String(i.cause),
              String(i.account_name),
              i.ledger_number ? String(i.ledger_number) : '—',
              i.client_display_name ? String(i.client_display_name) : '—',
              <Badge
                key="s"
                tone={i.state === 'open' ? 'red' : i.state === 'rectified' ? 'amber' : 'green'}
              >
                {String(i.state)}
              </Badge>,
            ])}
          />
        )}
      </Panel>
    </Page>
  )
}
