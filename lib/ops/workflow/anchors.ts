// Anchor values raise recompute proposals — no dependent date changes yet;
// deciding a proposal applies accepted items through a one-run bulk
// operation; and a staffing change raises a slot re-resolution proposal in
// the SAME transaction as the staffing write, through the published hook.
// The freshest computation is the only pending proposal — the schema
// supersedes on insert.
//
// Divergence: the date proposal row is lean (matter, changes, state) — the
// anchor identity, old/new values and per-item decisions travel in the
// changes document and the decision's register entry.

import type { Principal, Tx } from '@/lib/db'
import { withPrincipal, emitRegister, OperationRefused } from '@/lib/db'
import { requireStaff, requireCapability } from '@/lib/ops/shared'
import type { DueRule } from './templates'
import { resolveDueDateInTx } from './apply'

interface ProposedChange {
  task: number
  title: string
  field: 'due_date'
  old_value: string | null
  new_value: string | null
  rule: DueRule
}

/** Compute every dependent date on the matter for one anchor definition. */
async function computeDependentsInTx(
  tx: Tx,
  firm: number,
  matterId: number,
  definitionId: number,
): Promise<ProposedChange[]> {
  const tasks = await tx.query(
    `select id, title, due_date::text as due, due_rule from deedbox.task
      where matter = $1 and not done and deleted_at is null and due_rule is not null`,
    [matterId],
  )
  const out: ProposedChange[] = []
  for (const t of tasks.rows) {
    const rule = t.due_rule as DueRule
    let names = false
    if (rule.basis === 'anchor' && rule.anchor_definition === definitionId) names = true
    if (rule.basis === 'pack_rule') {
      const decl = await tx.query(
        `select d.body from deedbox.pack_declaration d
           join deedbox.firm f on f.id = $2
           join deedbox.country_pack cp on cp.id = f.country_pack
           join deedbox.pack_version v on v.id = d.pack_version and v.id = cp.active_version
          where d.rule_point = 'dates.rules' and d.discriminator = $1`,
        [rule.rule_key, firm],
      )
      const body = decl.rowCount! > 0 ? (decl.rows[0].body as DueRule) : null
      if (body && body.basis === 'anchor' && body.anchor_definition === definitionId) names = true
    }
    if (!names) continue
    const fresh = await resolveDueDateInTx(tx, firm, matterId, rule, null)
    if (fresh !== (t.due as string | null)) {
      out.push({
        task: t.id as number,
        title: t.title as string,
        field: 'due_date',
        old_value: t.due as string | null,
        new_value: fresh,
        rule,
      })
    }
  }
  return out
}

/** Set or change an anchor value; dependents move only by proposal. */
export async function setAnchorValue(
  p: Principal,
  input: { matter: number; definition: number; value: string },
): Promise<{ proposal: number | null; dependents: number }> {
  return withPrincipal(p, async (tx) => {
    const def = await tx.query(
      `select id, practice_areas from deedbox.anchor_date_definition where id = $1 and active`,
      [input.definition],
    )
    if (def.rowCount === 0) throw new OperationRefused('not_found', 'no active anchor definition')
    const m = await tx.query(
      `select id, practice_area from deedbox.matter where id = $1 for update`,
      [input.matter],
    )
    if (m.rowCount === 0) throw new OperationRefused('not_found', 'matter not found')
    const areas = def.rows[0].practice_areas as number[] | null
    if (areas !== null && !areas.includes(m.rows[0].practice_area as number)) {
      throw new OperationRefused('wrong_area', 'the definition does not apply to this practice area')
    }
    const existing = await tx.query(
      `select id, value::text as v from deedbox.matter_anchor_date
        where matter = $1 and definition = $2`,
      [input.matter, input.definition],
    )
    const oldValue = existing.rowCount! > 0 ? (existing.rows[0].v as string) : null
    if (existing.rowCount! > 0) {
      await tx.query(`update deedbox.matter_anchor_date set value = $2::date where id = $1`, [
        existing.rows[0].id,
        input.value,
      ])
    } else {
      await tx.query(
        `insert into deedbox.matter_anchor_date (matter, definition, value)
         values ($1, $2, $3::date)`,
        [input.matter, input.definition, input.value],
      )
    }
    await emitRegister(tx, p, {
      kind: 'record.changed',
      subjectType: 'matter_anchor_date',
      subject: input.matter,
      matter: input.matter,
      detail: { definition: input.definition, before: oldValue, after: input.value },
    })

    const dependents = await computeDependentsInTx(tx, p.firm, input.matter, input.definition)
    if (dependents.length === 0) return { proposal: null, dependents: 0 }
    const proposal = await tx.query(
      `insert into deedbox.date_recompute_proposal (matter, changes)
       values ($1, $2) returning id`,
      [
        input.matter,
        JSON.stringify({
          anchor_definition: input.definition,
          old_value: oldValue,
          new_value: input.value,
          items: dependents,
        }),
      ],
    )
    await emitRegister(tx, p, {
      kind: 'record.created',
      subjectType: 'date_recompute_proposal',
      subject: proposal.rows[0].id as number,
      matter: input.matter,
      detail: { anchor_definition: input.definition, dependents: dependents.length },
    })
    return { proposal: proposal.rows[0].id as number, dependents: dependents.length }
  })
}

