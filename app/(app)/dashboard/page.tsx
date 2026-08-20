// Firm dashboard: tiles over the engine (every figure is a report
// key — the tile and its drill-down share one builder by construction), the
// office filter, the period label from reporting.dashboard_period. Tiles a
// role cannot see simply do not render.

import { requirePrincipal } from '@/lib/auth'
import { runReport, type ReportResult } from '@/lib/ops/reports'
import { dashboardPeriod } from '@/lib/reads/experience'
import { OperationRefused } from '@/lib/db'
import { Page, Panel, EmptyState, RowLink } from '@/components/ui'
import { readParams, type SearchParams } from '@/lib/screens/action'

const FIRM_TILES = [
  { key: 'tile_matters_opened', figure: 'count', caption: 'matters opened this period' },
  { key: 'tile_matters_closed', figure: 'count', caption: 'matters closed this period' },
  { key: 'tile_unbilled_work', figure: 'value', caption: 'unbilled work on the books' },
  { key: 'tile_outstanding_by_age', figure: 'outstanding', caption: 'outstanding bills (by age below)' },
  { key: 'tile_client_money_available', figure: 'available', caption: 'client money available' },
  { key: 'tile_billed_this_period', figure: 'billed', caption: 'billed this period' },
  { key: 'tile_collected_this_period', figure: 'collected', caption: 'collected this period' },
]

function tileFigure(r: ReportResult, figure: string): string {
  const t = r.totals[figure]
  if (t !== undefined) return figure === 'count' ? String(t) : t.toFixed(2)
  const totalKeys = Object.keys(r.totals)
  if (totalKeys.length === 1) return r.totals[totalKeys[0]].toFixed(2)
  return String(r.rows.length)
}

export default async function FirmDashboard({ searchParams }: { searchParams: SearchParams }) {
  const p = await requirePrincipal()
  const sp = await readParams(searchParams)
  const period = await dashboardPeriod(p)
  const office = sp.office ? Number(sp.office) : undefined

  const tiles: { key: string; caption: string; figure: string; result: ReportResult }[] = []
  for (const t of FIRM_TILES) {
    try {
      const result = await runReport(p, {
        key: t.key,
        filters: { periodStart: period.periodStart, periodEnd: period.periodEnd, office },
      })
      tiles.push({ key: t.key, caption: t.caption, figure: tileFigure(result, t.figure), result })
    } catch (err) {
      if (err instanceof OperationRefused && (err.code === 'not_visible' || err.code === 'not_found'))
        continue
      throw err
    }
  }

  return (
    <Page
      title="Firm dashboard"
      lead={`This period: ${period.label} (${period.periodStart} to ${period.periodEnd}). Every figure opens its rows — a tile and its drill-down can never disagree.`}
    >
      {tiles.length === 0 ? (
        <Panel>
          <EmptyState>Your role sees no firm tiles — your personal dashboard carries your own figures.</EmptyState>
        </Panel>
      ) : (
        <div className="grid gap-4 md:grid-cols-3">
          {tiles.map((t) => (
            <Panel key={t.key} title={t.result.title}>
              <p className="text-2xl font-semibold tabular-nums text-neutral-900">{t.figure}</p>
              <p className="text-xs text-neutral-500">{t.caption}</p>
              <p className="mt-2 text-xs">
                <RowLink href={`/reports/${t.key}`}>Open the rows ({t.result.rows.length})</RowLink>
              </p>
            </Panel>
          ))}
        </div>
      )}
      <Panel title="Personal">
        <p className="text-sm text-neutral-600">
          <RowLink href="/dashboard/personal">Your own figures and targets →</RowLink>
        </p>
      </Panel>
    </Page>
  )
}
