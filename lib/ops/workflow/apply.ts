// Apply a template to a matter, and stage movement. Application copies:
// stages become pending matter-stage rows with template lineage; tasks
// resolve their slots against current staffing (assisting falls back to the
// responsible lawyer with a warning; an inactive named person likewise);
// stage-entry due rules rest null until the stage is entered; anchor and
// pack rules compute now where the matter carries the anchor value, else
// rest null on the awaiting-anchor panel. A task is never created without an
// owner, and application is whole or not at all.

import type { Principal, Tx } from '@/lib/db'
import { withPrincipal, emitRegister, OperationRefused } from '@/lib/db'
import { requireStaff } from '@/lib/ops/shared'
import type { DueRule } from './templates'

interface ResolvedSlot {
  owner: number
  warning: string | null
}

async function resolveSlotInTx(
  tx: Tx,
  matterId: number,
  slot: string,
  namedStaff: number | null,
  responsible: number,
): Promise<ResolvedSlot> {
  if (slot === 'responsible_lawyer') return { owner: responsible, warning: null }
  if (slot === 'assisting_staff') {
    const assisting = await tx.query(
      `select ms.staff from deedbox.matter_staffing ms
        where ms.matter = $1 and ms.role_on_matter = 'assisting' and ms.to_at is null
        order by ms.from_at, ms.id limit 1`,
      [matterId],
    )
    if (assisting.rowCount! > 0) return { owner: assisting.rows[0].staff as number, warning: null }
    return { owner: responsible, warning: 'no assisting staff — assigned to the responsible lawyer' }
  }
  if (namedStaff !== null) {
    const active = await tx.query(`select 1 from deedbox.staff_member where id = $1 and active`, [
      namedStaff,
    ])
    if (active.rowCount! > 0) return { owner: namedStaff, warning: null }
    return {
      owner: responsible,
      warning: 'the named person is inactive — assigned to the responsible lawyer',
    }
  }
  return { owner: responsible, warning: 'no named person — assigned to the responsible lawyer' }
}

/** Resolve a due rule to a date now, or null (awaiting stage entry / anchor). */
export async function resolveDueDateInTx(
  tx: Tx,
  firm: number,
  matterId: number,
  rule: DueRule,
  stageEntryDate: string | null,
): Promise<string | null> {
  if (rule.basis === 'none') return null
  if (rule.basis === 'stage_entry') {
    if (stageEntryDate === null) return null
    const r = await tx.query(`select ($1::date + $2::int)::text as d`, [
      stageEntryDate,
      rule.offset_days,
    ])
    return r.rows[0].d as string
  }
  if (rule.basis === 'anchor') {
    const anchor = await tx.query(
      `select value::text as v from deedbox.matter_anchor_date
        where matter = $1 and definition = $2`,
      [matterId, rule.anchor_definition],
    )
    if (anchor.rowCount === 0) return null
    const sign = rule.direction === 'before' ? -1 : 1
    const r = await tx.query(`select ($1::date + $2::int)::text as d`, [
      anchor.rows[0].v,
      sign * rule.offset_days,
    ])
    return r.rows[0].d as string
  }
  // pack_rule: the declaration's own basis is stage entry or a pack anchor
  const decl = await tx.query(
    `select d.body from deedbox.pack_declaration d
       join deedbox.firm f on f.id = $2
       join deedbox.country_pack cp on cp.id = f.country_pack
       join deedbox.pack_version v on v.id = d.pack_version and v.id = cp.active_version
      where d.rule_point = 'dates.rules' and d.discriminator = $1`,
    [rule.rule_key, firm],
  )
  if (decl.rowCount === 0) return null
  const body = decl.rows[0].body as DueRule
  if (body.basis === 'pack_rule') return null // a pack rule never nests
  return resolveDueDateInTx(tx, firm, matterId, body, stageEntryDate)
}

/**
 * The application body, callable inside the caller's transaction — matter
 * creation and intake conversion apply in their own committing transactions
 * through the published hook; the manual operation wraps this the same way.
 */
