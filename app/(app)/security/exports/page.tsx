// Export history: the export.performed projection; everyone sees their
// own exports, administrators see all.

import { requirePrincipal } from '@/lib/auth'
import { exportHistory } from '@/lib/reads/security'
import { Page, Panel, DataTable, fmtDateTime, personName } from '@/components/ui'

export default async function ExportHistoryPage() {
  const p = await requirePrincipal()
  const rows = await exportHistory(p)
  return (
    <Page
      title="Export history"
      lead="Every export is a registered event carrying the exact artefact and its restricted-matter count."
    >
      <Panel>
        <DataTable
          headers={['When', 'Who', 'What', 'Rows', 'Restricted matters', 'Artefact']}
          emptyState="No exports recorded."
          rows={rows.map((r) => {
            const d = (r.detail ?? {}) as Record<string, unknown>
            return [
              fmtDateTime(r.occurred_at),
              r.actor_kind === 'staff' ? personName(r.actor_name) : r.actor_kind,
              String(d.export ?? d.report ?? d.kind ?? '—'),
              String(d.row_count ?? d.rows ?? '—'),
              String(d.restricted_matter_count ?? d.restricted_matters ?? '0'),
              r.artefact ? <code className="text-xs">{String(r.artefact).slice(0, 24)}…</code> : '—',
            ]
          })}
        />
      </Panel>
    </Page>
  )
}
