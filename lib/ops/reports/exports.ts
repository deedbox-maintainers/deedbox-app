// Report export, saved report variants, and target sets. An export is a
// privileged event: the exact generated artefact is stored and the register
// entry carries who, what, the format, the filters, and the
// restricted-matter count the anomaly rules read. CSV is machine-clean —
// data rows only.

import type { Principal, Tx } from '@/lib/db'
import { withPrincipal, emitRegister, OperationRefused } from '@/lib/db'
import { requireStaff, requireCapability, hasCapability } from '@/lib/ops/shared'
import { createHash } from 'node:crypto'
import { runReportInTx, type ReportFilters, type ReportResult } from './engine'

function csvOf(result: ReportResult): string {
  const esc = (v: unknown): string => {
    const s = v === null || v === undefined ? '' : String(v)
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
  }
  const lines = [result.columns.join(',')]
  for (const row of result.rows) {
    lines.push(result.columns.map((c) => esc(row[c])).join(','))
  }
  return lines.join('\n')
}

/** Distinct restricted matters, visible to the exporter, in the rows. */
async function restrictedCountInTx(tx: Tx, rows: Record<string, unknown>[]): Promise<number> {
  const matters = [...new Set(rows.map((r) => r.matter).filter((m) => typeof m === 'number'))]
  if (matters.length === 0) return 0
  const r = await tx.query(
    `select count(*)::int as n from deedbox.matter where id = any($1) and restricted`,
    [matters],
  )
  return r.rows[0].n as number
}

/** Export a report; the artefact is the exact generated copy. */
export async function exportReport(
  p: Principal,
  input: {
    key: string
    format: 'csv' | 'spreadsheet' | 'pdf'
    filters?: ReportFilters
    savedReport?: number
  },
): Promise<{ artefact: number; rows: number; restrictedMatters: number }> {
  requireStaff(p)
  return withPrincipal(p, async (tx) => {
    let filters = input.filters ?? {}
    let savedName: string | null = null
    if (input.savedReport !== undefined) {
      const saved = await loadSavedInTx(tx, p, input.savedReport)
      filters = { ...(saved.filters as ReportFilters), ...filters }
      savedName = saved.name
    }
    const result = await runReportInTx(tx, p, input.key, filters)
    const content =
      input.format === 'csv'
        ? csvOf(result)
        : JSON.stringify({ format: input.format, ...result })
    const contentType = input.format === 'csv' ? 'text/csv' : 'application/json'
    const artefact = await tx.query(
      `insert into deedbox.stored_artefact (kind, content_ref, content_hash, content_type, size_bytes)
       values ('report_export', $1, $2, $3, $4) returning id`,
      [content, createHash('sha256').update(content).digest('hex'), contentType, Buffer.byteLength(content)],
    )
    const restricted = await restrictedCountInTx(tx, result.rows)
    await emitRegister(tx, p, {
      kind: 'export.performed',
      subjectType: 'report_export',
      subject: artefact.rows[0].id as number,
      privileged: true,
      artefact: String(artefact.rows[0].id),
      detail: {
        before: null,
        after: {
          report: input.key,
          saved_report: savedName,
          format: input.format,
          filters,
          rows: result.rows.length,
          restricted_matters: restricted,
        },
      },
    })
    return {
      artefact: artefact.rows[0].id as number,
      rows: result.rows.length,
      restrictedMatters: restricted,
    }
  })
}

interface SavedRow {
  id: number
  definitionKey: string
  name: string
  owner: number
  shared: boolean
  filters: unknown
  columns: string[]
  grouping: { cols?: string[] }
}

async function loadSavedInTx(tx: Tx, p: Principal, id: number): Promise<SavedRow> {
  const r = await tx.query(
    `select sr.id, rd.key, sr.name, sr.owner, sr.shared, sr.filters, sr.columns, sr.grouping
       from deedbox.saved_report sr
       join deedbox.report_definition rd on rd.id = sr.definition
      where sr.id = $1 and sr.deleted_at is null`,
    [id],
  )
  if (r.rowCount === 0) throw new OperationRefused('not_found', 'saved report not found')
  const row = r.rows[0]
  if (row.owner !== p.id && !row.shared) {
    throw new OperationRefused('not_shared', 'this saved report is private to its owner')
  }
  return {
    id: row.id as number,
    definitionKey: row.key as string,
    name: row.name as string,
    owner: row.owner as number,
    shared: row.shared as boolean,
    filters: row.filters,
    columns: Array.isArray(row.columns) ? (row.columns as string[]) : [],
    grouping: (row.grouping ?? {}) as { cols?: string[] },
  }
}

/** The saved row itself (name, filters, columns, grouping) — the viewer's
 *  ?saved= path renders the saved layout around the standard run. */
export async function savedReportView(p: Principal, id: number): Promise<SavedRow> {
  requireStaff(p)
  return withPrincipal(p, async (tx) => loadSavedInTx(tx, p, id), { readOnly: true })
}

