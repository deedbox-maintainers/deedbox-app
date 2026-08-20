'use server'

// Conflict-area server actions. Running a check WRITES the immutable
// snapshot (that is the point — the evidence outlives the data it searched);
// the action lands on the snapshot screen.

import { act } from '@/lib/screens/action'
import { runConflictCheck, attachConflictCheck, recordConflictResolution } from '@/lib/ops/matters'
import { parse } from '@/components/forms'

export async function runCheckAction(formData: FormData): Promise<void> {
  await act('/conflicts', async (p) => {
    const r = await runConflictCheck(p, {
      name: parse.str(formData, 'name'),
      phone: parse.strOrNull(formData, 'phone') ?? undefined,
      email: parse.strOrNull(formData, 'email') ?? undefined,
      similarity: parse.numOrNull(formData, 'similarity') ?? undefined,
    })
    const attachKind = parse.strOrNull(formData, 'attach_kind')
    const attachId = parse.numOrNull(formData, 'attach_id')
    const attach =
      attachKind && attachId ? `&attach_kind=${attachKind}&attach_id=${attachId}` : ''
    return `goto:/conflicts/${r.check}?done=${encodeURIComponent('Check run and snapshotted.')}${attach}`
  })
}

export async function attachCheckAction(formData: FormData): Promise<void> {
  const check = parse.num(formData, 'check')
  await act(`/conflicts/${check}`, async (p) => {
    await attachConflictCheck(p, {
      check,
      to: {
        kind: parse.str(formData, 'attach_kind') as 'matter' | 'intake_record',
        id: parse.num(formData, 'attach_id'),
      },
    })
    return 'Attached — the record now carries this check.'
  })
}

export async function resolveCheckAction(formData: FormData): Promise<void> {
  const check = parse.num(formData, 'check')
  await act(`/conflicts/${check}`, async (p) => {
    await recordConflictResolution(p, {
      check,
      resolution: parse.str(formData, 'resolution') as
        | 'no_conflict_found'
        | 'conflict_found_action_taken',
      actionNote: parse.strOrNull(formData, 'action_note') ?? undefined,
    })
    return 'Resolution recorded — one per check, permanent.'
  })
}
