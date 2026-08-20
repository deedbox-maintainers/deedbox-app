// Report viewer — the drill-down every tile and view opens, with the full
// chrome: column chooser, filters, two-level grouping with per-group
// subtotals, save, export, schedule. The engine stays the single home of
// every figure (rows, totals and the export artefact are its output at one
// instant); the chooser and grouping are display layout riding the query
// string (`cols`, `group`) so links, tiles and saved reports can carry them.

import type { ReactNode } from 'react'
import { requirePrincipal } from '@/lib/auth'
import { runReport, savedReportView } from '@/lib/ops/reports'
import { reportViewerContext } from '@/lib/reads/operations'
import { Page, Panel, EmptyState, RowLink, Notices, personName } from '@/components/ui'
import { Field, TextInput, Select, SubmitButton } from '@/components/forms'
import { readParams, type SearchParams } from '@/lib/screens/action'
import { saveReportAction, exportReportAction, scheduleReportAction } from '../actions'

type Row = Record<string, unknown>

/** Accept a multi-value query param as either repeated values or one comma list. */
function multi(v: string | string[] | undefined): string[] {
  if (v === undefined) return []
  return (Array.isArray(v) ? v : v.split(',')).map((s) => s.trim()).filter(Boolean)
}

function fmtCell(c: string, v: unknown): string {
  if (v === null || v === undefined) return '—'
  if (c === 'matter' || c === 'task') return String(v)
  return typeof v === 'number' ? v.toFixed(2) : String(v)
}

/** Cents-safe column sum for subtotal rows (never float-accumulate money). */
function sumOf(rows: Row[], key: string): number {
  return rows.reduce((acc, r) => acc + Math.round(Number(r[key] ?? 0) * 100), 0) / 100
}

