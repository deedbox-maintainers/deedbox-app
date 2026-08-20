// Attach a conflict check; record its resolution. (Running a check —
// the search itself — arrives with the next increment; these are the
// record-keeping halves both gates consume.)

import type { Principal } from '@/lib/db'
import { withPrincipal, emitRegister, OperationRefused } from '@/lib/db'
import { requireStaff } from '@/lib/ops/shared'

/** Attach an unattached check — the single transition, registered. */
export async function attachConflictCheck(
  p: Principal,
  input: { check: number; to: { kind: 'matter' | 'intake_record'; id: number } },
): Promise<void> {
  requireStaff(p)
  await withPrincipal(p, async (tx) => {
    const target =
      input.to.kind === 'matter'
        ? await tx.query(`select id from deedbox.matter where id = $1`, [input.to.id])
        : await tx.query(
            `select id from deedbox.intake_record where id = $1 and deleted_at is null`,
            [input.to.id],
          )
    if (target.rowCount === 0) throw new OperationRefused('not_found', 'attachment target not found')
    const r = await tx.query(
      `update deedbox.conflict_check
          set attached_to_kind = $2, attached_to = $3
        where id = $1 and attached_to_kind = 'none'
        returning id`,
      [input.check, input.to.kind, input.to.id],
    )
    if (r.rowCount === 0) {
      throw new OperationRefused(
        'not_attachable',
        'conflict check not found or already attached (attachment is a single transition)',
      )
    }
    await emitRegister(tx, p, {
      kind: 'record.changed',
      subjectType: 'conflict_check',
      subject: input.check,
      matter: input.to.kind === 'matter' ? input.to.id : undefined,
      detail: { attached_to: input.to },
    })
  })
}

/** Record the one resolution a check ever carries. */
export async function recordConflictResolution(
  p: Principal,
  input: {
    check: number
    resolution: 'no_conflict_found' | 'conflict_found_action_taken'
    actionNote?: string
  },
): Promise<{ id: number }> {
  requireStaff(p)
  if (input.resolution === 'conflict_found_action_taken' && !input.actionNote?.trim()) {
    throw new OperationRefused(
      'action_note_required',
      'a found conflict is resolved only with the action taken on record',
    )
  }
  return withPrincipal(p, async (tx) => {
    const check = await tx.query(
      `select attached_to_kind, attached_to from deedbox.conflict_check where id = $1`,
      [input.check],
    )
    if (check.rowCount === 0) throw new OperationRefused('not_found', 'conflict check not found')
    const dup = await tx.query(
      `select 1 from deedbox.conflict_resolution where "check" = $1`,
      [input.check],
    )
    if (dup.rowCount! > 0) {
      throw new OperationRefused('already_resolved', 'a check carries exactly one resolution')
    }
    const r = await tx.query(
      `insert into deedbox.conflict_resolution ("check", resolution, action_note, resolved_by)
       values ($1, $2, $3, $4) returning id`,
      [input.check, input.resolution, input.actionNote ?? null, p.id],
    )
    await emitRegister(tx, p, {
      kind: 'record.created',
      subjectType: 'conflict_resolution',
      subject: r.rows[0].id as number,
      matter:
        check.rows[0].attached_to_kind === 'matter'
          ? (check.rows[0].attached_to as number)
          : undefined,
      detail: { check: input.check, resolution: input.resolution },
    })
    return { id: r.rows[0].id as number }
  })
}
