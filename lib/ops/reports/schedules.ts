// Report schedules and the scheduled send job: per due schedule, per
// active recipient, ONE unit — the report runs under THAT recipient's
// predicate and role at that moment, renders, stores its artefact,
// registers export.performed with the schedule as the "who" and the
// recipient named, and queues the outbound copy — one transaction per
// recipient, so one failure never blocks the rest. Skips (deactivated, or
// no longer visible) are noted; zero active recipients auto-pauses the
// schedule with the owner notified.

import type { Principal, Tx } from '@/lib/db'
import { withPrincipal, emitRegister, OperationRefused } from '@/lib/db'
import { requireStaff, hasCapability } from '@/lib/ops/shared'
import { createHash } from 'node:crypto'
import { runReportInTx, loadDefinitionInTx, type ReportFilters } from './engine'

/** Create a schedule with its recipients. */
export async function createReportSchedule(
  p: Principal,
  input: {
    reportKind: 'standard' | 'saved'
    report: number | string
    period: { every: 'day' | 'week' | 'month' }
    format: 'csv' | 'spreadsheet' | 'pdf'
    recipients: { staff: number; deliveryAddress?: string }[]
    firstRunAt?: string
  },
): Promise<{ id: number }> {
  requireStaff(p)
  if (input.recipients.length === 0) {
    throw new OperationRefused('recipients_required', 'a schedule carries at least one recipient')
  }
  return withPrincipal(p, async (tx) => {
    let reportId: number
    if (input.reportKind === 'standard') {
      const def = await loadDefinitionInTx(tx, String(input.report))
      if (!def.schedulable) {
        throw new OperationRefused('not_schedulable', 'this report does not schedule')
      }
      reportId = def.id
    } else {
      const saved = await tx.query(
        `select id, owner, shared from deedbox.saved_report where id = $1 and deleted_at is null`,
        [Number(input.report)],
      )
      if (saved.rowCount === 0) throw new OperationRefused('not_found', 'saved report not found')
      reportId = saved.rows[0].id as number
    }
    const selfOnly =
      input.recipients.length === 1 && input.recipients[0].staff === p.id
    if (!selfOnly && !(await hasCapability(tx, p.id, 'report.schedule_manage'))) {
      throw new OperationRefused(
        'capability_missing',
        'scheduling for others requires report.schedule_manage',
      )
    }
    for (const rcpt of input.recipients) {
      const active = await tx.query(
        `select 1 from deedbox.staff_member where id = $1 and active`,
        [rcpt.staff],
      )
      if (active.rowCount === 0) {
        throw new OperationRefused('recipient_inactive', `staff ${rcpt.staff} is not active`)
      }
    }
    const s = await tx.query(
      `insert into deedbox.report_schedule
         (report_kind, report, period, format, owner, next_run_at)
       values ($1, $2, $3, $4, $5, coalesce($6::timestamptz, now())) returning id`,
      [
        input.reportKind,
        reportId,
        JSON.stringify(input.period),
        input.format,
        p.id,
        input.firstRunAt ?? null,
      ],
    )
    for (const rcpt of input.recipients) {
      await tx.query(
        `insert into deedbox.schedule_recipient (schedule, staff, delivery_address)
         values ($1, $2, $3)`,
        [s.rows[0].id, rcpt.staff, rcpt.deliveryAddress ?? null],
      )
    }
    await emitRegister(tx, p, {
      kind: 'record.created',
      subjectType: 'report_schedule',
      subject: s.rows[0].id as number,
      detail: {
        report_kind: input.reportKind,
        report: reportId,
        recipients: input.recipients.map((r) => r.staff),
      },
    })
    return { id: s.rows[0].id as number }
  })
}

/** Pause / resume a schedule. */
export async function setSchedulePaused(
  p: Principal,
  input: { schedule: number; paused: boolean; reason?: string },
): Promise<void> {
  requireStaff(p)
  await withPrincipal(p, async (tx) => {
    const s = await tx.query(
      `select id, owner, active from deedbox.report_schedule where id = $1 for update`,
      [input.schedule],
    )
    if (s.rowCount === 0) throw new OperationRefused('not_found', 'schedule not found')
    if (s.rows[0].owner !== p.id && !(await hasCapability(tx, p.id, 'report.schedule_manage'))) {
      throw new OperationRefused('not_owner', "another owner's schedule needs report.schedule_manage")
    }
    if (input.paused === !(s.rows[0].active as boolean)) {
      throw new OperationRefused('no_change', 'the schedule is already in that state')
    }
    if (!input.paused) {
      const recipients = await tx.query(
        `select count(*)::int as n from deedbox.schedule_recipient sr
          join deedbox.staff_member st on st.id = sr.staff and st.active
         where sr.schedule = $1`,
        [input.schedule],
      )
      if ((recipients.rows[0].n as number) === 0) {
        throw new OperationRefused('recipients_required', 'resume needs at least one active recipient')
      }
    }
    await tx.query(
      `update deedbox.report_schedule set active = $2, paused_reason = $3 where id = $1`,
      [input.schedule, !input.paused, input.paused ? (input.reason ?? 'paused') : null],
    )
    await emitRegister(tx, p, {
      kind: 'record.changed',
      subjectType: 'report_schedule',
      subject: input.schedule,
      detail: { before: { active: s.rows[0].active }, after: { active: !input.paused } },
    })
  })
}

async function nextRunSqlInTx(tx: Tx, period: { every: string }): Promise<string> {
  const step = period.every === 'day' ? '1 day' : period.every === 'week' ? '7 days' : '1 month'
  const r = await tx.query(`select (now() + $1::interval)::text as t`, [step])
  return r.rows[0].t as string
}

export interface ScheduleRunOutcome {
  schedule: number
  sent: number[]
  skipped: { staff: number; reason: string }[]
  autoPaused: boolean
}