/** Decide a recompute proposal. */
export async function decideRecomputeProposal(
  p: Principal,
  input: {
    proposal: number
    decision: 'confirm' | 'reject'
    /** task ids to apply; omitted = every proposed item. */
    acceptTasks?: number[]
    note?: string
  },
): Promise<{ applied: number; skipped: { task: number; reason: string }[] }> {
  requireStaff(p)
  return withPrincipal(p, async (tx) => {
    const prop = await tx.query(
      `select id, matter, changes from deedbox.date_recompute_proposal
        where id = $1 and state = 'pending' for update`,
      [input.proposal],
    )
    if (prop.rowCount === 0) throw new OperationRefused('not_pending', 'no pending proposal by that id')
    const matter = prop.rows[0].matter as number
    const changes = prop.rows[0].changes as { items: ProposedChange[] }

    if (input.decision === 'reject') {
      await tx.query(
        `update deedbox.date_recompute_proposal set state = 'rejected' where id = $1`,
        [input.proposal],
      )
      await emitRegister(tx, p, {
        kind: 'record.changed',
        subjectType: 'date_recompute_proposal',
        subject: input.proposal,
        matter,
        reason: input.note,
        detail: { decision: 'rejected' },
      })
      return { applied: 0, skipped: [] }
    }

    const accept = new Set(input.acceptTasks ?? changes.items.map((i) => i.task))
    const window = await tx.query(
      `select coalesce((deedbox.current_setting_value('undo.bulk_window_days') #>> '{}')::int, 7) as d`,
    )
    const op = await tx.query(
      `insert into deedbox.bulk_operation
         (operation_kind, dry_run_summary, committed_at, committed_by, reversible_until)
       values ('date_recompute', $1, now(), $2, now() + make_interval(days => $3::int))
       returning id`,
      [JSON.stringify(changes), p.id, window.rows[0].d],
    )
    let applied = 0
    const skipped: { task: number; reason: string }[] = []
    const decisions: { task: number; accepted: boolean; outcome: string }[] = []
    for (const item of changes.items) {
      if (!accept.has(item.task)) {
        decisions.push({ task: item.task, accepted: false, outcome: 'kept' })
        continue
      }
      const t = await tx.query(
        `select id from deedbox.task where id = $1 and deleted_at is null and not done for update`,
        [item.task],
      )
      if (t.rowCount === 0) {
        skipped.push({ task: item.task, reason: 'task deleted or done since the proposal was raised' })
        decisions.push({ task: item.task, accepted: true, outcome: 'skipped' })
        continue
      }
      await tx.query(
        `insert into deedbox.bulk_operation_item (operation, entity_type, entity, before, after)
         values ($1, 'task', $2, $3, $4)`,
        [
          op.rows[0].id,
          item.task,
          JSON.stringify({ due_date: item.old_value }),
          JSON.stringify({ due_date: item.new_value }),
        ],
      )
      await tx.query(`update deedbox.task set due_date = $2::date where id = $1`, [
        item.task,
        item.new_value,
      ])
      await emitRegister(tx, p, {
        kind: 'record.changed',
        subjectType: 'task',
        subject: item.task,
        matter,
        detail: { before: { due_date: item.old_value }, after: { due_date: item.new_value } },
      })
      applied += 1
      decisions.push({ task: item.task, accepted: true, outcome: 'applied' })
    }
    await tx.query(
      `update deedbox.date_recompute_proposal set state = 'confirmed' where id = $1`,
      [input.proposal],
    )
    await emitRegister(tx, p, {
      kind: 'bulk.committed',
      subjectType: 'bulk_operation',
      subject: op.rows[0].id as number,
      matter,
      bulkOperation: op.rows[0].id as number,
      detail: { proposal: input.proposal, applied, decisions, note: input.note ?? null },
    })
    return { applied, skipped }
  })
}

