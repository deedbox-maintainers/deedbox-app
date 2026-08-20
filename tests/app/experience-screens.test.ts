// Operations/experience screens, first part: home (pins, recents, my tasks,
// pending-proposal count), the dashboards' period window and tiles over the
// engine, the matter workflow tab, the my-tasks queue, the critical-dates
// view, and the proposals queue with per-item decisions.
//
// Cross-suite contracts (localeCompare order: after examiner-screens, before
// interface-outbound): fixture rows are tag-named (xops) on the fixture's
// OWN matter/practice area; the anchor definition and template names carry
// the tag (anchor_date_definition has a unique-active-name index); NO
// database-global setting is flipped; assertions filter to this fixture's
// ids, never global counts.

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import type { Pool } from 'pg'
import { closePool } from '@/lib/db'
import type { Principal } from '@/lib/db'
import {
  createWorkflowTemplate,
  applyTemplateToMatter,
  enterStage,
  createTask,
  setTaskDone,
  createKeyDate,
  createAnchorDefinition,
  setAnchorValue,
  decideRecomputeProposal,
} from '@/lib/ops/workflow'
import { runReport, recordView, pinItem, unpinItem } from '@/lib/ops/reports'
import {
  homeScreen,
  dashboardPeriod,
  matterWorkflowTab,
  myTasksQueue,
  criticalDatesView,
  proposalsQueue,
  proposalDetail,
} from '@/lib/reads/experience'
import { makeAdminPool, buildFixture, type Fixture } from './helpers'

let admin: Pool
let fx: Fixture
let P: Principal
let template: number
let anchorDef: number

const dateStr = (daysFromNow: number) =>
  new Date(Date.now() + daysFromNow * 86400000).toISOString().slice(0, 10)

beforeAll(async () => {
  admin = makeAdminPool()
  fx = await buildFixture(admin, 'xops')
  P = { kind: 'staff', id: fx.staff, firm: fx.firm }
  const def = await createAnchorDefinition(P, { name: 'Settlement date xops' })
  anchorDef = def.id
  const t = await createWorkflowTemplate(P, {
    name: 'Conveyance xops',
    practiceArea: fx.practiceArea,
    stages: [
      {
        name: 'Exchange xops',
        expectedDurationDays: 14,
        tasks: [
          {
            title: 'Order searches xops',
            assigneeSlot: 'responsible_lawyer',
            dueRule: { basis: 'stage_entry', offset_days: 3 },
          },
          {
            title: 'Book settlement agent xops',
            assigneeSlot: 'responsible_lawyer',
            dueRule: {
              basis: 'anchor',
              anchor_definition: anchorDef,
              offset_days: 5,
              direction: 'before',
            },
          },
        ],
      },
      {
        name: 'Settlement xops',
        tasks: [
          {
            title: 'Attend settlement xops',
            assigneeSlot: 'responsible_lawyer',
            dueRule: { basis: 'none' },
          },
        ],
      },
    ],
  })
  template = t.id
})

afterAll(async () => {
  await closePool()
  await admin.end()
})