export async function applyTemplateInTx(
  tx: Tx,
  p: Principal,
  matterId: number,
  templateId: number,
): Promise<{ stages: number; tasks: number; warnings: string[] }> {
  const m = await tx.query(
    `select id, status, responsible_lawyer, practice_area from deedbox.matter where id = $1 for update`,
    [matterId],
  )
  if (m.rowCount === 0) throw new OperationRefused('not_found', 'matter not found')
  if (m.rows[0].status !== 'open' && m.rows[0].status !== 'on_hold') {
    throw new OperationRefused('matter_closed', 'templates apply to open matters')
  }
  const t = await tx.query(
    `select id, name, practice_area from deedbox.workflow_template where id = $1 and active`,
    [templateId],
  )
  if (t.rowCount === 0) throw new OperationRefused('not_found', 'no active template by that id')
  if (t.rows[0].practice_area !== m.rows[0].practice_area) {
    throw new OperationRefused('wrong_area', "the template belongs to another practice area")
  }
  // a second application replaces only an untouched pending skeleton
  const existing = await tx.query(
    `select count(*)::int as total,
            count(*) filter (where state <> 'pending')::int as moved
       from deedbox.matter_stage where matter = $1`,
    [matterId],
  )
  if ((existing.rows[0].total as number) > 0) {
    if ((existing.rows[0].moved as number) > 0) {
      throw new OperationRefused(
        'already_templated',
        'this matter already carries stages that have moved — a template no longer applies',
      )
    }
    const stageTasks = await tx.query(
      `select count(*)::int as n from deedbox.task tk
        join deedbox.matter_stage ms on ms.id = tk.stage
       where ms.matter = $1 and (tk.done or tk.deleted_at is not null
             or tk.origin <> 'template')`,
      [matterId],
    )
    if ((stageTasks.rows[0].n as number) > 0) {
      throw new OperationRefused(
        'already_templated',
        'this matter carries modified template tasks — a template no longer applies',
      )
    }
    await tx.query(
      `update deedbox.task set deleted_at = now(), deleted_by = $2
        where matter = $1 and stage is not null and deleted_at is null`,
      [matterId, p.id],
    )
    await tx.query(
      `update deedbox.task set stage = null
        where matter = $1 and stage is not null`,
      [matterId],
    )
    await tx.query(`delete from deedbox.matter_stage where matter = $1`, [matterId])
  }

  const responsible = m.rows[0].responsible_lawyer as number
  const stages = await tx.query(
    `select id, name, position from deedbox.template_stage where template = $1 order by position`,
    [templateId],
  )
  const warnings: string[] = []
  let taskCount = 0
  for (const s of stages.rows) {
    const stageRow = await tx.query(
      `insert into deedbox.matter_stage (matter, name, position, template_origin)
       values ($1, $2, $3, $4) returning id`,
      [matterId, s.name, s.position, s.id],
    )
    const tasks = await tx.query(
      `select title, assignee_slot, named_staff, due_rule from deedbox.template_task
        where stage = $1 order by id`,
      [s.id],
    )
    for (const task of tasks.rows) {
      const slot = await resolveSlotInTx(
        tx,
        matterId,
        task.assignee_slot as string,
        task.named_staff as number | null,
        responsible,
      )
      if (slot.warning) warnings.push(`${task.title}: ${slot.warning}`)
      const rule = task.due_rule as DueRule
      const due = await resolveDueDateInTx(tx, p.firm, matterId, rule, null)
      const created = await tx.query(
        `insert into deedbox.task
           (matter, stage, title, owner, due_date, due_rule, assignee_slot, origin)
         values ($1, $2, $3, $4, $5::date, $6, $7, 'template') returning id`,
        [
          matterId,
          stageRow.rows[0].id,
          task.title,
          slot.owner,
          due,
          JSON.stringify(rule),
          task.assignee_slot,
        ],
      )
      taskCount += 1
      await emitRegister(tx, p, {
        kind: 'record.created',
        subjectType: 'task',
        subject: created.rows[0].id as number,
        matter: matterId,
      })
    }
  }
  await emitRegister(tx, p, {
    kind: 'record.created',
    subjectType: 'workflow_application',
    subject: matterId,
    matter: matterId,
    detail: {
      template: templateId,
      template_name: t.rows[0].name,
      stages: stages.rowCount,
      tasks: taskCount,
      warnings,
    },
  })
  return { stages: stages.rowCount!, tasks: taskCount, warnings }
}

/** The manual application operation. */
export async function applyTemplateToMatter(
  p: Principal,
  input: { matter: number; template: number },
): Promise<{ stages: number; tasks: number; warnings: string[] }> {
  requireStaff(p)
  return withPrincipal(p, (tx) => applyTemplateInTx(tx, p, input.matter, input.template))
}

