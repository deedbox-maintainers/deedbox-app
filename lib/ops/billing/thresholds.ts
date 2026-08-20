// Threshold evaluation. Estimate and budget subjects here; funds-policy
// crossings land WITH the top-up operation so the alert and the request stay one
// atomic act. A uniqueness constraint makes every firing exactly-once per
// threshold per arming; recipients always include the responsible lawyer;
// delivery is an outbound-message row per recipient.
//
// The register-driven near-real-time runner arrives with the jobs slice;
// until then callers (and tests) invoke this directly after capture writes.

import type { Principal, Tx } from '@/lib/db'
import { withPrincipal, emitRegister } from '@/lib/db'

/** The consumption measure — each item counted exactly once. */
async function estimateConsumption(tx: Tx, matterId: number): Promise<number> {
  const r = await tx.query(
    `select
       coalesce((select sum(te.value) from deedbox.time_entry te
                   join deedbox.choice_item ci on ci.id = te.category
                  where te.matter = $1 and te.billed_state = 'unbilled'
                    and te.deleted_at is null and ci.counts_as_chargeable), 0)
     + coalesce((select sum(d.amount) from deedbox.disbursement d
                  where d.matter = $1 and d.billed_state = 'unbilled'
                    and d.deleted_at is null and d.billable), 0)
     + coalesce((select sum(j.signed_amount) from deedbox.bill_journal_entry j
                   join deedbox.bill b on b.id = j.bill
                  where b.matter = $1 and b.state = 'issued'
                    and j.entry_kind in ('issue_total','interest_charge')), 0) as v`,
    [matterId],
  )
  return Number(r.rows[0].v)
}

/** The spend measure — all categories; billable disbursements. */
async function budgetSpend(tx: Tx, matterId: number): Promise<number> {
  const r = await tx.query(
    `select
       coalesce((select sum(te.value) from deedbox.time_entry te
                  where te.matter = $1 and te.billed_state <> 'written_off_before_billing'
                    and te.deleted_at is null), 0)
     + coalesce((select sum(d.amount) from deedbox.disbursement d
                  where d.matter = $1 and d.billed_state <> 'written_off_before_billing'
                    and d.deleted_at is null and d.billable), 0) as v`,
    [matterId],
  )
  return Number(r.rows[0].v)
}

async function fire(
  tx: Tx,
  p: Principal,
  subjectType: 'estimate' | 'budget',
  subject: number,
  matterId: number,
  pct: number,
  arming: number,
  recipients: number[],
  measure: number,
  amount: number,
): Promise<boolean> {
  const ins = await tx.query(
    `insert into deedbox.threshold_alert
       (subject_type, subject, threshold_pct, arming_version, recipients)
     values ($1,$2,$3,$4,$5)
     on conflict (subject_type, subject, threshold_pct, arming_version) do nothing
     returning id`,
    [subjectType, subject, pct, arming, JSON.stringify(recipients)],
  )
  if (ins.rowCount === 0) return false // already fired this arming — exactly-once
  const alertId = ins.rows[0].id as number
  for (const staffId of recipients) {
    const email = await tx.query(`select email from deedbox.staff_member where id = $1`, [staffId])
    if (email.rowCount === 0) continue
    await tx.query(
      `insert into deedbox.outbound_message
         (channel, recipient, rendered_artefact, purpose, related_type, related)
       values ('email', $1, $2, 'threshold_alert', 'threshold_alert', $3)`,
      [
        email.rows[0].email,
        `threshold-${subjectType}-${subject}-${pct}pct`,
        alertId,
      ],
    )
  }
  await emitRegister(tx, p, {
    kind: 'record.created',
    subjectType: 'threshold_alert',
    subject: alertId,
    matter: matterId,
    detail: { subject_type: subjectType, pct, measure, amount },
  })
  return true
}

export interface ThresholdEvaluation {
  fired: { subjectType: string; subject: number; pct: number }[]
}

/** Evaluate estimate + budget thresholds for one matter. */
export async function evaluateThresholds(
  p: Principal,
  input: { matter: number },
): Promise<ThresholdEvaluation> {
  return withPrincipal(p, async (tx) => {
    const fired: ThresholdEvaluation['fired'] = []

    const m = await tx.query(
      `select responsible_lawyer from deedbox.matter where id = $1`,
      [input.matter],
    )
    if (m.rowCount === 0) return { fired } // invisible or absent: nothing to do
    const responsible = m.rows[0].responsible_lawyer as number

    const est = await tx.query(
      `select id, current_amount, alert_thresholds, arming_version
         from deedbox.cost_estimate where matter = $1`,
      [input.matter],
    )
    if (est.rowCount! > 0 && Number(est.rows[0].current_amount) > 0) {
      const consumption = await estimateConsumption(tx, input.matter)
      const amount = Number(est.rows[0].current_amount)
      const pctNow = (consumption / amount) * 100
      for (const pct of est.rows[0].alert_thresholds as number[]) {
        if (pctNow >= pct) {
          if (
            await fire(tx, p, 'estimate', est.rows[0].id, input.matter, pct,
              est.rows[0].arming_version, [responsible], consumption, amount)
          ) {
            fired.push({ subjectType: 'estimate', subject: est.rows[0].id, pct })
          }
        }
      }
    }

    const budgets = await tx.query(
      `select id, amount, thresholds, recipients, arming_version
         from deedbox.budget where matter = $1 and active and level = 'matter'`,
      [input.matter],
    )
    for (const b of budgets.rows) {
      if (Number(b.amount) <= 0) continue
      const spend = await budgetSpend(tx, input.matter)
      const pctNow = (spend / Number(b.amount)) * 100
      const recipients = [...new Set([...(b.recipients as number[]), responsible])]
      for (const pct of b.thresholds as number[]) {
        if (pctNow >= pct) {
          if (
            await fire(tx, p, 'budget', b.id, input.matter, pct, b.arming_version,
              recipients, spend, Number(b.amount))
          ) {
            fired.push({ subjectType: 'budget', subject: b.id, pct })
          }
        }
      }
    }
    return { fired }
  })
}

/**
 * The scheduled sweep deferred to the jobs slice: evaluate
 * every matter carrying a guardrail (estimate, budget or funds policy).
 * Exactly-once per arming is structural, so re-evaluating an armed
 * matter that already fired is a no-op — the sweep is idempotent.
 */
export async function runThresholdSweep(
  p: Principal,
): Promise<{ evaluated: number; fired: number }> {
  const matters = await withPrincipal(
    p,
    async (tx) => {
      const r = await tx.query(
        `select distinct m from (
           select matter as m from deedbox.cost_estimate
           union select matter from deedbox.budget where active
           union select matter from deedbox.matter_funds_policy
         ) x order by m`,
      )
      return r.rows.map((row) => row.m as number)
    },
    { readOnly: true },
  )
  let fired = 0
  for (const matter of matters) {
    const result = await evaluateThresholds(p, { matter })
    fired += result.fired.length
  }
  return { evaluated: matters.length, fired }
}
