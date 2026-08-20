// Time capture. The value formula lives in the database CHECK; the insert
// computes it in SQL so the stored figure matches the constraint to the cent.
// Narratives feed the search index by trigger — never the conflict corpus.
// Post-commit threshold evaluation belongs to the threshold job (tests invoke
// it directly until the register-driven runner lands with the jobs slice).

import type { Principal, Tx } from '@/lib/db'
import { withPrincipal, emitRegister, OperationRefused } from '@/lib/db'
import { requireStaff, hasCapability, settingText, shippedChoiceItem } from '@/lib/ops/shared'

export interface CreateTimeEntryInput {
  matter: number
  staff?: number // defaults to the acting staff member
  workDate: string
  kind?: 'timed' | 'fixed_fee'
  units?: number
  fixedAmount?: number
  narrative: string
  category?: number // choice item; defaults to the shipped chargeable item
  rateLabel?: string
  manualRate?: number
  origin?: 'manual' | 'timer' | 'suggestion' | 'import'
  suggestion?: number
}

export async function createTimeEntry(
  p: Principal,
  input: CreateTimeEntryInput,
): Promise<{ id: number; value: number }> {
  requireStaff(p)
  return withPrincipal(p, (tx) => createTimeEntryInTx(tx, p, input))
}

export async function createTimeEntryInTx(
  tx: Tx,
  p: Principal,
  input: CreateTimeEntryInput,
): Promise<{ id: number; value: number }> {
  if (!input.narrative.trim()) {
    throw new OperationRefused('narrative_required', 'a time entry carries a narrative')
  }
  const staffId = input.staff ?? p.id
  if (staffId !== p.id && (input.origin ?? 'manual') === 'manual') {
    // recording another person's time BY HAND is a granted permission (0053).
    // The other origins carry their own gates: imports run under
    // import.execute, suggestions under their ownership rules, and timers
    // never record for anyone else.
    if (!(await hasCapability(tx, p.id, 'time.record_for_others'))) {
      throw new OperationRefused(
        'not_permitted',
        'recording time for another staff member needs the time.record_for_others capability',
      )
    }
    const target = await tx.query(`select active from deedbox.staff_member where id = $1`, [staffId])
    if (target.rowCount === 0 || !target.rows[0].active) {
      throw new OperationRefused('not_found', 'no active staff member by that id')
    }
  }
  const kind = input.kind ?? 'timed'

  const m = await tx.query(`select status from deedbox.matter where id = $1`, [input.matter])
  if (m.rowCount === 0) throw new OperationRefused('not_found', 'matter not found')
  if (m.rows[0].status === 'closed' || m.rows[0].status === 'archived') {
    if (!(await hasCapability(tx, p.id, 'matter.edit_closed'))) {
      throw new OperationRefused('matter_closed', 'this matter is closed; recording needs matter.edit_closed')
    }
  }

  const category =
    input.category ?? (await shippedChoiceItem(tx, 'time_categories', 'chargeable'))

  let id: number
  let value: number
  if (kind === 'timed') {
    if (!input.units || input.units <= 0) {
      throw new OperationRefused('units_required', 'a timed entry needs units above zero')
    }
    const unitMinutes = Number((await settingText(tx, 'time.unit_minutes')) ?? '6')
    let rate: number
    let rateSource: string
    if (input.manualRate !== undefined) {
      rate = input.manualRate
      rateSource = 'manual'
    } else {
      const resolved = await tx.query(
        `select rate, rate_source from deedbox.resolve_rate($1, $2, $3, $4::date)`,
        [input.matter, staffId, input.rateLabel ?? null, input.workDate],
      )
      if (resolved.rowCount === 0 || resolved.rows[0].rate === null) {
        throw new OperationRefused(
          'no_rate',
          'no rate resolves for this staff member and date; supply one',
        )
      }
      rate = Number(resolved.rows[0].rate)
      rateSource = resolved.rows[0].rate_source as string
    }
    const r = await tx.query(
      `insert into deedbox.time_entry
         (matter, staff, work_date, kind, units, unit_minutes_applied, applied_rate,
          rate_source, value, narrative, category, origin, suggestion, created_by)
       values ($1,$2,$3::date,'timed',$4::int,$5::int,$6::numeric,$7,
               round(($4::int * $5::int * $6::numeric) / 60.0, 2), $8, $9, $10, $11, $12)
       returning id, value`,
      [
        input.matter,
        staffId,
        input.workDate,
        input.units,
        unitMinutes,
        rate,
        rateSource,
        input.narrative,
        category,
        input.origin ?? 'manual',
        input.suggestion ?? null,
        p.id,
      ],
    )
    id = r.rows[0].id as number
    value = Number(r.rows[0].value)
  } else {
    if (input.fixedAmount === undefined || input.fixedAmount < 0) {
      throw new OperationRefused('amount_required', 'a fixed-fee entry needs its amount')
    }
    const r = await tx.query(
      `insert into deedbox.time_entry
         (matter, staff, work_date, kind, fixed_amount, value, narrative, category,
          origin, suggestion, created_by)
       values ($1,$2,$3::date,'fixed_fee',$4,$4,$5,$6,$7,$8,$9)
       returning id, value`,
      [
        input.matter,
        staffId,
        input.workDate,
        input.fixedAmount,
        input.narrative,
        category,
        input.origin ?? 'manual',
        input.suggestion ?? null,
        p.id,
      ],
    )
    id = r.rows[0].id as number
    value = Number(r.rows[0].value)
  }

  // supersede overlapping pending suggestions — same staff and matter on the
  // entry's date, or the entry's own source signal; the accepting path passes
  // its own suggestion id and that row is transitioned by acceptSuggestion,
  // not superseded here
  await tx.query(
    `update deedbox.suggested_entry
        set state = 'superseded_by_manual', resolved_at = now()
      where state = 'pending' and staff = $1
        and (id is distinct from $4)
        and (matter = $2 and proposed_date = $3::date)`,
    [staffId, input.matter, input.workDate, input.suggestion ?? null],
  )

  await emitRegister(tx, p, {
    kind: 'record.created',
    subjectType: 'time_entry',
    subject: id,
    matter: input.matter,
    detail: { staff: staffId, value, kind },
  })
  return { id, value }
}

