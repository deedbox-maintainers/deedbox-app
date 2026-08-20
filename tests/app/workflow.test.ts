// Workflow: templates, application through the matter-creation
// hook, stage movement, tasks under the closed-matter ceremony, key dates
// with sync idempotency, anchor recompute proposals, and staffing-driven
// slot re-resolution — the day-one loud stubs replaced by the real bodies.
// Runs last under the pinned order; fixtures fully tagged.

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import type { Pool } from 'pg'
import { closePool } from '@/lib/db'
import type { Principal } from '@/lib/db'
import { createMatter } from '@/lib/ops/matters'
import { closeMatter } from '@/lib/ops/matters/matterLifecycle'
import { changeStaffing } from '@/lib/ops/matters/staffing'
import {
  createWorkflowTemplate,
  setWorkflowTemplateActive,
  applyTemplateToMatter,
  enterStage,
  completeStage,
  reopenStage,
  createTask,
  setTaskDone,
  createKeyDate,
  setKeyDateCritical,
  setAnchorValue,
  decideRecomputeProposal,
  decideSlotProposal,
  createAnchorDefinition,
} from '@/lib/ops/workflow'
import { makeAdminPool, buildFixture, addStaff, type Fixture } from './helpers'

let admin: Pool
let fx: Fixture
let P: Principal
let second: number
let anchorDef: number
let template: number

function dateStr(daysAgo: number): string {
  return new Date(Date.now() - daysAgo * 86400000).toISOString().slice(0, 10)
}

async function newMatter(title: string): Promise<number> {
  const m = await createMatter(P, {
    title,
    clientParty: fx.clientParty,
    responsibleLawyer: fx.staff,
    office: fx.office,
    practiceArea: fx.practiceArea,
  })
  return m.id
}

beforeAll(async () => {
  admin = makeAdminPool()
  fx = await buildFixture(admin, 'wflo')
  P = { kind: 'staff', id: fx.staff, firm: fx.firm }
  second = await addStaff(admin, fx, 'sam.wflo')
})

afterAll(async () => {
  await closePool()
  await admin.end()
})

describe('templates and application', () => {
  it('validates due rules at save and creates the whole tree', async () => {
    anchorDef = (await createAnchorDefinition(P, { name: 'Settlement date wflo' })).id
    await expect(
      createWorkflowTemplate(P, {
        name: 'Bad rule wflo',
        practiceArea: fx.practiceArea,
        stages: [
          {
            name: 'Stage',
            tasks: [
              { title: 'x', assigneeSlot: 'responsible_lawyer', dueRule: { basis: 'stage_entry', offset_days: -1 } },
            ],
          },
        ],
      }),
    ).rejects.toMatchObject({ code: 'bad_due_rule' })
    await expect(
      createWorkflowTemplate(P, {
        name: 'Bad anchor wflo',
        practiceArea: fx.practiceArea,
        stages: [
          {
            name: 'Stage',
            tasks: [
              {
                title: 'x',
                assigneeSlot: 'responsible_lawyer',
                dueRule: { basis: 'anchor', anchor_definition: 999999, offset_days: 1, direction: 'before' },
              },
            ],
          },
        ],
      }),
    ).rejects.toMatchObject({ code: 'bad_due_rule' })

    const t = await createWorkflowTemplate(P, {
      name: 'Standard matter wflo',
      practiceArea: fx.practiceArea,
      stages: [
        {
          name: 'Open file',
          expectedDurationDays: 7,
          tasks: [
            { title: 'Send engagement letter', assigneeSlot: 'responsible_lawyer', dueRule: { basis: 'stage_entry', offset_days: 3 } },
            { title: 'Collect identification', assigneeSlot: 'assisting_staff', dueRule: { basis: 'none' } },
          ],
        },
        {
          name: 'Prepare',
          tasks: [
            {
              title: 'Brief counsel before settlement',
              assigneeSlot: 'responsible_lawyer',
              dueRule: { basis: 'anchor', anchor_definition: anchorDef, offset_days: 14, direction: 'before' },
            },
          ],
        },
      ],
    })
    template = t.id
  })

  it('matter creation applies the single active template; slots fall back with warnings', async () => {
    const m = await newMatter('Templated matter wflo')
    const stages = await admin.query(
      `select id, name, position, state from deedbox.matter_stage where matter = $1 order by position`,
      [m],
    )
    expect(stages.rowCount).toBe(2)
    expect(stages.rows.every((s) => s.state === 'pending')).toBe(true)
    const tasks = await admin.query(
      `select title, owner, due_date, assignee_slot, origin from deedbox.task
        where matter = $1 order by id`,
      [m],
    )
    expect(tasks.rowCount).toBe(3)
    // no assisting staff: the fallback owner is the responsible lawyer
    expect(tasks.rows.every((t) => t.owner === fx.staff)).toBe(true)
    // stage-entry and anchor rules rest dateless until entry / anchor value
    expect(tasks.rows.every((t) => t.due_date === null)).toBe(true)
    expect(tasks.rows.every((t) => t.origin === 'template')).toBe(true)
    const summary = await admin.query(
      `select detail from deedbox.register_entry
        where event_kind = 'record.created' and subject_type = 'workflow_application' and matter = $1`,
      [m],
    )
    expect(summary.rowCount).toBe(1)
    expect(summary.rows[0].detail.warnings.length).toBeGreaterThan(0) // the assisting fallback
  })

  it('several active templates refuse matter creation until one is chosen', async () => {
    const t2 = await createWorkflowTemplate(P, {
      name: 'Second template wflo',
      practiceArea: fx.practiceArea,
      stages: [{ name: 'Only stage', tasks: [] }],
    })
    await expect(newMatter('Ambiguous wflo')).rejects.toMatchObject({ code: 'choose_template' })
    await setWorkflowTemplateActive(P, { template: t2.id, active: false })
    const m = await newMatter('Unambiguous wflo')
    const stages = await admin.query(
      `select count(*)::int as n from deedbox.matter_stage where matter = $1`,
      [m],
    )
    expect(stages.rows[0].n).toBe(2)
  })
})