/**
 * The staffing hook body — called INSIDE the matters domain's staffing
 * transaction: compute open slotted tasks whose slot now resolves to a
 * different owner and raise (or supersede into) the one pending proposal.
 */
export async function raiseSlotReresolutionInTx(
  tx: Tx,
  p: Principal,
  matterId: number,
): Promise<{ proposal: number | null; items: number }> {
  const m = await tx.query(
    `select responsible_lawyer from deedbox.matter where id = $1`,
    [matterId],
  )
  if (m.rowCount === 0) return { proposal: null, items: 0 }
  const responsible = m.rows[0].responsible_lawyer as number
  const tasks = await tx.query(
    `select id, title, owner, assignee_slot from deedbox.task
      where matter = $1 and not done and deleted_at is null and assignee_slot is not null`,
    [matterId],
  )
  const items: { task: number; title: string; slot: string; current_owner: number; proposed_owner: number }[] = []
  for (const t of tasks.rows) {
    let proposed = responsible
    if (t.assignee_slot === 'assisting_staff') {
      const assisting = await tx.query(
        `select staff from deedbox.matter_staffing
          where matter = $1 and role_on_matter = 'assisting' and to_at is null
          order by from_at, id limit 1`,
        [matterId],
      )
      proposed = assisting.rowCount! > 0 ? (assisting.rows[0].staff as number) : responsible
    } else if (t.assignee_slot === 'named_person') {
      continue // a named person never re-points on staffing changes
    }
    if (proposed !== t.owner) {
      items.push({
        task: t.id as number,
        title: t.title as string,
        slot: t.assignee_slot as string,
        current_owner: t.owner as number,
        proposed_owner: proposed,
      })
    }
  }
  if (items.length === 0) return { proposal: null, items: 0 }
  await tx.query(
    `update deedbox.slot_reresolution_proposal set state = 'superseded'
      where matter = $1 and state = 'pending'`,
    [matterId],
  )
  const staffing = await tx.query(
    `select staff, role_on_matter, from_at, to_at from deedbox.matter_staffing
      where matter = $1 order by id desc limit 4`,
    [matterId],
  )
  const r = await tx.query(
    `insert into deedbox.slot_reresolution_proposal (matter, trigger_facts, items)
     values ($1, $2, $3) returning id`,
    [matterId, JSON.stringify({ staffing: staffing.rows }), JSON.stringify(items)],
  )
  await emitRegister(tx, p, {
    kind: 'record.created',
    subjectType: 'slot_reresolution_proposal',
    subject: r.rows[0].id as number,
    matter: matterId,
    detail: { items: items.length },
  })
  return { proposal: r.rows[0].id as number, items: items.length }
}

