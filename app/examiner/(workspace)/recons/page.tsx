// Reconciliations: the period's reconciliations with their
// certification state and the schema-proven equation snapshot.

import { requirePrincipal } from '@/lib/auth'
import { examinerRecons } from '@/lib/reads/examiner'
import { Page, Panel, DataTable, EmptyState, Badge, RowLink, fmtDate } from '@/components/ui'

export default async function ExaminerReconsPage() {
  const p = await requirePrincipal()
  const rows = await examinerRecons(p)

  return (
    <Page
      title="Reconciliations"
      lead="Reconciliations dated within the examined period. The certification equation is proven by the database at certification; the snapshot shown is the certified record."
    >
      <Panel title="Reconciliations">
        {rows.length === 0 ? (
          <EmptyState>No reconciliation is dated within the examined period.</EmptyState>
        ) : (
          <DataTable
            headers={['Statement date', 'Account', 'Statement balance', 'Status', 'Matches', 'Exceptions', '']}
            rows={rows.map((r) => [
              fmtDate(r.statement_date),
              String(r.account_name),
              <span key="b" className="tabular-nums">{Number(r.statement_balance).toFixed(2)}</span>,
              <Badge key="s" tone={r.status === 'certified' ? 'green' : 'amber'}>
                {String(r.status).replace(/_/g, ' ')}
              </Badge>,
              String(r.match_groups),
              String(r.exceptions),
              <RowLink key="l" href={`/examiner/recons/${r.id}`}>
                Open
              </RowLink>,
            ])}
          />
        )}
      </Panel>
    </Page>
  )
}
