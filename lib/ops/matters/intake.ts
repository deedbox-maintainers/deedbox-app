// Intake create, stage/outcome moves, intake parties, and conversion to a
// matter. The intake.enabled gate is enforced at insert by the schema; the
// corpus rows (about, notes) are trigger-synced. Conversion is one transaction:
// matter creation through the matter-create core with the conflict gate
// satisfied by the intake's attached resolved check, party copy with capacities
// preserved, the permanent conversion link, and cross-linked register entries
// sharing a correlation.

import type { Principal, Tx } from '@/lib/db'
import { withPrincipal, emitRegister, OperationRefused } from '@/lib/db'
import { requireStaff, requireCapability, settingBool } from '@/lib/ops/shared'
import { checkDuplicatesInTx } from './duplicates'
import { createMatterInTx } from './createMatter'

export interface CreateIntakeInput {
  /** An existing prospect party, or the fields to create one. */
  prospectParty?: number
  newProspect?: { kind: 'person' | 'organisation'; fullName: string }
  candidatesShown?: unknown[]
  contactPhone: string
  contactEmail?: string
  about: string
  notes?: string
  practiceArea?: number
  stage?: number
}

export async function createIntake(
  p: Principal,
  input: CreateIntakeInput,
): Promise<{ id: number; prospectParty: number }> {
  requireStaff(p)
  if (!input.about.trim()) throw new OperationRefused('about_required', 'what is the enquiry about?')
  if (!input.contactPhone.trim()) {
    throw new OperationRefused('phone_required', 'an intake record carries a contact phone')
  }
  if ((input.prospectParty === undefined) === (input.newProspect === undefined)) {
    throw new OperationRefused(
      'prospect_required',
      'name an existing prospect party or the new party to create — exactly one',
    )
  }
  return withPrincipal(p, async (tx) => {
    if (!(await settingBool(tx, 'intake.enabled'))) {
      throw new OperationRefused('intake_disabled', 'intake is not enabled for this firm')
    }
    let prospectId: number
    if (input.prospectParty !== undefined) {
      const party = await tx.query(
        `select state, deleted_at from deedbox.party where id = $1`,
        [input.prospectParty],
      )
      if (party.rowCount === 0) throw new OperationRefused('not_found', 'prospect party not found')
      if (party.rows[0].state !== 'active' || party.rows[0].deleted_at !== null) {
        throw new OperationRefused('party_inactive', 'the prospect must be an active party')
      }
      prospectId = input.prospectParty
    } else {
      const candidates = await checkDuplicatesInTx(tx, {
        name: input.newProspect!.fullName,
        phone: input.contactPhone,
        email: input.contactEmail,
      })
      if (candidates.length > 0 && input.candidatesShown === undefined) {
        throw new OperationRefused(
          'duplicates_found',
          'possible existing parties were found; review the candidates and proceed deliberately',
        )
      }
      const created = await tx.query(
        `insert into deedbox.party (kind, display_name) values ($1, $2) returning id`,
        [input.newProspect!.kind, input.newProspect!.fullName.trim()],
      )
      prospectId = created.rows[0].id as number
      await tx.query(
        `insert into deedbox.party_name (party, name_kind, full_name)
         values ($1, 'current', $2)`,
        [prospectId, input.newProspect!.fullName.trim()],
      )
      if (input.candidatesShown !== undefined) {
        await tx.query(
          `insert into deedbox.duplicate_decision
             (created_entity_type, created_entity, candidates_shown, decision_mode, decided_by_kind, decided_by)
           values ('party', $1, $2, 'interactive', 'staff', $3)`,
          [prospectId, JSON.stringify(input.candidatesShown), p.id],
        )
      }
      await emitRegister(tx, p, {
        kind: 'record.created',
        subjectType: 'party',
        subject: prospectId,
        detail: { kind: input.newProspect!.kind, display_name: input.newProspect!.fullName.trim() },
      })
    }

    const rec = await tx.query(
      `insert into deedbox.intake_record
         (prospect_party, contact_phone, contact_email, about, notes, practice_area, stage)
       values ($1,$2,$3,$4,$5,$6,$7) returning id`,
      [
        prospectId,
        input.contactPhone,
        input.contactEmail ?? null,
        input.about,
        input.notes ?? null,
        input.practiceArea ?? null,
        input.stage ?? null,
      ],
    )
    const id = rec.rows[0].id as number
    await emitRegister(tx, p, {
      kind: 'record.created',
      subjectType: 'intake_record',
      subject: id,
      detail: { prospect_party: prospectId },
    })
    return { id, prospectParty: prospectId }
  })
}

