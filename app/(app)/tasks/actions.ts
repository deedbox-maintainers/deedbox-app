'use server'

// Task-queue and workflow-panel actions. Every rule lives in lib/ops/workflow
// — the closed-matter ceremony, the one-current stage, slot fallbacks, the
// no-silent-recompute discipline.

import { act } from '@/lib/screens/action'
import {
  setTaskDone,
  editTask,
  createTask,
  softDeleteTask,
  createKeyDate,
  setKeyDateDone,
  setKeyDateCritical,
  setAnchorValue,
  applyTemplateToMatter,
  enterStage,
  completeStage,
  reopenStage,
  decideRecomputeProposal,
  decideSlotProposal,
} from '@/lib/ops/workflow'
import { parse } from '@/components/forms'

function back(formData: FormData, fallback: string): string {
  return parse.str(formData, 'back') || fallback
}

export async function taskDoneAction(formData: FormData): Promise<void> {
  await act(back(formData, '/tasks'), async (p) => {
    await setTaskDone(p, {
      task: parse.num(formData, 'task'),
      done: parse.str(formData, 'done') === 'true',
      editClosed: false,
    })
    return 'Task updated.'
  })
}

export async function reassignTaskAction(formData: FormData): Promise<void> {
  await act(back(formData, '/tasks'), async (p) => {
    await editTask(p, {
      task: parse.num(formData, 'task'),
      owner: parse.num(formData, 'owner'),
    })
    return 'Task reassigned.'
  })
}

export async function createTaskAction(formData: FormData): Promise<void> {
  const matter = parse.num(formData, 'matter')
  await act(`/matters/${matter}/workflow`, async (p) => {
    await createTask(p, {
      title: parse.str(formData, 'title'),
      matter,
      owner: parse.numOrNull(formData, 'owner') ?? undefined,
      dueDate: parse.strOrNull(formData, 'due_date') ?? undefined,
    })
    return 'Task created.'
  })
}

export async function deleteTaskAction(formData: FormData): Promise<void> {
  await act(back(formData, '/tasks'), async (p) => {
    await softDeleteTask(p, { task: parse.num(formData, 'task') })
    return 'Task deleted — restorable from Deleted records within the window.'
  })
}

export async function createKeyDateAction(formData: FormData): Promise<void> {
  const matter = parse.num(formData, 'matter')
  await act(`/matters/${matter}/workflow`, async (p) => {
    await createKeyDate(p, {
      matter,
      kind: (parse.strOrNull(formData, 'kind') as 'key_date' | 'appointment') ?? 'key_date',
      typeKey: parse.str(formData, 'type_key'),
      title: parse.str(formData, 'title'),
      startsAt: parse.str(formData, 'starts_at'),
      critical: parse.str(formData, 'critical') === 'on',
    })
    return 'Key date recorded.'
  })
}

export async function keyDateDoneAction(formData: FormData): Promise<void> {
  await act(back(formData, '/dates'), async (p) => {
    await setKeyDateDone(p, {
      keyDate: parse.num(formData, 'key_date'),
      done: parse.str(formData, 'done') === 'true',
    })
    return 'Key date updated.'
  })
}

export async function keyDateCriticalAction(formData: FormData): Promise<void> {
  await act(back(formData, '/dates'), async (p) => {
    await setKeyDateCritical(p, {
      keyDate: parse.num(formData, 'key_date'),
      critical: parse.str(formData, 'critical') === 'true',
    })
    return 'Key date updated.'
  })
}

export async function setAnchorAction(formData: FormData): Promise<void> {
  const matter = parse.num(formData, 'matter')
  await act(`/matters/${matter}/workflow`, async (p) => {
    const r = await setAnchorValue(p, {
      matter,
      definition: parse.num(formData, 'definition'),
      value: parse.str(formData, 'value'),
    })
    return r.proposal
      ? `Anchor set — ${r.dependents} dependent date(s) await confirmation; nothing moved yet.`
      : 'Anchor set — no dependent dates.'
  })
}

export async function applyTemplateAction(formData: FormData): Promise<void> {
  const matter = parse.num(formData, 'matter')
  await act(`/matters/${matter}/workflow`, async (p) => {
    const r = await applyTemplateToMatter(p, {
      matter,
      template: parse.num(formData, 'template'),
    })
    return `Template applied — ${r.stages} stage(s), ${r.tasks} task(s)${
      r.warnings.length > 0 ? `; ${r.warnings.length} slot warning(s) recorded` : ''
    }.`
  })
}

export async function enterStageAction(formData: FormData): Promise<void> {
  const matter = parse.num(formData, 'matter')
  await act(`/matters/${matter}/workflow`, async (p) => {
    await enterStage(p, {
      matter,
      stage: parse.num(formData, 'stage'),
      recomputeStageEntryDates: parse.str(formData, 'recompute') === 'on',
    })
    return 'Stage entered.'
  })
}

export async function completeStageAction(formData: FormData): Promise<void> {
  const matter = parse.num(formData, 'matter')
  await act(`/matters/${matter}/workflow`, async (p) => {
    await completeStage(p, { matter, stage: parse.num(formData, 'stage') })
    return 'Stage completed.'
  })
}

export async function reopenStageAction(formData: FormData): Promise<void> {
  const matter = parse.num(formData, 'matter')
  await act(`/matters/${matter}/workflow`, async (p) => {
    await reopenStage(p, { matter, stage: parse.num(formData, 'stage') })
    return 'Stage reopened.'
  })
}

export async function decideDateProposalAction(formData: FormData): Promise<void> {
  await act(back(formData, '/proposals'), async (p) => {
    const accept = formData.getAll('accept_task').map((x) => Number(x))
    const r = await decideRecomputeProposal(p, {
      proposal: parse.num(formData, 'proposal'),
      decision: parse.str(formData, 'decision') as 'confirm' | 'reject',
      acceptTasks: accept.length > 0 ? accept : undefined,
      note: parse.strOrNull(formData, 'note') ?? undefined,
    })
    return `Decided — ${r.applied} date(s) moved${r.skipped.length > 0 ? `, ${r.skipped.length} skipped` : ''}.`
  })
}

export async function decideSlotProposalAction(formData: FormData): Promise<void> {
  await act(back(formData, '/proposals'), async (p) => {
    const accept = formData.getAll('accept_task').map((x) => Number(x))
    await decideSlotProposal(p, {
      proposal: parse.num(formData, 'proposal'),
      decision: parse.str(formData, 'decision') as 'confirm' | 'reject',
      acceptTasks: accept.length > 0 ? accept : undefined,
      note: parse.strOrNull(formData, 'note') ?? undefined,
    })
    return 'Decided.'
  })
}