/** Enter a stage: the previous current demotes in the same act. */
export async function enterStage(
  p: Principal,
  input: { matter: number; stage: number; recomputeStageEntryDates?: boolean },
): Promise<void> {
  requireStaff(p)
  await withPrincipal(p, async (tx) => {
    const m = await tx.query(
      `select id, status from deedbox.matter where id = $1 for update`,
      [input.matter],
    )
    if (m.rowCount === 0) throw new OperationRefused('not_found', 'matter not found')
    if (m.rows[0].status !== 'open' && m.rows[0].status !== 'on_hold') {
      throw new OperationRefused('matter_closed', 'stages move on open matters only')
    }
    const target = await tx.query(
      `select id, state, position, entered_at from deedbox.matter_stage
        where id = $1 and matter = $2 for update`,
      [input.stage, input.matter],
    )
    if (target.rowCount === 0) throw new OperationRefused('not_found', 'stage not found on this matter')
    const current = await tx.query(
      `select id, position from deedbox.matter_stage
        where matter = $1 and state = 'current' for update`,
      [input.matter],
    )
    const movingForward =
      current.rowCount === 0 || (current.rows[0].position as number) < (target.rows[0].position as number)
    if (current.rowCount! > 0) {
      await tx.query(
        `update deedbox.matter_stage set state = $2 where id = $1`,
        [current.rows[0].id, movingForward ? 'done' : 'pending'],
      )
      if (!movingForward) {
        // stages between the target and the old current revert to pending;
        // done stages stay done unless explicitly reopened
        await tx.query(
          `update deedbox.matter_stage set state = 'pending'
            where matter = $1 and state = 'current'`,
          [input.matter],
        )
      }
    }
    const firstEntry = target.rows[0].entered_at === null
    await tx.query(
      `update deedbox.matter_stage
          set state = 'current', entered_at = coalesce(entered_at, now())
        where id = $1`,
      [input.stage],
    )
    // stage-entry due dates compute on first entry, or on re-entry only
    // when the user confirms recomputation
    if (firstEntry || input.recomputeStageEntryDates) {
      const tasks = await tx.query(
        `select id, due_rule from deedbox.task
          where stage = $1 and not done and deleted_at is null and due_rule is not null`,
        [input.stage],
      )
      const today = await tx.query(`select current_date::text as d`)
      for (const task of tasks.rows) {
        const rule = task.due_rule as DueRule
        if (rule.basis === 'stage_entry' || rule.basis === 'pack_rule') {
          const due = await resolveDueDateInTx(tx, p.firm, input.matter, rule, today.rows[0].d as string)
          if (due !== null) {
            await tx.query(`update deedbox.task set due_date = $2::date where id = $1`, [
              task.id,
              due,
            ])
          }
        }
      }
    }
    await emitRegister(tx, p, {
      kind: 'record.changed',
      subjectType: 'matter_stage',
      subject: input.stage,
      matter: input.matter,
      detail: {
        entered: true,
        demoted_previous: current.rowCount! > 0 ? current.rows[0].id : null,
        direction: movingForward ? 'forward' : 'back',
      },
    })
  })
}

/** Complete the current (final) stage without entering another. */
export async function completeStage(p: Principal, input: { matter: number; stage: number }): Promise<void> {
  requireStaff(p)
  await withPrincipal(p, async (tx) => {
    const r = await tx.query(
      `update deedbox.matter_stage set state = 'done'
        where id = $1 and matter = $2 and state = 'current' returning id`,
      [input.stage, input.matter],
    )
    if (r.rowCount === 0) throw new OperationRefused('not_current', 'only the current stage completes')
    await emitRegister(tx, p, {
      kind: 'record.changed',
      subjectType: 'matter_stage',
      subject: input.stage,
      matter: input.matter,
      detail: { before: { state: 'current' }, after: { state: 'done' } },
    })
  })
}

/** Reopen a done stage as current. */
export async function reopenStage(p: Principal, input: { matter: number; stage: number }): Promise<void> {
  requireStaff(p)
  await withPrincipal(p, async (tx) => {
    const m = await tx.query(`select status from deedbox.matter where id = $1 for update`, [
      input.matter,
    ])
    if (m.rowCount === 0 || (m.rows[0].status !== 'open' && m.rows[0].status !== 'on_hold')) {
      throw new OperationRefused('matter_closed', 'stages reopen on open matters only')
    }
    const current = await tx.query(
      `update deedbox.matter_stage set state = 'pending'
        where matter = $1 and state = 'current' returning id`,
      [input.matter],
    )
    const r = await tx.query(
      `update deedbox.matter_stage set state = 'current'
        where id = $1 and matter = $2 and state = 'done' returning id`,
      [input.stage, input.matter],
    )
    if (r.rowCount === 0) throw new OperationRefused('not_done', 'only a done stage reopens')
    await emitRegister(tx, p, {
      kind: 'record.changed',
      subjectType: 'matter_stage',
      subject: input.stage,
      matter: input.matter,
      detail: { reopened: true, demoted: current.rowCount! > 0 ? current.rows[0].id : null },
    })
  })
}
