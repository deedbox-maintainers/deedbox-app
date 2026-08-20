// Workflow templates. A template is a copy source: deactivation never
// touches applied instances, child edits affect future applications only,
// and a template applied at least once is never hard-deleted. Due rules
// validate against their schema at save — stage_entry offsets, anchor
// rules naming an active definition, none, or a pack rule whose key exists
// in the active pack version's `dates.rules` declarations.
//
// Divergence: the schema shipped template tasks without position
// and detail columns (0015) — order within a stage is creation order, and
// task detail lives on the instantiated task rows.

import type { Principal, Tx } from '@/lib/db'
import { withPrincipal, emitRegister, OperationRefused } from '@/lib/db'
import { requireCapability } from '@/lib/ops/shared'

export type DueRule =
  | { basis: 'stage_entry'; offset_days: number }
  | { basis: 'anchor'; anchor_definition: number; offset_days: number; direction: 'before' | 'after' }
  | { basis: 'none' }
  | { basis: 'pack_rule'; rule_key: string }

export interface TemplateTaskInput {
  title: string
  assigneeSlot: 'responsible_lawyer' | 'assisting_staff' | 'named_person'
  namedStaff?: number
  dueRule: DueRule
}

export interface TemplateStageInput {
  name: string
  expectedDurationDays?: number
  tasks: TemplateTaskInput[]
}

export async function validateDueRuleInTx(tx: Tx, firm: number, rule: DueRule): Promise<void> {
  if (rule.basis === 'stage_entry') {
    if (!Number.isInteger(rule.offset_days) || rule.offset_days < 0) {
      throw new OperationRefused('bad_due_rule', 'a stage-entry rule offsets by a whole number of days, zero or above')
    }
    return
  }
  if (rule.basis === 'anchor') {
    if (!Number.isInteger(rule.offset_days) || (rule.direction !== 'before' && rule.direction !== 'after')) {
      throw new OperationRefused('bad_due_rule', 'an anchor rule carries whole-day offsets and a direction')
    }
    const def = await tx.query(
      `select id from deedbox.anchor_date_definition where id = $1 and active`,
      [rule.anchor_definition],
    )
    if (def.rowCount === 0) {
      throw new OperationRefused('bad_due_rule', 'the anchor rule names no active anchor definition')
    }
    return
  }
  if (rule.basis === 'none') return
  if (rule.basis === 'pack_rule') {
    const decl = await tx.query(
      `select 1 from deedbox.pack_declaration d
         join deedbox.firm f on f.id = $2
         join deedbox.country_pack cp on cp.id = f.country_pack
         join deedbox.pack_version v on v.id = d.pack_version and v.id = cp.active_version
        where d.rule_point = 'dates.rules' and d.discriminator = $1`,
      [rule.rule_key, firm],
    )
    if (decl.rowCount === 0) {
      throw new OperationRefused('bad_due_rule', `the active pack declares no date rule ${rule.rule_key}`)
    }
    return
  }
  throw new OperationRefused('bad_due_rule', 'unknown due-rule basis')
}

async function insertStagesInTx(
  tx: Tx,
  firm: number,
  templateId: number,
  stages: TemplateStageInput[],
): Promise<void> {
  for (let i = 0; i < stages.length; i++) {
    const s = stages[i]
    if (!s.name.trim()) throw new OperationRefused('name_required', 'every stage carries a name')
    const stage = await tx.query(
      `insert into deedbox.template_stage (template, name, position, expected_duration_days)
       values ($1, $2, $3::int, $4) returning id`,
      [templateId, s.name, i + 1, s.expectedDurationDays ?? null],
    )
    for (const t of s.tasks) {
      if (!t.title.trim()) throw new OperationRefused('title_required', 'every task carries a title')
      if ((t.assigneeSlot === 'named_person') !== (t.namedStaff !== undefined)) {
        throw new OperationRefused('bad_slot', 'a named-person task names its person; other slots never do')
      }
      if (t.namedStaff !== undefined) {
        const active = await tx.query(
          `select 1 from deedbox.staff_member where id = $1 and active`,
          [t.namedStaff],
        )
        if (active.rowCount === 0) {
          throw new OperationRefused('staff_inactive', 'named-person tasks name active staff')
        }
      }
      await validateDueRuleInTx(tx, firm, t.dueRule)
      await tx.query(
        `insert into deedbox.template_task (stage, title, assignee_slot, named_staff, due_rule)
         values ($1, $2, $3, $4, $5)`,
        [
          stage.rows[0].id,
          t.title,
          t.assigneeSlot,
          t.namedStaff ?? null,
          JSON.stringify(t.dueRule),
        ],
      )
    }
  }
}

