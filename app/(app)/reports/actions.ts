'use server'

// Report actions: save, export (artefact + privileged register entry with
// the restricted-matter count — the operation's own discipline), schedule,
// pause/resume, and targets replacement.

import { act } from '@/lib/screens/action'
import {
  saveReport,
  exportReport,
  createReportSchedule,
  setSchedulePaused,
  replaceTargets,
} from '@/lib/ops/reports'
import { parse } from '@/components/forms'

export async function saveReportAction(formData: FormData): Promise<void> {
  const key = parse.str(formData, 'key')
  await act(`/reports/${key}`, async (p) => {
    const list = (k: string) =>
      (parse.strOrNull(formData, k) ?? '').split(',').map((s) => s.trim()).filter(Boolean)
    const cols = list('cols')
    const group = list('group')
    const r = await saveReport(p, {
      key,
      name: parse.str(formData, 'name'),
      shared: parse.str(formData, 'shared') === 'on',
      filters: {
        periodStart: parse.strOrNull(formData, 'period_start') ?? undefined,
        periodEnd: parse.strOrNull(formData, 'period_end') ?? undefined,
        practiceArea: parse.numOrNull(formData, 'practice_area') ?? undefined,
        office: parse.numOrNull(formData, 'office') ?? undefined,
      },
      columns: cols.length > 0 ? cols : undefined,
      groupBy: group.length > 0 ? group : undefined,
    })
    return `Saved as #${r.id} — it runs with these filters and this layout from the catalogue.`
  })
}

export async function exportReportAction(formData: FormData): Promise<void> {
  const key = parse.str(formData, 'key')
  await act(`/reports/${key}`, async (p) => {
    const r = await exportReport(p, {
      key,
      format: (parse.strOrNull(formData, 'format') as 'csv' | 'spreadsheet' | 'pdf') ?? 'csv',
      filters: {
        periodStart: parse.strOrNull(formData, 'period_start') ?? undefined,
        periodEnd: parse.strOrNull(formData, 'period_end') ?? undefined,
        practiceArea: parse.numOrNull(formData, 'practice_area') ?? undefined,
        office: parse.numOrNull(formData, 'office') ?? undefined,
      },
    })
    return `Exported ${r.rows} row(s) — stored artefact #${r.artefact}; the export is recorded with its restricted-matter count (${r.restrictedMatters}).`
  })
}

export async function scheduleReportAction(formData: FormData): Promise<void> {
  const key = parse.str(formData, 'key')
  await act(`/reports/${key}`, async (p) => {
    const r = await createReportSchedule(p, {
      reportKind: 'standard',
      report: key,
      period: { every: (parse.strOrNull(formData, 'every') as 'day' | 'week' | 'month') ?? 'week' },
      format: (parse.strOrNull(formData, 'format') as 'csv' | 'spreadsheet' | 'pdf') ?? 'csv',
      recipients: [{ staff: parse.num(formData, 'recipient') }],
    })
    return `goto:/reports/schedules?done=${encodeURIComponent(`Schedule #${r.id} created.`)}`
  })
}

export async function pauseScheduleAction(formData: FormData): Promise<void> {
  await act('/reports/schedules', async (p) => {
    await setSchedulePaused(p, {
      schedule: parse.num(formData, 'schedule'),
      paused: parse.str(formData, 'paused') === 'true',
      reason: parse.strOrNull(formData, 'reason') ?? undefined,
    })
    return 'Schedule updated.'
  })
}

export async function replaceTargetsAction(formData: FormData): Promise<void> {
  await act('/reports/targets', async (p) => {
    const metrics = formData.getAll('metric').map(String)
    const amounts = formData.getAll('amount').map(String)
    const targets = metrics
      .map((m, i) => ({
        metric: m as 'hours_worked' | 'billable_hours' | 'amount_billed' | 'amount_collected',
        amount: Number(amounts[i] ?? 0),
        periodKind: (parse.strOrNull(formData, 'period_kind') as 'week' | 'month' | 'quarter' | 'year') ?? 'month',
        periodStart: parse.str(formData, 'period_start'),
      }))
      .filter((t) => t.amount > 0)
    await replaceTargets(p, {
      subjectKind: (parse.strOrNull(formData, 'subject_kind') as 'staff' | 'group') ?? 'staff',
      subject: parse.num(formData, 'subject'),
      targets,
    })
    return `Targets replaced — ${targets.length} in force. Targets feed reporting only.`
  })
}