async function lockOpenIntake(tx: Tx, intakeId: number, allowClosed = false) {
  const r = await tx.query(
    `select id, state, prospect_party, about, practice_area from deedbox.intake_record
      where id = $1 and deleted_at is null for update`,
    [intakeId],
  )
  if (r.rowCount === 0) throw new OperationRefused('not_found', 'intake record not found')
  const state = r.rows[0].state as string
  if (state === 'converted') {
    throw new OperationRefused('converted_terminal', 'a converted intake record never changes')
  }
  if (!allowClosed && state !== 'open') {
    throw new OperationRefused('wrong_state', 'this intake record is not open')
  }
  return r.rows[0] as {
    id: number
    state: string
    prospect_party: number
    about: string
    practice_area: number | null
  }
}

/** Stage move — active stages only. */
export async function moveIntakeStage(
  p: Principal,
  input: { intake: number; stage: number },
): Promise<void> {
  requireStaff(p)
  await withPrincipal(p, async (tx) => {
    await lockOpenIntake(tx, input.intake)
    const stage = await tx.query(`select active from deedbox.intake_stage where id = $1`, [
      input.stage,
    ])
    if (stage.rowCount === 0 || !stage.rows[0].active) {
      throw new OperationRefused('stage_inactive', 'stage moves land on active stages only')
    }
    await tx.query(`update deedbox.intake_record set stage = $2 where id = $1`, [
      input.intake,
      input.stage,
    ])
    await emitRegister(tx, p, {
      kind: 'record.changed',
      subjectType: 'intake_record',
      subject: input.intake,
      detail: { stage: input.stage },
    })
  })
}

/** Outcome — set, changed or cleared, open or closed, never demanded. */
export async function setIntakeOutcome(
  p: Principal,
  input: { intake: number; outcomeReason: number | null; outcomeNote?: string },
): Promise<void> {
  requireStaff(p)
  await withPrincipal(p, async (tx) => {
    await lockOpenIntake(tx, input.intake, true)
    await tx.query(
      `update deedbox.intake_record
          set outcome_reason = $2, outcome_note = $3,
              outcome_at = case when $2::bigint is null then null else now() end
        where id = $1`,
      [input.intake, input.outcomeReason, input.outcomeNote ?? null],
    )
    await emitRegister(tx, p, {
      kind: 'record.changed',
      subjectType: 'intake_record',
      subject: input.intake,
      detail: { outcome_reason: input.outcomeReason },
    })
  })
}

/** Close / reopen (open ⇄ closed; converted is terminal). */
export async function closeIntake(p: Principal, input: { intake: number }): Promise<void> {
  requireStaff(p)
  await withPrincipal(p, async (tx) => {
    await lockOpenIntake(tx, input.intake)
    await tx.query(`update deedbox.intake_record set state = 'closed' where id = $1`, [input.intake])
    await emitRegister(tx, p, {
      kind: 'record.changed',
      subjectType: 'intake_record',
      subject: input.intake,
      detail: { before: { state: 'open' }, after: { state: 'closed' } },
    })
  })
}

export async function reopenIntake(p: Principal, input: { intake: number }): Promise<void> {
  requireStaff(p)
  await withPrincipal(p, async (tx) => {
    const r = await tx.query(
      `select state from deedbox.intake_record where id = $1 and deleted_at is null for update`,
      [input.intake],
    )
    if (r.rowCount === 0) throw new OperationRefused('not_found', 'intake record not found')
    if (r.rows[0].state !== 'closed') {
      throw new OperationRefused('wrong_state', 'only closed intake records reopen')
    }
    await tx.query(`update deedbox.intake_record set state = 'open' where id = $1`, [input.intake])
    await emitRegister(tx, p, {
      kind: 'record.changed',
      subjectType: 'intake_record',
      subject: input.intake,
      detail: { before: { state: 'closed' }, after: { state: 'open' } },
    })
  })
}

/** Intake parties. */
export async function addIntakeParty(
  p: Principal,
  input: { intake: number; party: number; capacity: number },
): Promise<{ id: number }> {
  requireStaff(p)
  return withPrincipal(p, async (tx) => {
    await lockOpenIntake(tx, input.intake)
    const party = await tx.query(
      `select state, deleted_at from deedbox.party where id = $1`,
      [input.party],
    )
    if (party.rowCount === 0) throw new OperationRefused('not_found', 'party not found')
    if (party.rows[0].state !== 'active' || party.rows[0].deleted_at !== null) {
      throw new OperationRefused('party_inactive', 'only active parties join intake records')
    }
    const r = await tx.query(
      `insert into deedbox.intake_party (intake, party, capacity)
       values ($1, $2, $3) returning id`,
      [input.intake, input.party, input.capacity],
    )
    await emitRegister(tx, p, {
      kind: 'record.created',
      subjectType: 'intake_party',
      subject: r.rows[0].id as number,
      detail: { intake: input.intake, party: input.party },
    })
    return { id: r.rows[0].id as number }
  })
}

