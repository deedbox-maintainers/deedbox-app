// Intake stage administration. The entity's discipline is fully defined
// (name unique among active, position unique among active, deactivated
// never deleted, records keep their pointer) but no dedicated change
// operation is enumerated for it: these screens are its first consumer,
// so the verbs land here — the precedent for configuration.
//
// Implementation note: stage administration is gated on `lists.manage` —
// stages are firm list configuration in everything but storage, and the
// closed capability catalogue offers no closer key.

import type { Principal, Tx } from '@/lib/db'
import { withPrincipal, emitRegister, OperationRefused } from '@/lib/db'
import { requireStaff, requireCapability } from '@/lib/ops/shared'

async function loadStage(tx: Tx, id: number) {
  const r = await tx.query(
    `select id, name, position, active from deedbox.intake_stage where id = $1`,
    [id],
  )
  if (r.rowCount === 0) throw new OperationRefused('not_found', 'no such intake stage')
  return r.rows[0] as { id: number; name: string; position: number; active: boolean }
}

export async function createIntakeStage(
  p: Principal,
  input: { name: string },
): Promise<{ id: number }> {
  requireStaff(p)
  const name = input.name.trim()
  if (!name) throw new OperationRefused('name_required', 'an intake stage needs a name')
  return withPrincipal(p, async (tx) => {
    await requireCapability(tx, p, 'lists.manage')
    const clash = await tx.query(
      `select 1 from deedbox.intake_stage where active and name = $1`,
      [name],
    )
    if (clash.rowCount! > 0) {
      throw new OperationRefused('name_in_use', 'an active stage already carries that name')
    }
    const r = await tx.query(
      `insert into deedbox.intake_stage (name, position)
       values ($1, coalesce((select max(position) from deedbox.intake_stage where active), 0) + 1)
       returning id`,
      [name],
    )
    const id = r.rows[0].id as number
    await emitRegister(tx, p, {
      kind: 'record.created',
      subjectType: 'intake_stage',
      subject: id,
      detail: { name },
    })
    return { id }
  })
}

export async function renameIntakeStage(
  p: Principal,
  input: { stage: number; name: string },
): Promise<void> {
  requireStaff(p)
  const name = input.name.trim()
  if (!name) throw new OperationRefused('name_required', 'an intake stage needs a name')
  await withPrincipal(p, async (tx) => {
    await requireCapability(tx, p, 'lists.manage')
    const stage = await loadStage(tx, input.stage)
    if (stage.name === name) return // idempotent
    const clash = await tx.query(
      `select 1 from deedbox.intake_stage where active and name = $1 and id <> $2`,
      [name, input.stage],
    )
    if (clash.rowCount! > 0) {
      throw new OperationRefused('name_in_use', 'an active stage already carries that name')
    }
    await tx.query(`update deedbox.intake_stage set name = $2 where id = $1`, [input.stage, name])
    await emitRegister(tx, p, {
      kind: 'record.changed',
      subjectType: 'intake_stage',
      subject: input.stage,
      detail: { before: { name: stage.name }, after: { name } },
    })
  })
}

/**
 * Deactivate keeps every record's pointer (greyed display, never
 * deleted); reactivation rejoins the board at the end of the order.
 */
export async function setIntakeStageActive(
  p: Principal,
  input: { stage: number; active: boolean },
): Promise<void> {
  requireStaff(p)
  await withPrincipal(p, async (tx) => {
    await requireCapability(tx, p, 'lists.manage')
    const stage = await loadStage(tx, input.stage)
    if (stage.active === input.active) return // idempotent
    if (input.active) {
      const clash = await tx.query(
        `select 1 from deedbox.intake_stage where active and name = $1`,
        [stage.name],
      )
      if (clash.rowCount! > 0) {
        throw new OperationRefused('name_in_use', 'an active stage already carries that name')
      }
      await tx.query(
        `update deedbox.intake_stage
            set active = true,
                position = coalesce((select max(position) from deedbox.intake_stage where active), 0) + 1
          where id = $1`,
        [input.stage],
      )
    } else {
      await tx.query(`update deedbox.intake_stage set active = false where id = $1`, [input.stage])
    }
    await emitRegister(tx, p, {
      kind: 'record.changed',
      subjectType: 'intake_stage',
      subject: input.stage,
      detail: { before: { active: stage.active }, after: { active: input.active } },
    })
  })
}

/**
 * Whole-set reorder in one registered act; the new order must name every
 * active stage exactly once. Positions are unique among active (partial
 * index), so the move happens in two passes — park on unique negatives, then
 * assign the final order.
 */
export async function reorderIntakeStages(
  p: Principal,
  input: { orderedStages: number[] },
): Promise<void> {
  requireStaff(p)
  await withPrincipal(p, async (tx) => {
    await requireCapability(tx, p, 'lists.manage')
    const rows = await tx.query(
      `select id from deedbox.intake_stage where active order by position`,
    )
    const existing = rows.rows.map((r) => r.id as number)
    const proposed = [...input.orderedStages]
    if (
      existing.length === 0 ||
      existing.length !== proposed.length ||
      [...existing].sort().join(',') !== [...proposed].sort().join(',')
    ) {
      throw new OperationRefused(
        'order_incomplete',
        'the new order must name every active stage exactly once',
      )
    }
    for (const id of proposed) {
      await tx.query(`update deedbox.intake_stage set position = -id where id = $1`, [id])
    }
    for (let i = 0; i < proposed.length; i++) {
      await tx.query(`update deedbox.intake_stage set position = $2 where id = $1`, [
        proposed[i],
        i + 1,
      ])
    }
    await emitRegister(tx, p, {
      kind: 'record.changed',
      subjectType: 'intake_stage',
      subject: proposed[0],
      detail: { before: { order: existing }, after: { order: proposed } },
    })
  })
}