/** Unbilled: any field; on draft or billed: narrative only. */
export async function editTimeEntry(
  p: Principal,
  input: {
    entry: number
    narrative?: string
    units?: number
    workDate?: string
    rateLabel?: string
    manualRate?: number
  },
): Promise<void> {
  requireStaff(p)
  await withPrincipal(p, async (tx) => {
    const cur = await tx.query(
      `select * from deedbox.time_entry where id = $1 and deleted_at is null for update`,
      [input.entry],
    )
    if (cur.rowCount === 0) throw new OperationRefused('not_found', 'time entry not found')
    const e = cur.rows[0]

    if (e.billed_state !== 'unbilled') {
      if (
        input.units !== undefined ||
        input.workDate !== undefined ||
        input.manualRate !== undefined
      ) {
        throw new OperationRefused(
          'value_locked',
          'a drafted or billed entry changes narrative only',
        )
      }
      if (input.narrative === undefined) return
      await tx.query(`update deedbox.time_entry set narrative = $2 where id = $1`, [
        input.entry,
        input.narrative,
      ])
      await emitRegister(tx, p, {
        kind: 'record.changed',
        subjectType: 'time_entry',
        subject: input.entry,
        matter: e.matter as number,
        detail: { before: { narrative: e.narrative }, after: { narrative: input.narrative } },
      })
      return
    }

    const workDate = input.workDate ?? (e.work_date as string)
    const changes: Record<string, unknown> = {}
    if (e.kind === 'timed' && (input.units !== undefined || input.workDate !== undefined || input.manualRate !== undefined || input.rateLabel !== undefined)) {
      const units = input.units ?? (e.units as number)
      if (units <= 0) throw new OperationRefused('units_required', 'units stay above zero')
      let rate: number
      let rateSource: string
      if (input.manualRate !== undefined) {
        rate = input.manualRate
        rateSource = 'manual'
      } else {
        const resolved = await tx.query(
          `select rate, rate_source from deedbox.resolve_rate($1, $2, $3, $4::date)`,
          [e.matter, e.staff, input.rateLabel ?? null, workDate],
        )
        if (resolved.rowCount === 0 || resolved.rows[0].rate === null) {
          throw new OperationRefused('no_rate', 'no rate resolves for the new date')
        }
        rate = Number(resolved.rows[0].rate)
        rateSource = resolved.rows[0].rate_source as string
      }
      await tx.query(
        `update deedbox.time_entry
            set units = $2::int, work_date = $3::date, applied_rate = $4::numeric, rate_source = $5,
                value = round(($2::int * unit_minutes_applied * $4::numeric) / 60.0, 2),
                narrative = coalesce($6, narrative)
          where id = $1`,
        [input.entry, units, workDate, rate, rateSource, input.narrative ?? null],
      )
      changes.units = { before: e.units, after: units }
      changes.rate = { before: Number(e.applied_rate), after: rate }
    } else if (input.narrative !== undefined) {
      await tx.query(`update deedbox.time_entry set narrative = $2 where id = $1`, [
        input.entry,
        input.narrative,
      ])
    }
    if (input.narrative !== undefined) {
      changes.narrative = { before: e.narrative, after: input.narrative }
    }
    await emitRegister(tx, p, {
      kind: 'record.changed',
      subjectType: 'time_entry',
      subject: input.entry,
      matter: e.matter as number,
      detail: changes,
    })
  })
}

