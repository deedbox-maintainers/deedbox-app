// Create matter, one transaction.
//
// Ordering matters: every refusal (conflict gate, inactive area, inactive
// client or lawyer) aborts BEFORE the gapless counter row is locked, so no
// matter number is ever consumed by a refused create. The schema's triggers
// carry the client guard, the automatic client matter-party row, corpus
// registration of title/summary/origin note, and the search index. The
// workflow template hook fires in this same transaction (loud stub until the
// workflow slice lands).
//
// The transaction core is exported for intake conversion, which runs
// it inside its own transaction with the conflict gate satisfied by the
// intake record's attached check.

import type { Principal, Tx } from '@/lib/db'
import { withPrincipal, emitRegister, OperationRefused } from '@/lib/db'
import { requireStaff, settingBool } from '@/lib/ops/shared'
import { applyTemplateIfAny } from '@/lib/ops/workflow/hooks'

export interface CreateMatterInput {
  title: string
  clientParty: number
  responsibleLawyer: number
  office: number
  practiceArea: number
  jurisdiction?: string
  summary?: string
  originNote?: string
  openedDate?: string // ISO date; defaults to today
  /**
   * A resolved conflict check to satisfy the conflict gate and attach to the
   * new matter. Required when the practice area's flag or the firm setting
   * demands one (the two combine by OR).
   */
  conflictCheck?: number
}

export async function createMatter(
  p: Principal,
  input: CreateMatterInput,
): Promise<{ id: number; matterNumber: string }> {
  requireStaff(p)
  return withPrincipal(p, (tx) => createMatterInTx(tx, p, input, {}))
}

export interface MatterGateOptions {
  /**
   * On intake conversion the gate is satisfied by a resolved check attached to
   * the intake record; one recorded resolution serves both gates in a single
   * conversion, so no check is demanded twice and none is re-attached.
   */
  conflictGateSatisfiedExternally?: boolean
}

export async function createMatterInTx(
  tx: Tx,
  p: Principal,
  input: CreateMatterInput,
  gate: MatterGateOptions,
): Promise<{ id: number; matterNumber: string }> {
  const title = input.title.trim()
  if (!title) throw new OperationRefused('title_required', 'a matter needs a title')

  // -- preconditions, all before the irreversible act -----------------------
  const area = await tx.query(
    `select active, require_conflict_resolution from deedbox.practice_area where id = $1`,
    [input.practiceArea],
  )
  if (area.rowCount === 0) throw new OperationRefused('not_found', 'practice area not found')
  if (!area.rows[0].active) {
    throw new OperationRefused('area_inactive', 'this practice area is not active')
  }
  const client = await tx.query(
    `select state, deleted_at from deedbox.party where id = $1`,
    [input.clientParty],
  )
  if (client.rowCount === 0) throw new OperationRefused('not_found', 'client party not found')
  if (client.rows[0].state !== 'active' || client.rows[0].deleted_at !== null) {
    throw new OperationRefused('client_inactive', 'the client must be an active party')
  }
  const lawyer = await tx.query(
    `select active from deedbox.staff_member where id = $1`,
    [input.responsibleLawyer],
  )
  if (lawyer.rowCount === 0 || !lawyer.rows[0].active) {
    throw new OperationRefused('lawyer_inactive', 'the responsible lawyer must be active staff')
  }

  const gateRequired =
    (area.rows[0].require_conflict_resolution as boolean) ||
    (await settingBool(tx, 'conflict.required_before_open'))
  if (gateRequired && !gate.conflictGateSatisfiedExternally) {
    await verifyResolvedCheck(tx, input.conflictCheck)
  }

  // -- the irreversible act: the counter locks inside this transaction ------
  const num = await tx.query(`select deedbox.allocate_number('matter') as n`)
  const matterNumber = num.rows[0].n as string

  // No RETURNING here: returning rows from an insert applies the visibility
  // predicate to the new row, and the predicate's own table read cannot see
  // a row the very same command is still inserting — fail-closed refuses it.
  // The next statement of this transaction sees the row and passes cleanly.
  await tx.query(
    `insert into deedbox.matter
       (matter_number, title, client_party, responsible_lawyer, office,
        practice_area, jurisdiction, summary, origin_note, opened_date)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9, coalesce($10::date, current_date))`,
    [
      matterNumber,
      title,
      input.clientParty,
      input.responsibleLawyer,
      input.office,
      input.practiceArea,
      input.jurisdiction ?? null,
      input.summary ?? null,
      input.originNote ?? null,
      input.openedDate ?? null,
    ],
  )
  const m = await tx.query(`select id from deedbox.matter where matter_number = $1`, [matterNumber])
  const matterId = m.rows[0].id as number

  await tx.query(
    `insert into deedbox.matter_staffing (matter, staff, role_on_matter)
     values ($1, $2, 'responsible_lawyer')`,
    [matterId, input.responsibleLawyer],
  )

  if (input.conflictCheck !== undefined && !gate.conflictGateSatisfiedExternally) {
    await tx.query(
      `update deedbox.conflict_check
          set attached_to_kind = 'matter', attached_to = $2
        where id = $1 and attached_to_kind = 'none'`,
      [input.conflictCheck, matterId],
    )
    await emitRegister(tx, p, {
      kind: 'record.changed',
      subjectType: 'conflict_check',
      subject: input.conflictCheck,
      matter: matterId,
      detail: { attached_to: { kind: 'matter', id: matterId } },
    })
  }

  await emitRegister(tx, p, {
    kind: 'record.created',
    subjectType: 'matter',
    subject: matterId,
    matter: matterId,
    detail: { matter_number: matterNumber, title },
  })
  await emitRegister(tx, p, {
    kind: 'matter.status_changed',
    subjectType: 'matter',
    subject: matterId,
    matter: matterId,
    detail: { before: null, after: 'open' },
  })

  await applyTemplateIfAny(tx, p, matterId, input.practiceArea)

  return { id: matterId, matterNumber }
}

async function verifyResolvedCheck(tx: Tx, checkId: number | undefined): Promise<void> {
  if (checkId === undefined) {
    throw new OperationRefused(
      'conflict_check_required',
      'opening this matter requires a resolved conflict check',
    )
  }
  const r = await tx.query(
    `select c.attached_to_kind, (r.id is not null) as resolved
       from deedbox.conflict_check c
       left join deedbox.conflict_resolution r on r."check" = c.id
      where c.id = $1`,
    [checkId],
  )
  if (r.rowCount === 0) throw new OperationRefused('not_found', 'conflict check not found')
  if (!r.rows[0].resolved) {
    throw new OperationRefused(
      'conflict_check_unresolved',
      'the conflict check must carry a recorded resolution',
    )
  }
  if (r.rows[0].attached_to_kind !== 'none') {
    throw new OperationRefused(
      'conflict_check_attached',
      'this conflict check is already attached elsewhere',
    )
  }
}
