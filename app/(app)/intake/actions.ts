'use server'

// Intake-area server actions, including the stage administration this slice
// built (lists.manage). The intake create runs the same honest duplicate
// flow as party creation: candidates re-render the dialog, and the operation
// re-checks inside its own transaction.

import { act } from '@/lib/screens/action'
import {
  createIntake,
  checkDuplicates,
  moveIntakeStage,
  setIntakeOutcome,
  closeIntake,
  reopenIntake,
  addIntakeParty,
  softDeleteIntakeParty,
  convertIntake,
  createNote,
  softDeleteNote,
  createIntakeStage,
  renameIntakeStage,
  setIntakeStageActive,
  reorderIntakeStages,
} from '@/lib/ops/matters'
import { parse } from '@/components/forms'

function backToNew(fd: FormData): string {
  const qs = new URLSearchParams()
  for (const k of ['prospect_name', 'contact_phone', 'contact_email', 'about', 'notes', 'practice_area', 'stage']) {
    const v = fd.get(k)
    if (typeof v === 'string' && v !== '') qs.set(k, v)
  }
  qs.set('dup', '1')
  return `goto:/intake/new?${qs.toString()}`
}

export async function addIntake(formData: FormData): Promise<void> {
  await act('/intake/new', async (p) => {
    const existing = parse.numOrNull(formData, 'prospect_party')
    const name = parse.str(formData, 'prospect_name')
    const phone = parse.str(formData, 'contact_phone')
    const email = parse.strOrNull(formData, 'contact_email')
    const proceed = parse.bool(formData, 'proceed_with_candidates')

    let prospectParty: number | undefined
    let newProspect: { kind: 'person' | 'organisation'; fullName: string } | undefined
    let candidatesShown: unknown[] | undefined
    if (existing) {
      prospectParty = existing
    } else {
      const candidates = await checkDuplicates(p, {
        name,
        phone: phone || undefined,
        email: email ?? undefined,
      })
      if (candidates.length > 0 && !proceed) return backToNew(formData)
      newProspect = { kind: 'person', fullName: name }
      candidatesShown = candidates.length > 0 ? candidates : undefined
    }

    const r = await createIntake(p, {
      prospectParty,
      newProspect,
      candidatesShown,
      contactPhone: phone,
      contactEmail: email ?? undefined,
      about: parse.str(formData, 'about'),
      notes: parse.strOrNull(formData, 'notes') ?? undefined,
      practiceArea: parse.numOrNull(formData, 'practice_area') ?? undefined,
      stage: parse.numOrNull(formData, 'stage') ?? undefined,
    })
    return `goto:/intake/${r.id}?done=${encodeURIComponent('Approach recorded.')}`
  })
}

export async function moveStageAction(formData: FormData): Promise<void> {
  const intake = parse.num(formData, 'intake')
  await act(`/intake/${intake}`, async (p) => {
    await moveIntakeStage(p, { intake, stage: parse.num(formData, 'stage') })
    return 'Stage moved.'
  })
}

export async function setOutcomeAction(formData: FormData): Promise<void> {
  const intake = parse.num(formData, 'intake')
  await act(`/intake/${intake}`, async (p) => {
    const reason = parse.numOrNull(formData, 'outcome_reason')
    await setIntakeOutcome(p, {
      intake,
      outcomeReason: reason,
      outcomeNote: parse.strOrNull(formData, 'outcome_note') ?? undefined,
    })
    return reason === null ? 'Outcome cleared.' : 'Outcome recorded.'
  })
}

export async function closeIntakeAction(formData: FormData): Promise<void> {
  const intake = parse.num(formData, 'intake')
  await act(`/intake/${intake}`, async (p) => {
    await closeIntake(p, { intake })
    return 'Closed — an outcome is never demanded, and can still be recorded.'
  })
}

export async function reopenIntakeAction(formData: FormData): Promise<void> {
  const intake = parse.num(formData, 'intake')
  await act(`/intake/${intake}`, async (p) => {
    await reopenIntake(p, { intake })
    return 'Reopened — any recorded outcome is kept.'
  })
}

export async function addIntakePartyAction(formData: FormData): Promise<void> {
  const intake = parse.num(formData, 'intake')
  await act(`/intake/${intake}`, async (p) => {
    await addIntakeParty(p, {
      intake,
      party: parse.num(formData, 'party'),
      capacity: parse.num(formData, 'capacity'),
    })
    return 'Party added.'
  })
}

export async function removeIntakePartyAction(formData: FormData): Promise<void> {
  const intake = parse.num(formData, 'intake')
  await act(`/intake/${intake}`, async (p) => {
    await softDeleteIntakeParty(p, { intakeParty: parse.num(formData, 'intake_party') })
    return 'Party removed.'
  })
}

export async function addIntakeNoteAction(formData: FormData): Promise<void> {
  const intake = parse.num(formData, 'intake')
  await act(`/intake/${intake}`, async (p) => {
    await createNote(p, { ownerType: 'intake_record', owner: intake, body: parse.str(formData, 'body') })
    return 'Note added.'
  })
}

export async function removeIntakeNoteAction(formData: FormData): Promise<void> {
  const intake = parse.num(formData, 'intake')
  await act(`/intake/${intake}`, async (p) => {
    await softDeleteNote(p, { note: parse.num(formData, 'note') })
    return 'Note removed.'
  })
}

export async function convertIntakeAction(formData: FormData): Promise<void> {
  const intake = parse.num(formData, 'intake')
  await act(`/intake/${intake}`, async (p) => {
    const r = await convertIntake(p, {
      intake,
      title: parse.strOrNull(formData, 'title') ?? undefined,
      responsibleLawyer: parse.num(formData, 'responsible_lawyer'),
      office: parse.num(formData, 'office'),
      practiceArea: parse.numOrNull(formData, 'practice_area') ?? undefined,
    })
    return `goto:/matters/${r.matter}?done=${encodeURIComponent(
      `Converted — matter ${r.matterNumber} opened with everything carried across.`,
    )}`
  })
}

// ---- stage administration (lists.manage) ----------------------------------

export async function addStageAction(formData: FormData): Promise<void> {
  await act('/intake', async (p) => {
    await createIntakeStage(p, { name: parse.str(formData, 'name') })
    return 'Stage added at the end of the board.'
  })
}

export async function renameStageAction(formData: FormData): Promise<void> {
  await act('/intake', async (p) => {
    await renameIntakeStage(p, { stage: parse.num(formData, 'stage'), name: parse.str(formData, 'name') })
    return 'Stage renamed.'
  })
}

export async function setStageActiveAction(formData: FormData): Promise<void> {
  await act('/intake', async (p) => {
    const active = parse.bool(formData, 'active')
    await setIntakeStageActive(p, { stage: parse.num(formData, 'stage'), active })
    return active
      ? 'Stage reactivated at the end of the board.'
      : 'Stage retired — records on it keep their history, greyed.'
  })
}

export async function reorderStagesAction(formData: FormData): Promise<void> {
  await act('/intake', async (p) => {
    const ordered = parse
      .str(formData, 'ordered')
      .split(',')
      .map((v) => Number(v))
      .filter((n) => Number.isFinite(n) && n > 0)
    await reorderIntakeStages(p, { orderedStages: ordered })
    return 'Board order changed.'
  })
}