/** Write off an unbilled item (time entry or disbursement). */
export async function writeOffUnbilledItem(
  p: Principal,
  input: { itemType: 'time_entry' | 'disbursement'; item: number; reason: string },
): Promise<void> {
  requireStaff(p)
  if (!input.reason.trim()) {
    throw new OperationRefused('reason_required', 'a write-off always carries its reason')
  }
  await withPrincipal(p, async (tx) => {
    const r = await tx.query(
      `update deedbox.${input.itemType}
          set billed_state = 'written_off_before_billing', writeoff_reason = $2
        where id = $1 and billed_state = 'unbilled' and deleted_at is null
        returning matter`,
      [input.item, input.reason],
    )
    if (r.rowCount === 0) {
      throw new OperationRefused('not_unbilled', 'only unbilled items are written off')
    }
    await emitRegister(tx, p, {
      kind: 'record.changed',
      subjectType: input.itemType,
      subject: input.item,
      matter: r.rows[0].matter as number,
      reason: input.reason,
      detail: { billed_state: { before: 'unbilled', after: 'written_off_before_billing' } },
    })
  })
}

/** Soft-delete / restore an unbilled item. */
export async function softDeleteUnbilledItem(
  p: Principal,
  input: { itemType: 'time_entry' | 'disbursement'; item: number },
): Promise<void> {
  requireStaff(p)
  await withPrincipal(p, async (tx) => {
    const r = await tx.query(
      `update deedbox.${input.itemType} set deleted_at = now(), deleted_by = $2
        where id = $1 and billed_state = 'unbilled' and deleted_at is null
        returning matter`,
      [input.item, p.id],
    )
    if (r.rowCount === 0) {
      throw new OperationRefused('not_unbilled', 'only unbilled items soft-delete')
    }
    await emitRegister(tx, p, {
      kind: 'record.soft_deleted',
      subjectType: input.itemType,
      subject: input.item,
      matter: r.rows[0].matter as number,
    })
  })
}

export async function restoreUnbilledItem(
  p: Principal,
  input: { itemType: 'time_entry' | 'disbursement'; item: number },
): Promise<void> {
  requireStaff(p)
  await withPrincipal(p, async (tx) => {
    const r = await tx.query(
      `update deedbox.${input.itemType} set deleted_at = null, deleted_by = null
        where id = $1 and deleted_at is not null
        returning matter`,
      [input.item],
    )
    if (r.rowCount === 0) throw new OperationRefused('not_found', 'no deleted item to restore')
    await emitRegister(tx, p, {
      kind: 'record.restored',
      subjectType: input.itemType,
      subject: input.item,
      matter: r.rows[0].matter as number,
    })
  })
}
