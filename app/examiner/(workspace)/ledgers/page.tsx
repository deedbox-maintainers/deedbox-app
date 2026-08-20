// Examiner ledgers: every ledger with movement in the examined period, under
// the minimal header — ledger number, client display name, matter
// reference — and nothing more. Matterless ledgers name their kind.

import { requirePrincipal } from '@/lib/auth'
import { examinerLedgers } from '@/lib/reads/examiner'
import { Page, Panel, DataTable, EmptyState, Badge, RowLink } from '@/components/ui'

export default async function ExaminerLedgersPage() {
  const p = await requirePrincipal()
  const rows = await examinerLedgers(p)

  return (
    <Page
      title="Ledgers"
      lead="Ledgers with movement in the examined period. Identity is the fixed minimal header."
    >
      <Panel title="Ledgers">
        {rows.length === 0 ? (
          <EmptyState>No ledger moved in the examined period.</EmptyState>
        ) : (
          <DataTable
            headers={['Ledger', 'Client', 'Matter reference', 'Status', '']}
            rows={rows.map((r) => [
              String(r.ledger_number),
              r.client_display_name ? (
                String(r.client_display_name)
              ) : (
                <Badge key="k" tone="violet">{String(r.ledger_kind).replace(/_/g, ' ')}</Badge>
              ),
              r.matter_reference ? String(r.matter_reference) : '—',
              <Badge key="s" tone={r.status === 'open' ? 'green' : 'neutral'}>
                {String(r.status)}
              </Badge>,
              <RowLink key="l" href={`/examiner/ledgers/${r.id}`}>
                Open
              </RowLink>,
            ])}
          />
        )}
      </Panel>
    </Page>
  )
}