export async function softDeleteIntakeParty(
  p: Principal,
  input: { intakeParty: number },
): Promise<void> {
  requireStaff(p)
  await withPrincipal(p, async (tx) => {
    const r = await tx.query(
      `update deedbox.intake_party set deleted_at = now(), deleted_by = $2
        where id = $1 and deleted_at is null returning intake`,
      [input.intakeParty, p.id],
    )
    if (r.rowCount === 0) throw new OperationRefused('not_found', 'intake party not found')
    await emitRegister(tx, p, {
      kind: 'record.soft_deleted',
      subjectType: 'intake_party',
      subject: input.intakeParty,
      detail: { intake: r.rows[0].intake },
    })
  })
}

export interface ConvertIntakeInput {
  intake: number
  title?: string // defaults to the about text's first line
  responsibleLawyer: number
  office: number
  /** Practice area for the matter; defaults to the intake's, which must then exist. */
  practiceArea?: number
  openedDate?: string
}

/** Convert intake to matter — never a half-converted pair. */
export async function convertIntake(
  p: Principal,
  input: ConvertIntakeInput,
): Promise<{ matter: number; matterNumber: string }> {
  return withPrincipal(p, async (tx) => {
    await requireCapability(tx, p, 'intake.convert')
    const rec = await lockOpenIntake(tx, input.intake)
    const areaId = input.practiceArea ?? rec.practice_area
    if (areaId === null || areaId === undefined) {
      throw new OperationRefused('area_required', 'conversion needs a practice area')
    }

    // The conversion gate: area flag OR conflict.required_before_convert; a
    // resolved check ATTACHED TO THIS INTAKE RECORD satisfies it — and the
    // same resolution satisfies the matter-open gate in this transaction.
    const area = await tx.query(
      `select active, require_conflict_resolution from deedbox.practice_area where id = $1`,
      [areaId],
    )
    if (area.rowCount === 0) throw new OperationRefused('not_found', 'practice area not found')
    const gateRequired =
      (area.rows[0].require_conflict_resolution as boolean) ||
      (await settingBool(tx, 'conflict.required_before_convert')) ||
      (await settingBool(tx, 'conflict.required_before_open'))
    if (gateRequired) {
      const check = await tx.query(
        `select 1 from deedbox.conflict_check c
          join deedbox.conflict_resolution r on r."check" = c.id
         where c.attached_to_kind = 'intake_record' and c.attached_to = $1`,
        [input.intake],
      )
      if (check.rowCount === 0) {
        throw new OperationRefused(
          'conflict_check_required',
          'conversion requires a resolved conflict check attached to this intake record',
        )
      }
    }

    const about = rec.about
    const title = (input.title ?? about.split('\n')[0]).trim().slice(0, 200)
    const made = await createMatterInTx(
      tx,
      p,
      {
        title,
        clientParty: rec.prospect_party,
        responsibleLawyer: input.responsibleLawyer,
        office: input.office,
        practiceArea: areaId,
        summary: about,
        openedDate: input.openedDate,
      },
      { conflictGateSatisfiedExternally: gateRequired },
    )

    // Copy every live intake party, capacities preserved.
    await tx.query(
      `insert into deedbox.matter_party (matter, party, capacity)
       select $1, ip.party, ip.capacity
         from deedbox.intake_party ip
        where ip.intake = $2 and ip.deleted_at is null
          and not exists (select 1 from deedbox.matter_party mp
                           where mp.matter = $1 and mp.party = ip.party
                             and mp.capacity = ip.capacity and mp.deleted_at is null)`,
      [made.id, input.intake],
    )

    await tx.query(
      `update deedbox.intake_record set state = 'converted', converted_matter = $2 where id = $1`,
      [input.intake, made.id],
    )

    const correlation = `intake-${input.intake}-matter-${made.id}`
    await emitRegister(tx, p, {
      kind: 'record.changed',
      subjectType: 'intake_record',
      subject: input.intake,
      detail: { converted_matter: made.id, correlation },
    })
    await emitRegister(tx, p, {
      kind: 'record.changed',
      subjectType: 'matter',
      subject: made.id,
      matter: made.id,
      detail: { converted_from_intake: input.intake, correlation },
    })

    return { matter: made.id, matterNumber: made.matterNumber }
  })
}
