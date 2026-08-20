// The generic soft-delete restore behind the
// deleted-records screen. One mechanism for every soft-deletable type:
// `deleted.restore` capability, within the window (the type's policy
// override, else softdelete.retention_days, 90 by default), clear the two
// fields, register record.restored. Out-of-window restore refuses with the
// window stated; the row remains, excluded everywhere, forever.
//
// Types whose domains ship their own restore discipline dispatch to those
// operations (notes re-register their corpus text; unbilled items re-check
// the billed-state rules) so no domain rule is bypassed by the generic
// screen. The closed-matter ceremony is NOT taken here: restoring a child
// of a closed matter refuses at the schema guard like any other write.

import type { Principal } from '@/lib/db'
import { withPrincipal, emitRegister, OperationRefused } from '@/lib/db'
import { requireStaff, requireCapability, settingText } from '@/lib/ops/shared'
// concrete modules, not the domain barrels — the security barrel is
// imported by billing (step-up assertions), so barrel imports here would
// close a module cycle
import { restoreNote } from '@/lib/ops/matters/notes'
import { restoreUnbilledItem } from '@/lib/ops/billing/timeEntries'
import { restoreDocument } from '@/lib/ops/documents/documents'

interface RestorableType {
  table: string
  matterColumn?: string
}

/** entity_type (deletion_policy key) → table; dispatched types are absent. */
const GENERIC_TYPES: Record<string, RestorableType> = {
  contact_point: { table: 'contact_point' },
  postal_address: { table: 'postal_address' },
  matter_party: { table: 'matter_party', matterColumn: 'matter' },
  matter_relation: { table: 'matter_relation' },
  party_link: { table: 'party_link' },
  intake_record: { table: 'intake_record' },
  intake_party: { table: 'intake_party' },
  saved_report: { table: 'saved_report' },
  document_template: { table: 'document_template' },
  task: { table: 'task', matterColumn: 'matter' },
  key_date: { table: 'key_date', matterColumn: 'matter' },
}

export async function restoreSoftDeleted(
  p: Principal,
  input: { entityType: string; id: number },
): Promise<void> {
  requireStaff(p)
  if (input.entityType === 'note') {
    return restoreNote(p, { note: input.id })
  }
  if (input.entityType === 'unbilled_time_entry') {
    return restoreUnbilledItem(p, { itemType: 'time_entry', item: input.id })
  }
  if (input.entityType === 'unbilled_disbursement') {
    return restoreUnbilledItem(p, { itemType: 'disbursement', item: input.id })
  }
  if (input.entityType === 'document') {
    return restoreDocument(p, { document: input.id })
  }
  const t = GENERIC_TYPES[input.entityType]
  if (!t) {
    throw new OperationRefused('not_restorable', `${input.entityType} is not a soft-deletable record type`)
  }
  await withPrincipal(p, async (tx) => {
    await requireCapability(tx, p, 'deleted.restore')
    const policy = await tx.query(
      `select mode, restore_window_days from deedbox.deletion_policy where entity_type = $1`,
      [input.entityType],
    )
    if (policy.rowCount === 0 || policy.rows[0].mode !== 'soft_delete') {
      throw new OperationRefused('not_restorable', `${input.entityType} is not under the soft-delete policy`)
    }
    const windowDays =
      (policy.rows[0].restore_window_days as number | null) ??
      Number((await settingText(tx, 'softdelete.retention_days')) ?? '90')
    const row = await tx.query(
      `select id, deleted_at,
              deleted_at + make_interval(days => $2) >= now() as in_window
              ${t.matterColumn ? `, ${t.matterColumn} as matter` : ''}
         from deedbox.${t.table}
        where id = $1 and deleted_at is not null`,
      [input.id, windowDays],
    )
    if (row.rowCount === 0) {
      throw new OperationRefused('not_found', 'no deleted record of that type with that id is visible to you')
    }
    if (!row.rows[0].in_window) {
      throw new OperationRefused(
        'window_closed',
        `the ${windowDays}-day restore window has passed — the record stays excluded permanently`,
      )
    }
    await tx.query(
      `update deedbox.${t.table} set deleted_at = null, deleted_by = null where id = $1`,
      [input.id],
    )
    await emitRegister(tx, p, {
      kind: 'record.restored',
      subjectType: input.entityType,
      subject: input.id,
      matter: t.matterColumn ? ((row.rows[0].matter as number | null) ?? undefined) : undefined,
    })
  })
}
