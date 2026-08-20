// The workflow domain's published hooks, called INSIDE other domains'
// committing transactions (the matter creation/conversion apply; the
// staffing re-resolution). Day one shipped these as loud stubs;
// the workflow slice fills them with the real bodies.

import type { Principal, Tx } from '@/lib/db'
import { OperationRefused } from '@/lib/db'
import { applyTemplateInTx } from './apply'
import { raiseSlotReresolutionInTx } from './anchors'

/**
 * Same-transaction hook: apply the practice area's
 * workflow template. Zero active templates proceeds untouched; exactly one
 * applies; several refuse — the caller must name the template through the
 * manual application operation after choosing.
 */
export async function applyTemplateIfAny(
  tx: Tx,
  p: Principal,
  matterId: number,
  practiceAreaId: number,
): Promise<void> {
  const templates = await tx.query(
    `select id from deedbox.workflow_template where practice_area = $1 and active order by id`,
    [practiceAreaId],
  )
  if (templates.rowCount === 0) return
  if (templates.rowCount! > 1) {
    throw new OperationRefused(
      'choose_template',
      'this practice area has several active templates — create the matter after choosing one, or deactivate the others',
    )
  }
  await applyTemplateInTx(tx, p, matterId, templates.rows[0].id as number)
}

/**
 * Same-transaction hook: a staffing change raises
 * the slot re-resolution proposal atomically with the staffing write.
 */
export async function fireSlotReresolution(
  tx: Tx,
  p: Principal,
  matterId: number,
): Promise<void> {
  await raiseSlotReresolutionInTx(tx, p, matterId)
}