/** Decide a slot re-resolution proposal. */
export async function decideSlotProposal(
  p: Principal,
  input: {
    proposal: number
    decision: 'confirm' | 'reject'
    acceptTasks?: number[]
    note?: string
  },
): Promise<{ applied: number }> {
  requireStaff(p)
  return withPrincipal(p, async (tx) => {
    const prop = await tx.query(
      `select id, matter, items from deedbox.slot_reresolution_proposal
        where id = $1 and state = 'pending' for update`,
      [input.proposal],
    )
    if (prop.rowCount === 0) throw new OperationRefused('not_pending', 'no pending proposal by that id')
    const matter = prop.rows[0].matter as number
    const items = prop.rows[0].items as {
      task: number
      current_owner: number
      proposed_owner: number
    }[]

    if (input.decision === 'reject') {
      await tx.query(
        `update deedbox.slot_reresolution_proposal
            set state = 'rejected', decided_by = $2, decided_at = now(), decision_note = $3
          where id = $1`,
        [input.proposal, p.id, input.note ?? null],
      )
      await emitRegister(tx, p, {
        kind: 'record.changed',
        subjectType: 'slot_reresolution_proposal',
        subject: input.proposal,
        matter,
        reason: input.note,
        detail: { decision: 'rejected' },
      })
      return { applied: 0 }
    }

    const accept = new Set(input.acceptTasks ?? items.map((i) => i.task))
    const window = await tx.query(
      `select coalesce((deedbox.current_setting_value('undo.bulk_window_days') #>> '{}')::int, 7) as d`,
    )
    const op = await tx.query(
      `insert into deedbox.bulk_operation
         (operation_kind, dry_run_summary, committed_at, committed_by, reversible_until)
       values ('slot_reresolution', $1, now(), $2, now() + make_interval(days => $3::int))
       returning id`,
      [JSON.stringify(items), p.id, window.rows[0].d],
    )
    let applied = 0
    const decisions: { task: number; outcome: string }[] = []
    for (const item of items) {
      if (!accept.has(item.task)) {
        decisions.push({ task: item.task, outcome: 'kept' })
        continue
      }
      const t = await tx.query(
        `select owner from deedbox.task
          where id = $1 and deleted_at is null and not done for update`,
        [item.task],
      )
      if (t.rowCount === 0 || t.rows[0].owner !== item.current_owner) {
        decisions.push({ task: item.task, outcome: 'skipped' })
        continue
      }
      await tx.query(
        `insert into deedbox.bulk_operation_item (operation, entity_type, entity, before, after)
         values ($1, 'task', $2, $3, $4)`,
        [
          op.rows[0].id,
          item.task,
          JSON.stringify({ owner: item.current_owner }),
          JSON.stringify({ owner: item.proposed_owner }),
        ],
      )
      await tx.query(`update deedbox.task set owner = $2 where id = $1`, [
        item.task,
        item.proposed_owner,
      ])
      await emitRegister(tx, p, {
        kind: 'record.changed',
        subjectType: 'task',
        subject: item.task,
        matter,
        detail: { before: { owner: item.current_owner }, after: { owner: item.proposed_owner } },
      })
      applied += 1
      decisions.push({ task: item.task, outcome: 'applied' })
    }
    await tx.query(
      `update deedbox.slot_reresolution_proposal
          set state = 'confirmed', decided_by = $2, decided_at = now(),
              applied = $3, decision_note = $4
        where id = $1`,
      [input.proposal, p.id, JSON.stringify(decisions), input.note ?? null],
    )
    await emitRegister(tx, p, {
      kind: 'bulk.committed',
      subjectType: 'bulk_operation',
      subject: op.rows[0].id as number,
      matter,
      bulkOperation: op.rows[0].id as number,
      detail: { proposal: input.proposal, applied, decisions },
    })
    return { applied }
  })
}

/** Anchor-definition administration (firm rows; pack rows are read-only). */
export async function createAnchorDefinition(
  p: Principal,
  input: { name: string; practiceAreas?: number[] },
): Promise<{ id: number }> {
  if (!input.name.trim()) throw new OperationRefused('name_required', 'a definition carries a name')
  return withPrincipal(p, async (tx) => {
    await requireCapability(tx, p, 'workflow.manage')
    const r = await tx.query(
      `insert into deedbox.anchor_date_definition (name, practice_areas)
       values ($1, $2) returning id`,
      [input.name, input.practiceAreas ? JSON.stringify(input.practiceAreas) : null],
    )
    await emitRegister(tx, p, {
      kind: 'record.created',
      subjectType: 'anchor_date_definition',
      subject: r.rows[0].id as number,
      detail: { name: input.name },
    })
    return { id: r.rows[0].id as number }
  })
}
