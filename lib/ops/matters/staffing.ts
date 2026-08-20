// The one dedicated staffing-change operation. A responsible-lawyer change
// installs the successor row and updates the matter mirror in the same
// transaction (the mirror can never drift, and a matter is never without a
// responsible lawyer). The workflow re-resolution hook fires in this same
// transaction.

import type { Principal, Tx } from '@/lib/db'
import { withPrincipal, emitRegister, OperationRefused } from '@/lib/db'
import { requireStaff } from '@/lib/ops/shared'
import { fireSlotReresolution } from '@/lib/ops/workflow/hooks'

export interface StaffingChange {
  matter: number
  /** staffing row ids to end (to_at = now). */
  end?: number[]
  /** assisting rows to add. */
  addAssisting?: number[]
  /** the new responsible lawyer, when the responsibility moves. */
  newResponsible?: number
}

export async function changeStaffing(p: Principal, input: StaffingChange): Promise<void> {
  requireStaff(p)
  await withPrincipal(p, async (tx) => {
    const m = await tx.query(
      `select responsible_lawyer from deedbox.matter where id = $1 for update`,
      [input.matter],
    )
    if (m.rowCount === 0) throw new OperationRefused('not_found', 'matter not found')
    const beforeResponsible = m.rows[0].responsible_lawyer as number

    const beforeRows = await tx.query(
      `select id, staff, role_on_matter from deedbox.matter_staffing
        where matter = $1 and to_at is null order by id`,
      [input.matter],
    )

    for (const rowId of input.end ?? []) {
      const r = await tx.query(
        `update deedbox.matter_staffing set to_at = now()
          where id = $1 and matter = $2 and to_at is null
          returning role_on_matter`,
        [rowId, input.matter],
      )
      if (r.rowCount === 0) throw new OperationRefused('not_found', `staffing row ${rowId} not found`)
      if (r.rows[0].role_on_matter === 'responsible_lawyer' && input.newResponsible === undefined) {
        throw new OperationRefused(
          'responsible_required',
          'a matter is never without a responsible lawyer; name the successor',
        )
      }
    }

    for (const staffId of input.addAssisting ?? []) {
      await requireActiveStaff(tx, staffId)
      await tx.query(
        `insert into deedbox.matter_staffing (matter, staff, role_on_matter)
         values ($1, $2, 'assisting')`,
        [input.matter, staffId],
      )
    }

    if (input.newResponsible !== undefined && input.newResponsible !== beforeResponsible) {
      await requireActiveStaff(tx, input.newResponsible)
      await tx.query(
        `update deedbox.matter_staffing set to_at = now()
          where matter = $1 and role_on_matter = 'responsible_lawyer' and to_at is null`,
        [input.matter],
      )
      await tx.query(
        `insert into deedbox.matter_staffing (matter, staff, role_on_matter)
         values ($1, $2, 'responsible_lawyer')`,
        [input.matter, input.newResponsible],
      )
      await tx.query(`update deedbox.matter set responsible_lawyer = $2 where id = $1`, [
        input.matter,
        input.newResponsible,
      ])
    }

    const afterRows = await tx.query(
      `select id, staff, role_on_matter from deedbox.matter_staffing
        where matter = $1 and to_at is null order by id`,
      [input.matter],
    )
    await emitRegister(tx, p, {
      kind: 'record.changed',
      subjectType: 'matter',
      subject: input.matter,
      matter: input.matter,
      detail: { staffing: { before: beforeRows.rows, after: afterRows.rows } },
    })

    await fireSlotReresolution(tx, p, input.matter)
  })
}

async function requireActiveStaff(tx: Tx, staffId: number) {
  const s = await tx.query(`select active from deedbox.staff_member where id = $1`, [staffId])
  if (s.rowCount === 0 || !s.rows[0].active) {
    throw new OperationRefused('staff_inactive', 'incoming staff must be active')
  }
}