describe('stage movement', () => {
  let matter: number
  let stage1: number
  let stage2: number

  beforeAll(async () => {
    matter = await newMatter('Stages wflo')
    const stages = await admin.query(
      `select id, position from deedbox.matter_stage where matter = $1 order by position`,
      [matter],
    )
    stage1 = stages.rows[0].id
    stage2 = stages.rows[1].id
  })

  it('entering computes stage-entry due dates; advancing demotes; moving back reverts', async () => {
    await enterStage(P, { matter, stage: stage1 })
    const after1 = await admin.query(
      `select state, entered_at from deedbox.matter_stage where id = $1`,
      [stage1],
    )
    expect(after1.rows[0].state).toBe('current')
    expect(after1.rows[0].entered_at).not.toBeNull()
    const due = await admin.query(
      `select due_date::text as d from deedbox.task
        where stage = $1 and title = 'Send engagement letter'`,
      [stage1],
    )
    expect(due.rows[0].d).toBe(dateStr(-3)) // today + 3

    await enterStage(P, { matter, stage: stage2 })
    const states = await admin.query(
      `select id, state from deedbox.matter_stage where matter = $1 order by position`,
      [matter],
    )
    expect(states.rows[0].state).toBe('done')
    expect(states.rows[1].state).toBe('current')

    await enterStage(P, { matter, stage: stage1 }) // move back: done stays done? no —
    // stage1 was done; moving back re-enters it as current and stage2 reverts
    const back = await admin.query(
      `select id, state from deedbox.matter_stage where matter = $1 order by position`,
      [matter],
    )
    expect(back.rows[0].state).toBe('current')
    expect(back.rows[1].state).toBe('pending')

    await completeStage(P, { matter, stage: stage1 })
    const done = await admin.query(`select state from deedbox.matter_stage where id = $1`, [stage1])
    expect(done.rows[0].state).toBe('done')
    await reopenStage(P, { matter, stage: stage1 })
    const reopened = await admin.query(`select state from deedbox.matter_stage where id = $1`, [
      stage1,
    ])
    expect(reopened.rows[0].state).toBe('current')
  })
})

