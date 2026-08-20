// Personal dashboard — always the viewer's own figures, never a
// colleague's; targets with progress ride tile_my_targets.

import { requirePrincipal } from '@/lib/auth'
import { runReport, type ReportResult } from '@/lib/ops/reports'
import { dashboardPeriod } from '@/lib/reads/experience'
import { OperationRefused } from '@/lib/db'
import { Page, Panel, DataTable, EmptyState } from '@/components/ui'

const MY_TILES = ['tile_my_recorded', 'tile_my_billed', 'tile_my_collected', 'tile_my_targets']

export default async function PersonalDashboard() {
  const p = await requirePrincipal()
  const period = await dashboardPeriod(p)

  const tiles: ReportResult[] = []
  for (const key of MY_TILES) {
    try {
      tiles.push(
        await runReport(p, {
          key,
          filters: { periodStart: period.periodStart, periodEnd: period.periodEnd },
        }),
      )
    } catch (err) {
      if (err instanceof OperationRefused && (err.code === 'not_visible' || err.code === 'not_found'))
        continue
      throw err
    }
  }

  return (
    <Page
      title="My figures"
      lead={`This period: ${period.label} (${period.periodStart} to ${period.periodEnd}). Only your own figures appear here.`}
    >
      {tiles.length === 0 ? (
        <Panel>
          <EmptyState>No targets set — figures appear as you record work.</EmptyState>
        </Panel>
      ) : (
        tiles.map((t) => (
          <Panel key={t.key} title={t.title}>
            {t.rows.length === 0 ? (
              <EmptyState>No targets set — figures appear as you record work.</EmptyState>
            ) : (
              <DataTable
                headers={t.columns.map((c) => c.replace(/_/g, ' '))}
                rows={t.rows.map((r) =>
                  t.columns.map((c) => {
                    const v = r[c]
                    return typeof v === 'number' || (typeof v === 'string' && /^-?\d+(\.\d+)?$/.test(v))
                      ? Number(v).toFixed(2)
                      : String(v ?? '—')
                  }),
                )}
              />
            )}
          </Panel>
        ))
      )}
    </Page>
  )
}