/** Create a template with its whole stage/task tree. */
export async function createWorkflowTemplate(
  p: Principal,
  input: {
    name: string
    practiceArea: number
    description?: string
    stages: TemplateStageInput[]
  },
): Promise<{ id: number }> {
  if (!input.name.trim()) throw new OperationRefused('name_required', 'a template carries a name')
  if (input.stages.length === 0) {
    throw new OperationRefused('stages_required', 'a template carries at least one stage')
  }
  return withPrincipal(p, async (tx) => {
    await requireCapability(tx, p, 'workflow.manage')
    const area = await tx.query(
      `select id from deedbox.practice_area where id = $1 and active`,
      [input.practiceArea],
    )
    if (area.rowCount === 0) {
      throw new OperationRefused('area_inactive', 'templates attach to active practice areas')
    }
    const r = await tx.query(
      `insert into deedbox.workflow_template (name, practice_area)
       values ($1, $2) returning id`,
      [input.name, input.practiceArea],
    )
    await insertStagesInTx(tx, p.firm, r.rows[0].id as number, input.stages)
    await emitRegister(tx, p, {
      kind: 'record.created',
      subjectType: 'workflow_template',
      subject: r.rows[0].id as number,
      detail: {
        name: input.name,
        practice_area: input.practiceArea,
        stages: input.stages.length,
        tasks: input.stages.reduce((s, x) => s + x.tasks.length, 0),
      },
    })
    return { id: r.rows[0].id as number }
  })
}

/** Replace a template's children; future applications only. */
export async function replaceTemplateStages(
  p: Principal,
  input: { template: number; stages: TemplateStageInput[] },
): Promise<void> {
  if (input.stages.length === 0) {
    throw new OperationRefused('stages_required', 'a template carries at least one stage')
  }
  await withPrincipal(p, async (tx) => {
    await requireCapability(tx, p, 'workflow.manage')
    const t = await tx.query(
      `select id from deedbox.workflow_template where id = $1 for update`,
      [input.template],
    )
    if (t.rowCount === 0) throw new OperationRefused('not_found', 'template not found')
    // applied instances are copies: replacing children never touches them,
    // but stage rows referenced by instances (template_origin) must survive
    const referenced = await tx.query(
      `select count(*)::int as n from deedbox.matter_stage ms
        join deedbox.template_stage ts on ts.id = ms.template_origin
       where ts.template = $1`,
      [input.template],
    )
    if ((referenced.rows[0].n as number) > 0) {
      throw new OperationRefused(
        'applied_template',
        'this template has applied instances — deactivate it and create a successor instead',
      )
    }
    await tx.query(
      `delete from deedbox.template_task where stage in
         (select id from deedbox.template_stage where template = $1)`,
      [input.template],
    )
    await tx.query(`delete from deedbox.template_stage where template = $1`, [input.template])
    await insertStagesInTx(tx, p.firm, input.template, input.stages)
    await emitRegister(tx, p, {
      kind: 'record.changed',
      subjectType: 'workflow_template',
      subject: input.template,
      detail: { stages_replaced: input.stages.length },
    })
  })
}

/** Deactivate / reactivate. */
export async function setWorkflowTemplateActive(
  p: Principal,
  input: { template: number; active: boolean },
): Promise<void> {
  await withPrincipal(p, async (tx) => {
    await requireCapability(tx, p, 'workflow.manage')
    const r = await tx.query(
      `update deedbox.workflow_template set active = $2 where id = $1 and active <> $2
       returning id`,
      [input.template, input.active],
    )
    if (r.rowCount === 0) throw new OperationRefused('no_change', 'the template is already in that state')
    await emitRegister(tx, p, {
      kind: 'record.changed',
      subjectType: 'workflow_template',
      subject: input.template,
      detail: { before: { active: !input.active }, after: { active: input.active } },
    })
  })
}