/** The scheduled send job's body (one due schedule per call set). */
export async function runDueSchedules(p: Principal): Promise<ScheduleRunOutcome[]> {
  const due = await withPrincipal(
    p,
    async (tx) => {
      const r = await tx.query(
        `select s.id from deedbox.report_schedule s
          where s.active and s.next_run_at <= now() order by s.next_run_at`,
      )
      return r.rows.map((x) => x.id as number)
    },
    { readOnly: true },
  )
  const outcomes: ScheduleRunOutcome[] = []
  for (const scheduleId of due) {
    const meta = await withPrincipal(
      p,
      async (tx) => {
        const s = await tx.query(
          `select s.id, s.report_kind, s.report, s.period, s.format, s.owner,
                  case when s.report_kind = 'standard'
                       then (select rd.key from deedbox.report_definition rd where rd.id = s.report)
                       else (select rd2.key from deedbox.saved_report sr
                              join deedbox.report_definition rd2 on rd2.id = sr.definition
                             where sr.id = s.report) end as report_key,
                  case when s.report_kind = 'saved'
                       then (select sr.filters from deedbox.saved_report sr where sr.id = s.report) end as saved_filters
             from deedbox.report_schedule s where s.id = $1`,
          [scheduleId],
        )
        const recipients = await tx.query(
          `select sr.staff, sr.delivery_address, st.active, st.email
             from deedbox.schedule_recipient sr
             join deedbox.staff_member st on st.id = sr.staff
            where sr.schedule = $1 order by sr.id`,
          [scheduleId],
        )
        return { s: s.rows[0], recipients: recipients.rows }
      },
      { readOnly: true },
    )
    const outcome: ScheduleRunOutcome = { schedule: scheduleId, sent: [], skipped: [], autoPaused: false }
    const activeRecipients = meta.recipients.filter((r) => r.active)
    for (const rcpt of meta.recipients) {
      if (!rcpt.active) {
        outcome.skipped.push({ staff: rcpt.staff as number, reason: 'recipient deactivated' })
        continue
      }
      try {
        // the unit's TRANSACTION opens as the recipient so the row-security
        // predicate is genuinely theirs; the register entry below still
        // names the schedule's run (the job principal) as the actor
        const recipientPrincipal: Principal = { kind: 'staff', id: rcpt.staff as number, firm: p.firm }
        await withPrincipal(recipientPrincipal, async (tx) => {
          const result = await runReportInTx(
            tx,
            recipientPrincipal,
            meta.s.report_key as string,
            (meta.s.saved_filters ?? {}) as ReportFilters,
          )
          const content = JSON.stringify({ format: meta.s.format, ...result })
          const artefact = await tx.query(
            `insert into deedbox.stored_artefact (kind, content_ref, content_hash, content_type, size_bytes)
             values ('scheduled_report', $1, $2, 'application/json', $3) returning id`,
            [content, createHash('sha256').update(content).digest('hex'), Buffer.byteLength(content)],
          )
          const matters = [...new Set(result.rows.map((r) => r.matter).filter((m) => typeof m === 'number'))]
          let restricted = 0
          if (matters.length > 0) {
            const rc = await tx.query(
              `select count(*)::int as n from deedbox.matter where id = any($1) and restricted`,
              [matters],
            )
            restricted = rc.rows[0].n as number
          }
          await emitRegister(tx, p, {
            kind: 'export.performed',
            subjectType: 'scheduled_report',
            subject: scheduleId,
            privileged: true,
            artefact: String(artefact.rows[0].id),
            detail: {
              before: null,
              after: {
                schedule: scheduleId,
                recipient: rcpt.staff,
                report: meta.s.report_key,
                rows: result.rows.length,
                restricted_matters: restricted,
              },
            },
          })
          await tx.query(
            `insert into deedbox.outbound_message
               (channel, recipient, rendered_artefact, purpose, related_type, related)
             values ('email', $1, $2, 'scheduled_report', 'report_schedule', $3)`,
            [
              (rcpt.delivery_address as string | null) ?? (rcpt.email as string),
              String(artefact.rows[0].id),
              scheduleId,
            ],
          )
        })
        outcome.sent.push(rcpt.staff as number)
      } catch (e) {
        // a recipient no longer admitted by the report's visibility skips
        outcome.skipped.push({
          staff: rcpt.staff as number,
          reason: e instanceof Error ? e.message : String(e),
        })
      }
    }
    await withPrincipal(p, async (tx) => {
      if (activeRecipients.length === 0) {
        await tx.query(
          `update deedbox.report_schedule
              set active = false, paused_reason = 'no active recipients', last_run_at = now()
            where id = $1`,
          [scheduleId],
        )
        outcome.autoPaused = true
        const owner = await tx.query(
          `select email from deedbox.staff_member where id = $1`,
          [meta.s.owner],
        )
        await tx.query(
          `insert into deedbox.outbound_message
             (channel, recipient, rendered_artefact, purpose, related_type, related)
           values ('email', $1, $2, 'schedule_paused', 'report_schedule', $3)`,
          [owner.rows[0].email, `schedule-${scheduleId}-auto-paused`, scheduleId],
        )
        await emitRegister(tx, p, {
          kind: 'record.changed',
          subjectType: 'report_schedule',
          subject: scheduleId,
          detail: { before: { active: true }, after: { active: false, paused_reason: 'no active recipients' } },
        })
      } else {
        const next = await nextRunSqlInTx(tx, meta.s.period as { every: string })
        await tx.query(
          `update deedbox.report_schedule set last_run_at = now(), next_run_at = $2::timestamptz
            where id = $1`,
          [scheduleId, next],
        )
      }
    })
    outcomes.push(outcome)
  }
  return outcomes
}
