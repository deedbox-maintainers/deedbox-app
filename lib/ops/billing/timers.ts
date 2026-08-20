// Timers. Ephemeral, owner-only; stop computes units (round up,
// minimum one) and runs the full time-entry creation path
// (createTimeEntryInTx) in one transaction, then hard-deletes the
// timer (the sanctioned hard delete).

import type { Principal, Tx } from '@/lib/db'
import { withPrincipal, OperationRefused } from '@/lib/db'
import { requireStaff, settingText } from '@/lib/ops/shared'
import { createTimeEntryInTx } from './timeEntries'

async function ownTimer(tx: Tx, p: Principal, timerId: number) {
  const r = await tx.query(
    `select * from deedbox.timer where id = $1 for update`,
    [timerId],
  )
  if (r.rowCount === 0) throw new OperationRefused('not_found', 'timer not found')
  if (r.rows[0].staff !== p.id) {
    throw new OperationRefused('not_yours', 'a timer answers to its owner alone')
  }
  return r.rows[0]
}

export async function startTimer(
  p: Principal,
  input: { matter?: number; narrativeDraft?: string },
): Promise<{ id: number }> {
  requireStaff(p)
  return withPrincipal(p, async (tx) => {
    const r = await tx.query(
      `insert into deedbox.timer (staff, matter, narrative_draft)
       values ($1, $2, $3) returning id`,
      [p.id, input.matter ?? null, input.narrativeDraft ?? null],
    )
    return { id: r.rows[0].id as number }
  })
}

export async function pauseTimer(p: Principal, input: { timer: number }): Promise<void> {
  requireStaff(p)
  await withPrincipal(p, async (tx) => {
    const t = await ownTimer(tx, p, input.timer)
    if (t.state !== 'running') throw new OperationRefused('not_running', 'the timer is not running')
    await tx.query(
      `update deedbox.timer
          set state = 'paused',
              accumulated_seconds = accumulated_seconds
                + greatest(0, extract(epoch from now() - started_at))::int
        where id = $1`,
      [input.timer],
    )
  })
}

export async function resumeTimer(p: Principal, input: { timer: number }): Promise<void> {
  requireStaff(p)
  await withPrincipal(p, async (tx) => {
    const t = await ownTimer(tx, p, input.timer)
    if (t.state !== 'paused') throw new OperationRefused('not_paused', 'the timer is not paused')
    await tx.query(
      `update deedbox.timer set state = 'running', started_at = now() where id = $1`,
      [input.timer],
    )
  })
}

export async function stopTimer(
  p: Principal,
  input: { timer: number; matter?: number; narrative?: string; workDate?: string; rateLabel?: string; manualRate?: number },
): Promise<{ entry: number; value: number }> {
  requireStaff(p)
  return withPrincipal(p, async (tx) => {
    const t = await ownTimer(tx, p, input.timer)
    const matter = input.matter ?? (t.matter as number | null)
    if (matter === null) {
      throw new OperationRefused('matter_required', 'stopping a timer needs the matter it worked')
    }
    const narrative = input.narrative ?? (t.narrative_draft as string | null)
    if (!narrative || !narrative.trim()) {
      throw new OperationRefused('narrative_required', 'stopping a timer needs its narrative')
    }
    const secs = await tx.query(
      `select accumulated_seconds
              + case when state = 'running'
                     then greatest(0, extract(epoch from now() - started_at))::int
                     else 0 end as total
         from deedbox.timer where id = $1`,
      [input.timer],
    )
    const totalSeconds = Number(secs.rows[0].total)
    const unitMinutes = Number((await settingText(tx, 'time.unit_minutes')) ?? '6')
    const units = Math.max(1, Math.ceil(totalSeconds / 60 / unitMinutes))

    // today in the firm's own timezone — a late-evening stop must not date
    // the work tomorrow (or yesterday) by the server's clock
    const today = await tx.query(
      `select (now() at time zone (select timezone from deedbox.firm order by id limit 1))::date::text as d`,
    )
    const entry = await createTimeEntryInTx(tx, p, {
      matter,
      workDate: input.workDate ?? (today.rows[0].d as string),
      units,
      narrative,
      origin: 'timer',
      rateLabel: input.rateLabel,
      manualRate: input.manualRate,
    })
    await tx.query(`delete from deedbox.timer where id = $1`, [input.timer])
    return { entry: entry.id, value: entry.value }
  })
}

export async function discardTimer(p: Principal, input: { timer: number }): Promise<void> {
  requireStaff(p)
  await withPrincipal(p, async (tx) => {
    await ownTimer(tx, p, input.timer)
    await tx.query(`delete from deedbox.timer where id = $1`, [input.timer])
  })
}
