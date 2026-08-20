// The refusal register: every typed, permanent refusal within the
// examined period. The attempted operation's raw parameters stay off this
// surface — reason, time, ledger and promotion state are the evidence.

import { requirePrincipal } from '@/lib/auth'
import { examinerRefusals } from '@/lib/reads/examiner'
import { Page, Panel, DataTable, EmptyState, Badge, fmtDateTime } from '@/components/ui'

export default async function ExaminerRefusalsPage() {
  const p = await requirePrincipal()
  const rows = await examinerRefusals(p)

  return (
    <Page
      title="Refusal register"
      lead="Operations the platform refused within the examined period. Rows are permanent and never editable."
    >
      <Panel title="Refusals">
        {rows.length === 0 ? (
          <EmptyState>No refusals in the examined period.</EmptyState>
        ) : (
          <DataTable
            headers={['At', 'Reason', 'Account', 'Ledger', 'Client', 'Escalation']}
            rows={rows.map((r) => [
              fmtDateTime(r.at),
              String(r.refusal_reason).replace(/_/g, ' '),
              String(r.account_name),
              r.ledger_number ? String(r.ledger_number) : '—',
              r.client_display_name ? String(r.client_display_name) : '—',
              r.promoted_incident ? (
                <Badge key="p" tone="amber">promoted to incident</Badge>
              ) : (
                '—'
              ),
            ])}
          />
        )}
      </Panel>
    </Page>
  )
}