/** Save a report variant. */
export async function saveReport(
  p: Principal,
  input: {
    key: string
    name: string
    filters?: ReportFilters
    shared?: boolean
    /** chosen column subset, in display order; empty = the definition's own */
    columns?: string[]
    /** grouping columns — at most two levels are allowed */
    groupBy?: string[]
  },
): Promise<{ id: number }> {
  requireStaff(p)
  if (!input.name.trim()) throw new OperationRefused('name_required', 'a saved report carries a name')
  if ((input.groupBy ?? []).length > 2) {
    throw new OperationRefused('grouping_depth', 'a saved report groups by at most two levels')
  }
  return withPrincipal(p, async (tx) => {
    // the owner must be able to run it
    await runReportInTx(tx, p, input.key, input.filters ?? {})
    const def = await tx.query(`select id from deedbox.report_definition where key = $1`, [
      input.key,
    ])
    const r = await tx.query(
      `insert into deedbox.saved_report
         (definition, name, owner, shared, columns, filters, grouping, sort)
       values ($1, $2, $3, $4, $6, $5, $7, '{}') returning id`,
      [
        def.rows[0].id,
        input.name,
        p.id,
        input.shared ?? false,
        JSON.stringify(input.filters ?? {}),
        JSON.stringify(input.columns ?? []),
        JSON.stringify(input.groupBy && input.groupBy.length > 0 ? { cols: input.groupBy } : {}),
      ],
    )
    await emitRegister(tx, p, {
      kind: 'record.created',
      subjectType: 'saved_report',
      subject: r.rows[0].id as number,
      detail: { report: input.key, name: input.name, shared: input.shared ?? false },
    })
    return { id: r.rows[0].id as number }
  })
}

/** Run a report over a saved variant. */
export async function runSavedReport(
  p: Principal,
  input: { savedReport: number; filters?: ReportFilters },
): Promise<ReportResult> {
  requireStaff(p)
  return withPrincipal(
    p,
    async (tx) => {
      const saved = await loadSavedInTx(tx, p, input.savedReport)
      return runReportInTx(tx, p, saved.definitionKey, {
        ...(saved.filters as ReportFilters),
        ...(input.filters ?? {}),
      })
    },
    { readOnly: true },
  )
}

/** Replace a subject's target set, one registered act. */
export async function replaceTargets(
  p: Principal,
  input: {
    subjectKind: 'staff' | 'group'
    subject: number
    targets: {
      metric: 'hours_worked' | 'billable_hours' | 'amount_billed' | 'amount_collected'
      amount: number
      periodKind: 'week' | 'month' | 'quarter' | 'year' | 'custom'
      periodStart: string
      periodEnd?: string
    }[]
  },
): Promise<void> {
  await withPrincipal(p, async (tx) => {
    await requireCapability(tx, p, 'settings.manage')
    const before = await tx.query(
      `select metric, amount, period_kind, period_start::text as period_start
         from deedbox.performance_target
        where subject_kind = $1 and subject = $2 and deleted_at is null order by id`,
      [input.subjectKind, input.subject],
    )
    await tx.query(
      `update deedbox.performance_target set deleted_at = now(), deleted_by = $3
        where subject_kind = $1 and subject = $2 and deleted_at is null`,
      [input.subjectKind, input.subject, p.id],
    )
    for (const t of input.targets) {
      if ((t.periodKind === 'custom') !== (t.periodEnd !== undefined)) {
        throw new OperationRefused('bad_period', 'custom periods carry an end date; others never do')
      }
      await tx.query(
        `insert into deedbox.performance_target
           (subject_kind, subject, metric, amount, period_kind, period_start, period_end)
         values ($1, $2, $3, $4, $5, $6::date, $7::date)`,
        [
          input.subjectKind,
          input.subject,
          t.metric,
          t.amount,
          t.periodKind,
          t.periodStart,
          t.periodEnd ?? null,
        ],
      )
    }
    await emitRegister(tx, p, {
      kind: 'record.changed',
      subjectType: 'performance_target',
      subject: input.subject,
      detail: { subject_kind: input.subjectKind, before: before.rows, after: input.targets },
    })
  })
}

/** Viewing another person's targets requires the firm-financial right. */
export async function listTargets(
  p: Principal,
  input: { subjectKind: 'staff' | 'group'; subject: number },
): Promise<{ targets: Record<string, unknown>[] }> {
  requireStaff(p)
  return withPrincipal(
    p,
    async (tx) => {
      if (!(input.subjectKind === 'staff' && input.subject === p.id)) {
        if (!(await hasCapability(tx, p.id, 'report.firm_financial'))) {
          throw new OperationRefused('not_visible', "others' targets need report.firm_financial")
        }
      }
      const r = await tx.query(
        `select metric, amount, period_kind, period_start::text as period_start, period_end::text as period_end
           from deedbox.performance_target
          where subject_kind = $1 and subject = $2 and deleted_at is null order by period_start desc`,
        [input.subjectKind, input.subject],
      )
      return { targets: r.rows }
    },
    { readOnly: true },
  )
}