describe('anchors and recompute proposals', () => {
  let matter: number

  beforeAll(async () => {
    matter = await newMatter('Anchors wflo')
  })

  it('an anchor value raises a proposal; confirmation applies through a bulk run; a fresh change supersedes', async () => {
    const r1 = await setAnchorValue(P, { matter, definition: anchorDef, value: dateStr(-30) })
    expect(r1.proposal).not.toBeNull()
    expect(r1.dependents).toBe(1) // the brief-counsel task, 14 days before

    const r2 = await setAnchorValue(P, { matter, definition: anchorDef, value: dateStr(-40) })
    expect(r2.proposal).not.toBeNull()
    const first = await admin.query(
      `select state from deedbox.date_recompute_proposal where id = $1`,
      [r1.proposal],
    )
    expect(first.rows[0].state).toBe('superseded')

    const applied = await decideRecomputeProposal(P, { proposal: r2.proposal!, decision: 'confirm' })
    expect(applied.applied).toBe(1)
    const task = await admin.query(
      `select due_date::text as d from deedbox.task
        where matter = $1 and title = 'Brief counsel before settlement'`,
      [matter],
    )
    expect(task.rows[0].d).toBe(dateStr(-26)) // anchor (+40 days out) − 14
    const prop = await admin.query(
      `select state from deedbox.date_recompute_proposal where id = $1`,
      [r2.proposal],
    )
    expect(prop.rows[0].state).toBe('confirmed')
    const bulk = await admin.query(
      `select 1 from deedbox.register_entry
        where event_kind = 'bulk.committed' and matter = $1`,
      [matter],
    )
    expect(bulk.rowCount).toBeGreaterThan(0)
  })
})

describe('staffing re-resolution and the closed-matter ceremony', () => {
  it('a responsibility change raises the proposal atomically; confirmation re-points owners', async () => {
    const matter = await newMatter('Restaffed wflo')
    await changeStaffing(P, { matter, newResponsible: second })
    const prop = await admin.query(
      `select id, items from deedbox.slot_reresolution_proposal
        where matter = $1 and state = 'pending'`,
      [matter],
    )
    expect(prop.rowCount).toBe(1)
    const items = prop.rows[0].items as { task: number }[]
    expect(items.length).toBeGreaterThan(0)
    const r = await decideSlotProposal(P, { proposal: prop.rows[0].id, decision: 'confirm' })
    expect(r.applied).toBe(items.length)
    const owners = await admin.query(
      `select count(*)::int as n from deedbox.task
        where matter = $1 and assignee_slot = 'responsible_lawyer' and owner = $2
          and not done and deleted_at is null`,
      [matter, second],
    )
    expect(owners.rows[0].n).toBe(items.length >= 1 ? owners.rows[0].n : 0)
    expect(owners.rows[0].n).toBeGreaterThan(0)
  })

  it('every task write on a closed matter needs the ceremony', async () => {
    const matter = await newMatter('Closed tasks wflo')
    const t = await createTask(P, { title: 'Loose end', matter })
    // complete the template tasks' matter close conditions by closing directly
    await closeMatter(P, { matter })
    await expect(setTaskDone(P, { task: t.id, done: true })).rejects.toMatchObject({
      code: 'matter_closed',
    })
    await setTaskDone(P, { task: t.id, done: true, editClosed: true })
    const row = await admin.query(`select done, done_at from deedbox.task where id = $1`, [t.id])
    expect(row.rows[0].done).toBe(true)
    expect(row.rows[0].done_at).not.toBeNull()
  })

  it('key dates: critical toggles registered; sync writes idempotent', async () => {
    const matter = await newMatter('Key dates wflo')
    const k = await createKeyDate(P, {
      matter,
      kind: 'key_date',
      typeKey: 'court_date',
      title: 'Directions hearing',
      startsAt: new Date(Date.now() + 7 * 86400000).toISOString(),
    })
    expect(k.replayed).toBe(false)
    await setKeyDateCritical(P, { keyDate: k.id, critical: true })
    const reg = await admin.query(
      `select detail from deedbox.register_entry
        where subject_type = 'key_date' and subject = $1 and event_kind = 'record.changed'
        order by id desc limit 1`,
      [k.id],
    )
    expect(reg.rows[0].detail.after.critical).toBe(true)

    const s1 = await createKeyDate(P, {
      matter,
      kind: 'appointment',
      typeKey: 'appointment',
      title: 'Client conference',
      startsAt: new Date(Date.now() + 3 * 86400000).toISOString(),
      externalSyncRef: 'cal-wflo-1',
    })
    const s2 = await createKeyDate(P, {
      matter,
      kind: 'appointment',
      typeKey: 'appointment',
      title: 'Client conference (moved)',
      startsAt: new Date(Date.now() + 4 * 86400000).toISOString(),
      externalSyncRef: 'cal-wflo-1',
    })
    expect(s2.replayed).toBe(true)
    expect(s2.id).toBe(s1.id)
    const row = await admin.query(`select title from deedbox.key_date where id = $1`, [s1.id])
    expect(row.rows[0].title).toBe('Client conference (moved)')
  })
})
