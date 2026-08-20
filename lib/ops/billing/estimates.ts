// Estimates, budgets, funds policy. The estimate's amount moves only
// through revisions (the schema's triggers number and apply them); the
// revision history is the provable record of what the client was told
// and when.

import type { Principal, Tx } from '@/lib/db'
import { withPrincipal, emitRegister, OperationRefused } from '@/lib/db'
import { requireStaff, settingText } from '@/lib/ops/shared'

async function settingThresholds(tx: Tx, key: string): Promise<number[]> {
  const raw = await settingText(tx, key)
  try {
    const arr = JSON.parse(raw ?? '[]')
    if (Array.isArray(arr) && arr.every((n) => typeof n === 'number')) return arr
  } catch {
    /* fall through to the shipped default */
  }
  return [50, 80, 100]
}

/** Pack-mandated thresholds from billing.estimate_rules, merged at save. */
async function packEstimateThresholds(tx: Tx, firm: number): Promise<number[]> {
  const r = await tx.query(
    `select d.body from deedbox.pack_declaration d
       join deedbox.firm f on f.id = $1
       join deedbox.country_pack cp on cp.id = f.country_pack
       join deedbox.pack_version v on v.id = d.pack_version and v.id = cp.active_version
      where d.rule_point = 'billing.estimate_rules'`,
    [firm],
  )
  const out: number[] = []
  for (const row of r.rows) {
    const t = (row.body as { thresholds?: number[] }).thresholds
    if (Array.isArray(t)) out.push(...t.filter((n) => typeof n === 'number'))
  }
  return out
}

/** Create or revise; creation is revision 1. */
export async function reviseEstimate(
  p: Principal,
  input: { matter: number; amount: number; reason: string; thresholds?: number[] },
): Promise<{ estimate: number; revision: number }> {
  requireStaff(p)
  if (!input.reason.trim()) {
    throw new OperationRefused('reason_required', 'every estimate revision carries its reason')
  }
  if (input.amount < 0) throw new OperationRefused('bad_amount', 'an estimate is never negative')
  return withPrincipal(p, async (tx) => {
    const m = await tx.query(`select id from deedbox.matter where id = $1`, [input.matter])
    if (m.rowCount === 0) throw new OperationRefused('not_found', 'matter not found')

    const defaults = await settingThresholds(tx, 'estimate.default_thresholds')
    const packMandated = await packEstimateThresholds(tx, p.firm)
    const thresholds = [...new Set([...(input.thresholds ?? defaults), ...packMandated])].sort(
      (a, b) => a - b,
    )

    const existing = await tx.query(
      `select id, current_amount from deedbox.cost_estimate where matter = $1 for update`,
      [input.matter],
    )
    let estimateId: number
    let before: number | null = null
    if (existing.rowCount === 0) {
      const e = await tx.query(
        `insert into deedbox.cost_estimate (matter, current_amount, alert_thresholds)
         values ($1, $2, $3) returning id`,
        [input.matter, input.amount, JSON.stringify(thresholds)],
      )
      estimateId = e.rows[0].id as number
    } else {
      estimateId = existing.rows[0].id as number
      before = Number(existing.rows[0].current_amount)
    }
    const rev = await tx.query(
      `insert into deedbox.estimate_revision (estimate, amount, author, reason)
       values ($1, $2, $3, $4) returning revision_no`,
      [estimateId, input.amount, p.id, input.reason],
    )
    await emitRegister(tx, p, {
      kind: 'record.changed',
      subjectType: 'cost_estimate',
      subject: estimateId,
      matter: input.matter,
      reason: input.reason,
      detail: { before: { amount: before }, after: { amount: input.amount } },
    })
    return { estimate: estimateId, revision: rev.rows[0].revision_no as number }
  })
}

