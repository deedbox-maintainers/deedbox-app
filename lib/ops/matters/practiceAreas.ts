// Practice-area administration. The conflict-gate
// toggle is compliance-relevant and recorded as privileged.

import type { Principal } from '@/lib/db'
import { withPrincipal, emitRegister, OperationRefused } from '@/lib/db'
import { requireStaff } from '@/lib/ops/shared'

export async function createPracticeArea(
  p: Principal,
  input: { name: string; requireConflictResolution?: boolean },
): Promise<{ id: number }> {
  requireStaff(p)
  const name = input.name.trim()
  if (!name) throw new OperationRefused('name_required', 'a practice area needs a name')
  return withPrincipal(p, async (tx) => {
    const r = await tx.query(
      `insert into deedbox.practice_area (name, require_conflict_resolution)
       values ($1, $2) returning id`,
      [name, input.requireConflictResolution ?? false],
    )
    const id = r.rows[0].id as number
    await emitRegister(tx, p, {
      kind: 'record.created',
      subjectType: 'practice_area',
      subject: id,
      detail: { name },
    })
    return { id }
  })
}

export async function renamePracticeArea(
  p: Principal,
  input: { area: number; name: string },
): Promise<void> {
  requireStaff(p)
  const name = input.name.trim()
  if (!name) throw new OperationRefused('name_required', 'a practice area needs a name')
  await withPrincipal(p, async (tx) => {
    const cur = await tx.query(
      `select name from deedbox.practice_area where id = $1 for update`,
      [input.area],
    )
    if (cur.rowCount === 0) throw new OperationRefused('not_found', 'practice area not found')
    await tx.query(`update deedbox.practice_area set name = $2 where id = $1`, [input.area, name])
    await emitRegister(tx, p, {
      kind: 'record.changed',
      subjectType: 'practice_area',
      subject: input.area,
      detail: { before: { name: cur.rows[0].name }, after: { name } },
    })
  })
}

export async function setPracticeAreaActive(
  p: Principal,
  input: { area: number; active: boolean },
): Promise<void> {
  requireStaff(p)
  await withPrincipal(p, async (tx) => {
    const r = await tx.query(
      `update deedbox.practice_area set active = $2
        where id = $1 and active is distinct from $2 returning id`,
      [input.area, input.active],
    )
    if (r.rowCount === 0) {
      throw new OperationRefused('no_change', 'practice area not found or already as requested')
    }
    await emitRegister(tx, p, {
      kind: 'record.changed',
      subjectType: 'practice_area',
      subject: input.area,
      detail: { before: { active: !input.active }, after: { active: input.active } },
    })
  })
}

/** The compliance toggle — privileged, before/after on the register. */
export async function setConflictRequirement(
  p: Principal,
  input: { area: number; required: boolean },
): Promise<void> {
  requireStaff(p)
  await withPrincipal(p, async (tx) => {
    const cur = await tx.query(
      `select require_conflict_resolution from deedbox.practice_area where id = $1 for update`,
      [input.area],
    )
    if (cur.rowCount === 0) throw new OperationRefused('not_found', 'practice area not found')
    if (cur.rows[0].require_conflict_resolution === input.required) {
      throw new OperationRefused('no_change', 'the requirement is already as requested')
    }
    await tx.query(
      `update deedbox.practice_area set require_conflict_resolution = $2 where id = $1`,
      [input.area, input.required],
    )
    await emitRegister(tx, p, {
      kind: 'record.changed',
      subjectType: 'practice_area',
      subject: input.area,
      privileged: true,
      detail: {
        before: { require_conflict_resolution: !input.required },
        after: { require_conflict_resolution: input.required },
      },
    })
  })
}

/** Edit one relatable pair (order-insensitive storage: lower id first). */
export async function setRelatablePair(
  p: Principal,
  input: { areaA: number; areaB: number; allowed: boolean },
): Promise<void> {
  requireStaff(p)
  const [a, b] =
    input.areaA <= input.areaB ? [input.areaA, input.areaB] : [input.areaB, input.areaA]
  await withPrincipal(p, async (tx) => {
    await tx.query(
      `insert into deedbox.practice_area_relatable (area_a, area_b, allowed)
       values ($1, $2, $3)
       on conflict (area_a, area_b) do update set allowed = excluded.allowed`,
      [a, b, input.allowed],
    )
    await emitRegister(tx, p, {
      kind: 'record.changed',
      subjectType: 'practice_area',
      subject: a,
      detail: { relatable: { area_a: a, area_b: b, allowed: input.allowed } },
    })
  })
}