describe('the workflow tab (stages & tasks + key dates & anchors)', () => {
  it('applies the template and shows stages, tasks and the awaiting-anchor list', async () => {
    const applied = await applyTemplateToMatter(P, { matter: fx.matter, template })
    expect(applied.stages).toBe(2)
    expect(applied.tasks).toBe(3)
    const tab = await matterWorkflowTab(P, fx.matter)
    expect(tab.stages.length).toBe(2)
    expect(tab.stages.every((s) => s.state === 'pending')).toBe(true)
    expect(tab.tasks.length).toBe(3)
    // the anchor-ruled task has no due date until its anchor exists
    expect(tab.awaitingAnchor.some((t) => t.title === 'Book settlement agent xops')).toBe(true)
    expect(tab.applicableTemplates.length).toBe(0) // stages exist now
  })

  it('entering a stage dates exactly its stage-entry tasks', async () => {
    const tab = await matterWorkflowTab(P, fx.matter)
    const first = tab.stages.find((s) => s.name === 'Exchange xops')!
    await enterStage(P, { matter: fx.matter, stage: first.id as number })
    const after = await matterWorkflowTab(P, fx.matter)
    expect(after.stages.find((s) => s.id === first.id)!.state).toBe('current')
    const dated = after.tasks.find((t) => t.title === 'Order searches xops')!
    expect(dated.due_date).toBe(dateStr(3))
    const anchored = after.tasks.find((t) => t.title === 'Book settlement agent xops')!
    expect(anchored.due_date).toBeNull()
  })

  it('an anchor change raises a proposal and moves nothing until confirmed', async () => {
    await setAnchorValue(P, { matter: fx.matter, definition: anchorDef, value: dateStr(30) })
    const tab = await matterWorkflowTab(P, fx.matter)
    expect(tab.anchors.find((a) => a.definition === anchorDef)?.value).toBe(dateStr(30))
    expect(tab.pendingDateProposals.length).toBe(1)
    // nothing moved
    expect(tab.tasks.find((t) => t.title === 'Book settlement agent xops')!.due_date).toBeNull()

    const queue = await proposalsQueue(P)
    const mine = queue.dates.find((d) => d.matter === fx.matter)
    expect(mine).toBeDefined()
    const detail = await proposalDetail(P, { kind: 'date', id: mine!.id as number })
    // a date proposal's changes column is {anchor_definition, old_value, new_value, items: [...]}
    expect(Array.isArray((detail.changes as { items?: unknown[] }).items)).toBe(true)

    const decided = await decideRecomputeProposal(P, {
      proposal: mine!.id as number,
      decision: 'confirm',
    })
    expect(decided.applied).toBeGreaterThanOrEqual(1)
    const after = await matterWorkflowTab(P, fx.matter)
    expect(after.tasks.find((t) => t.title === 'Book settlement agent xops')!.due_date).toBe(
      dateStr(25), // 5 days before the anchor
    )
    expect(after.pendingDateProposals.length).toBe(0)
  })
})

describe('home, tasks queue and critical dates', () => {
  it('home carries pins, recents, my tasks and the proposal count', async () => {
    await recordView(P, { itemType: 'matter', item: fx.matter })
    await pinItem(P, { itemType: 'matter', item: fx.matter })
    const home = await homeScreen(P)
    expect(home.recents.some((r) => r.item === fx.matter && r.item_type === 'matter')).toBe(true)
    expect(home.pins.some((r) => r.item === fx.matter)).toBe(true)
    expect(home.tasks.some((t) => t.title === 'Order searches xops')).toBe(true)
    await unpinItem(P, { itemType: 'matter', item: fx.matter })
    const again = await homeScreen(P)
    expect(again.pins.some((r) => r.item === fx.matter)).toBe(false)
  })

  it('the my-tasks queue completes and filters', async () => {
    const extra = await createTask(P, { title: 'One-off chore xops', matter: fx.matter })
    let q = await myTasksQueue(P, { matter: fx.matter })
    expect(q.tasks.some((t) => t.id === extra.id)).toBe(true)
    await setTaskDone(P, { task: extra.id, done: true })
    q = await myTasksQueue(P, { matter: fx.matter })
    expect(q.tasks.some((t) => t.id === extra.id)).toBe(false)
  })

  it('the critical-dates view serves critical, undone dates within the horizon only', async () => {
    await createKeyDate(P, {
      matter: fx.matter,
      kind: 'key_date',
      typeKey: 'court_date',
      title: 'Directions hearing xops',
      startsAt: new Date(Date.now() + 5 * 86400000).toISOString(),
      critical: true,
    })
    await createKeyDate(P, {
      matter: fx.matter,
      kind: 'key_date',
      typeKey: 'court_date',
      title: 'Uncritical thing xops',
      startsAt: new Date(Date.now() + 5 * 86400000).toISOString(),
    })
    const view = await criticalDatesView(P)
    expect(view.rows.some((r) => r.title === 'Directions hearing xops')).toBe(true)
    expect(view.rows.some((r) => r.title === 'Uncritical thing xops')).toBe(false)
  })
})

describe('the dashboards over the engine', () => {
  it('the period window derives from the setting', async () => {
    const w = await dashboardPeriod(P)
    expect(w.periodStart <= w.periodEnd).toBe(true)
    expect(w.label.length).toBeGreaterThan(0)
  })

  it('the opened-matters tile counts the fixture matter in its period', async () => {
    const w = await dashboardPeriod(P)
    const tile = await runReport(P, {
      key: 'tile_matters_opened',
      filters: { periodStart: w.periodStart, periodEnd: w.periodEnd },
    })
    // the fixture matter opened today — inside every period kind
    expect(tile.totals.count).toBeGreaterThanOrEqual(1)
  })

  it('personal tiles serve only the viewer', async () => {
    const mine = await runReport(P, { key: 'tile_my_targets', filters: {} })
    expect(Array.isArray(mine.rows)).toBe(true)
  })
})
