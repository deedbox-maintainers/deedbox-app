// The master-data journal: every identity change touching client
// money within the examined period — the register's own projection over
// master_data.changed, served to examiners by the 0025 row policy.

import { requirePrincipal } from '@/lib/auth'
import { examinerMasterData } from '@/lib/reads/examiner'
import { Page, Panel, DataTable, EmptyState, fmtDateTime, fmtJson } from '@/components/ui'

export default async function ExaminerMasterDataPage() {
  const p = await requirePrincipal()
  const rows = await examinerMasterData(p)

  return (
    <Page
      title="Master-data journal"
      lead="Changes to client-money identity data (names, references, ledger identity) within the examined period, exactly as the register recorded them."
    >
      <Panel title="Changes">
        {rows.length === 0 ? (
          <EmptyState>No master-data changes in the examined period.</EmptyState>
        ) : (
          <DataTable
            headers={['At', 'Record', 'Change']}
            rows={rows.map((e) => [
              fmtDateTime(e.occurred_at),
              `${String(e.subject_type).replace(/_/g, ' ')} #${String(e.subject)}`,
              <pre key="d" className="max-w-xl overflow-x-auto whitespace-pre-wrap text-xs">
                {fmtJson(e.detail)}
              </pre>,
            ])}
          />
        )}
      </Panel>
    </Page>
  )
}