export default async function ReportPage({
  params,
  searchParams,
}: {
  params: Promise<{ key: string }>
  searchParams: SearchParams
}) {
  const p = await requirePrincipal()
  const { key } = await params
  const raw = await searchParams
  const sp = await readParams(searchParams)

  // the saved layer: ?saved= renders the saved layout. A param PRESENT in
  // the query (even empty — the filter form always submits every field) is
  // an explicit choice and wins; only an ABSENT param falls back to the
  // saved value, so clearing a filter on a saved report really clears it.
  const saved = sp.saved ? await savedReportView(p, Number(sp.saved)) : null
  const savedFilters = (saved?.filters ?? {}) as {
    periodStart?: string
    periodEnd?: string
    practiceArea?: number
    office?: number
  }
  const pick = (name: string, savedVal: string | undefined): string | undefined => {
    const v = raw[name]
    if (v === undefined) return savedVal
    const s = Array.isArray(v) ? v[0] : v
    return s === '' ? undefined : s
  }
  const pickNum = (name: string, savedVal: number | undefined): number | undefined => {
    const s = pick(name, savedVal === undefined ? undefined : String(savedVal))
    return s === undefined ? undefined : Number(s)
  }
  const filters = {
    periodStart: pick('period_start', savedFilters.periodStart),
    periodEnd: pick('period_end', savedFilters.periodEnd),
    practiceArea: pickNum('practice_area', savedFilters.practiceArea),
    office: pickNum('office', savedFilters.office),
  }

  const [r, ctx] = await Promise.all([
    runReport(p, { key, filters }),
    reportViewerContext(p, key),
  ])

  const chosen = raw.cols !== undefined ? multi(raw.cols) : (saved?.columns ?? [])
  const visible =
    chosen.filter((c) => r.columns.includes(c)).length > 0
      ? chosen.filter((c) => r.columns.includes(c))
      : r.columns
  const groupSource = raw.group !== undefined ? multi(raw.group) : (saved?.grouping.cols ?? [])
  const groupBy = groupSource.filter((c) => r.columns.includes(c)).slice(0, 2)
  const totalKeys = Object.keys(r.totals).filter((k) => visible.includes(k))

  // grouped rows: level 1 → (level 2 →) rows, in first-seen value order after
  // a stable sort by the grouping values
  const sorted =
    groupBy.length === 0
      ? r.rows
      : [...r.rows].sort((a, b) => {
          for (const g of groupBy) {
            const cmp = String(a[g] ?? '').localeCompare(String(b[g] ?? ''))
            if (cmp !== 0) return cmp
          }
          return 0
        })
  const level1 = new Map<string, Row[]>()
  for (const row of sorted) {
    const k1 = groupBy.length > 0 ? String(row[groupBy[0]] ?? '—') : ''
    if (!level1.has(k1)) level1.set(k1, [])
    level1.get(k1)!.push(row)
  }

  const cellClass = 'py-1 pr-3 align-top'
  const dataRow = (row: Row, i: number) => (
    <tr key={`r${i}`} className="border-t border-neutral-100">
      {visible.map((c) => (
        <td key={c} className={`${cellClass} ${typeof row[c] === 'number' ? 'tabular-nums' : ''}`}>
          {fmtCell(c, row[c])}
        </td>
      ))}
    </tr>
  )
  const subtotalRow = (label: string, rows: Row[], keyPrefix: string, strong = false) => (
    <tr key={`${keyPrefix}-st`} className={`border-t border-neutral-200 ${strong ? 'bg-neutral-100' : 'bg-neutral-50'}`}>
      {visible.map((c, i) => (
        <td key={c} className={`${cellClass} text-xs ${strong ? 'font-semibold' : 'font-medium'} text-neutral-600`}>
          {i === 0
            ? `${label} — ${rows.length} row(s)`
            : totalKeys.includes(c)
              ? sumOf(rows, c).toFixed(2)
              : ''}
        </td>
      ))}
    </tr>
  )

  const bodyRows: ReactNode[] = []
  if (groupBy.length === 0) {
    sorted.forEach((row, i) => bodyRows.push(dataRow(row, i)))
  } else {
    let n = 0
    for (const [k1, rows1] of level1) {
      bodyRows.push(
        <tr key={`g1-${k1}`} className="border-t border-neutral-300 bg-neutral-100">
          <td colSpan={visible.length} className="py-1.5 pr-3 text-sm font-semibold text-neutral-800">
            {groupBy[0].replace(/_/g, ' ')}: {k1}
          </td>
        </tr>,
      )
      if (groupBy.length === 2) {
        const level2 = new Map<string, Row[]>()
        for (const row of rows1) {
          const k2 = String(row[groupBy[1]] ?? '—')
          if (!level2.has(k2)) level2.set(k2, [])
          level2.get(k2)!.push(row)
        }
        for (const [k2, rows2] of level2) {
          bodyRows.push(
            <tr key={`g2-${k1}-${k2}`} className="border-t border-neutral-200 bg-neutral-50">
              <td colSpan={visible.length} className="py-1 pl-4 pr-3 text-xs font-medium text-neutral-600">
                {groupBy[1].replace(/_/g, ' ')}: {k2}
              </td>
            </tr>,
          )
          rows2.forEach((row) => bodyRows.push(dataRow(row, n++)))
          bodyRows.push(subtotalRow(`Subtotal ${k2}`, rows2, `g2-${k1}-${k2}`))
        }
      } else {
        rows1.forEach((row) => bodyRows.push(dataRow(row, n++)))
      }
      bodyRows.push(subtotalRow(`Subtotal ${k1}`, rows1, `g1-${k1}`, true))
    }
  }

  const colsValue = visible.join(',')
  const groupValue = groupBy.join(',')
  const filterHidden = (
    <>
      <input type="hidden" name="key" value={key} />
      {filters.periodStart ? <input type="hidden" name="period_start" value={filters.periodStart} /> : null}
      {filters.periodEnd ? <input type="hidden" name="period_end" value={filters.periodEnd} /> : null}
      {filters.practiceArea ? <input type="hidden" name="practice_area" value={String(filters.practiceArea)} /> : null}
      {filters.office ? <input type="hidden" name="office" value={String(filters.office)} /> : null}
    </>
  )

  return (
    <Page
      title={saved ? `${saved.name} — ${r.title}` : r.title}
      lead={
        <span>
          Ran at {r.ranAt.slice(0, 19).replace('T', ' ')}
          {r.ownFiguresScope ? ' — scoped to your own figures' : ''} ·{' '}
          <RowLink href="/reports">Back to the catalogue</RowLink> ·{' '}
          <RowLink href="/dashboard">Dashboard</RowLink>
        </span>
      }
    >
      <Notices searchParams={sp} />

      <Panel title="Filters & layout">
        <form method="get" className="text-sm">
          {sp.saved ? <input type="hidden" name="saved" value={sp.saved} /> : null}
          <div className="flex flex-wrap items-end gap-3">
            <Field label="From">
              <TextInput type="date" name="period_start" defaultValue={filters.periodStart ?? ''} />
            </Field>
            <Field label="To">
              <TextInput type="date" name="period_end" defaultValue={filters.periodEnd ?? ''} />
            </Field>
            <Field label="Practice area">
              <Select name="practice_area" defaultValue={filters.practiceArea ? String(filters.practiceArea) : ''}>
                <option value="">All</option>
                {ctx.practiceAreas.map((a) => (
                  <option key={a.id} value={String(a.id)}>
                    {String(a.name)}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="Office">
              <Select name="office" defaultValue={filters.office ? String(filters.office) : ''}>
                <option value="">All</option>
                {ctx.offices.map((o) => (
                  <option key={o.id} value={String(o.id)}>
                    {String(o.name)}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="Group by">
              <Select name="group" defaultValue={groupBy[0] ?? ''}>
                <option value="">No grouping</option>
                {r.columns.map((c) => (
                  <option key={c} value={c}>
                    {c.replace(/_/g, ' ')}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="Then by">
              <Select name="group" defaultValue={groupBy[1] ?? ''}>
                <option value="">—</option>
                {r.columns.map((c) => (
                  <option key={c} value={c}>
                    {c.replace(/_/g, ' ')}
                  </option>
                ))}
              </Select>
            </Field>
          </div>
          <div className="mt-1 flex flex-wrap items-center gap-3">
            <span className="text-xs font-medium text-neutral-500">Columns:</span>
            {r.columns.map((c) => (
              <label key={c} className="flex items-center gap-1 text-xs text-neutral-700">
                <input type="checkbox" name="cols" value={c} defaultChecked={visible.includes(c)} className="h-3.5 w-3.5" />
                {c.replace(/_/g, ' ')}
              </label>
            ))}
            <SubmitButton tone="quiet">Apply</SubmitButton>
          </div>
        </form>
      </Panel>

      <Panel title={`${r.rows.length} row(s)`}>
        {r.rows.length === 0 ? (
          <EmptyState>No records match — widen the filters.</EmptyState>
        ) : (
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-xs uppercase tracking-wide text-neutral-400">
                {visible.map((c) => (
                  <th key={c} className="py-1 pr-3">
                    {c.replace(/_/g, ' ')}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>{bodyRows}</tbody>
          </table>
        )}
        {Object.keys(r.totals).length > 0 ? (
          <p className="mt-2 text-sm text-neutral-700">
            {Object.entries(r.totals).map(([k, v]) => (
              <span key={k} className="mr-4">
                {k.replace(/_/g, ' ')}: <strong className="tabular-nums">{v.toFixed(2)}</strong>
              </span>
            ))}
          </p>
        ) : null}
      </Panel>

      <div className="grid gap-4 md:grid-cols-3">
        <Panel title="Save">
          <form action={saveReportAction} className="text-sm">
            {filterHidden}
            <input type="hidden" name="cols" value={colsValue} />
            <input type="hidden" name="group" value={groupValue} />
            <Field label="Name">
              <TextInput name="name" placeholder="e.g. My monthly list" required />
            </Field>
            <label className="mb-3 flex items-center gap-2 text-sm text-neutral-700">
              <input type="checkbox" name="shared" value="on" className="h-4 w-4" />
              Share with the firm
            </label>
            <SubmitButton>Save with these filters & layout</SubmitButton>
          </form>
        </Panel>
        <Panel title="Export">
          <form action={exportReportAction} className="text-sm">
            {filterHidden}
            <Field label="Format" hint="The stored artefact is the engine's exact copy — data rows only.">
              <Select name="format" defaultValue="csv">
                <option value="csv">CSV</option>
                <option value="spreadsheet">Spreadsheet</option>
                <option value="pdf">PDF</option>
              </Select>
            </Field>
            <SubmitButton tone="quiet">Export & record</SubmitButton>
          </form>
        </Panel>
        <Panel title="Schedule">
          {ctx.schedulable ? (
            <form action={scheduleReportAction} className="text-sm">
              <input type="hidden" name="key" value={key} />
              <Field label="Every">
                <Select name="every" defaultValue="week">
                  <option value="day">Day</option>
                  <option value="week">Week</option>
                  <option value="month">Month</option>
                </Select>
              </Field>
              <Field label="Format">
                <Select name="format" defaultValue="csv">
                  <option value="csv">CSV</option>
                  <option value="spreadsheet">Spreadsheet</option>
                  <option value="pdf">PDF</option>
                </Select>
              </Field>
              <Field label="Recipient" hint="Each recipient's copy runs under their own visibility.">
                <Select name="recipient" defaultValue={String(p.id)}>
                  {ctx.staff.map((s) => (
                    <option key={s.id} value={String(s.id)}>
                      {personName(s.person_name)}
                    </option>
                  ))}
                </Select>
              </Field>
              <SubmitButton tone="quiet">Create schedule</SubmitButton>
            </form>
          ) : (
            <p className="text-sm text-neutral-500">This report is not schedulable.</p>
          )}
        </Panel>
      </div>
    </Page>
  )
}