/** Set or raise a budget: deactivate the old row, insert the new. */
export async function setBudget(
  p: Principal,
  input: {
    matter: number
    level?: 'matter' | 'stage'
    stage?: number
    amount: number
    thresholds?: number[]
    recipients?: number[]
  },
): Promise<{ id: number }> {
  requireStaff(p)
  if (input.amount < 0) throw new OperationRefused('bad_amount', 'a budget is never negative')
  return withPrincipal(p, async (tx) => {
    const m = await tx.query(
      `select responsible_lawyer from deedbox.matter where id = $1`,
      [input.matter],
    )
    if (m.rowCount === 0) throw new OperationRefused('not_found', 'matter not found')
    const level = input.level ?? 'matter'
    const thresholds =
      input.thresholds ?? (await settingThresholds(tx, 'budget.default_thresholds'))
    // the responsible lawyer is always included, injected at save
    const recipients = [
      ...new Set([...(input.recipients ?? []), m.rows[0].responsible_lawyer as number]),
    ]

    const old = await tx.query(
      `update deedbox.budget set active = false
        where matter = $1 and level = $2 and stage is not distinct from $3 and active
        returning id, amount`,
      [input.matter, level, input.stage ?? null],
    )
    const r = await tx.query(
      `insert into deedbox.budget (matter, level, stage, amount, thresholds, recipients, created_by)
       values ($1,$2,$3,$4,$5,$6,$7) returning id`,
      [
        input.matter,
        level,
        input.stage ?? null,
        input.amount,
        JSON.stringify(thresholds),
        JSON.stringify(recipients),
        p.id,
      ],
    )
    const id = r.rows[0].id as number
    await emitRegister(tx, p, {
      kind: 'record.changed',
      subjectType: 'budget',
      subject: id,
      matter: input.matter,
      detail: {
        before: old.rowCount! > 0 ? { amount: Number(old.rows[0].amount) } : null,
        after: { amount: input.amount },
      },
    })
    return { id }
  })
}

/** The one mutable funds-policy row. */
export async function setFundsPolicy(
  p: Principal,
  input: {
    matter: number
    minimumThreshold: number
    targetAmount: number
    attachToNextBill?: boolean
    autoIssue?: boolean
  },
): Promise<{ id: number }> {
  requireStaff(p)
  if (input.targetAmount < input.minimumThreshold) {
    throw new OperationRefused('target_below_minimum', 'the target is at least the minimum')
  }
  return withPrincipal(p, async (tx) => {
    const m = await tx.query(`select id from deedbox.matter where id = $1`, [input.matter])
    if (m.rowCount === 0) throw new OperationRefused('not_found', 'matter not found')
    const attach =
      input.attachToNextBill ??
      ((await settingText(tx, 'topup.attach_to_next_bill_default')) === 'true')
    const auto = input.autoIssue ?? ((await settingText(tx, 'topup.auto_issue')) === 'true')

    const existing = await tx.query(
      `select id, minimum_threshold, target_amount from deedbox.matter_funds_policy
        where matter = $1 for update`,
      [input.matter],
    )
    let id: number
    let before: Record<string, number> | null = null
    if (existing.rowCount === 0) {
      const r = await tx.query(
        `insert into deedbox.matter_funds_policy
           (matter, minimum_threshold, target_amount, attach_to_next_bill, auto_issue)
         values ($1,$2,$3,$4,$5) returning id`,
        [input.matter, input.minimumThreshold, input.targetAmount, attach, auto],
      )
      id = r.rows[0].id as number
    } else {
      id = existing.rows[0].id as number
      before = {
        minimum: Number(existing.rows[0].minimum_threshold),
        target: Number(existing.rows[0].target_amount),
      }
      await tx.query(
        `update deedbox.matter_funds_policy
            set minimum_threshold = $2, target_amount = $3,
                attach_to_next_bill = $4, auto_issue = $5
          where id = $1`,
        [id, input.minimumThreshold, input.targetAmount, attach, auto],
      )
    }
    await emitRegister(tx, p, {
      kind: 'record.changed',
      subjectType: 'matter_funds_policy',
      subject: id,
      matter: input.matter,
      detail: {
        before,
        after: { minimum: input.minimumThreshold, target: input.targetAmount },
      },
    })
    return { id }
  })
}
