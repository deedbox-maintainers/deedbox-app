// Interest. Policies are superseded, never edited, so the policy in force
// at any issue date is provable. A charge is a distinct addition to an
// already-issued bill: the issued document is never touched; the charge
// carries its own supplementary rendering and posts one interest_charge
// journal entry in the same transaction under the per-bill lock. Interest
// is simple daily interest on the outstanding PRINCIPAL only — the
// day-by-day balance excluding every interest entry — from due_date +
// grace_days, rounded to the cent at period end, no minimum. Every
// system-computed charge parks as a proposal (0021) until a staff member
// approves; the approval RECOMPUTES the amount at posting time so a payment
// landing between computation and approval can never over-charge.
//
// Implementation notes: the charge applies the RATE FIXED IN THE
// BILL'S INTEREST STATEMENT (what the client was told), not the policy row
// now in force; the default period runs from the day after the last charged
// period (else due_date + grace_days) through yesterday in the firm's
// timezone; the proposal generator serves both the accrual job and the
// interest panel's refresh — the billing.interest_schedule setting gates
// only the scheduled runner (jobs slice).

import type { Principal, Tx } from '@/lib/db'
import { withPrincipal, emitRegister, OperationRefused } from '@/lib/db'
import { requireStaff } from '@/lib/ops/shared'
import { createHash } from 'node:crypto'

interface PackInterestRules {
  maxAnnualRatePct: number | null
  minGraceDays: number | null
}

async function packInterestRules(tx: Tx, firm: number): Promise<PackInterestRules> {
  const r = await tx.query(
    `select d.body from deedbox.pack_declaration d
       join deedbox.firm f on f.id = $1
       join deedbox.country_pack cp on cp.id = f.country_pack
       join deedbox.pack_version v on v.id = d.pack_version and v.id = cp.active_version
      where d.rule_point = 'billing.interest_cap'`,
    [firm],
  )
  let maxRate: number | null = null
  let minGrace: number | null = null
  for (const row of r.rows) {
    const b = row.body as { max_annual_rate_pct?: number; min_grace_days?: number }
    if (b.max_annual_rate_pct !== undefined) maxRate = b.max_annual_rate_pct
    if (b.min_grace_days !== undefined) minGrace = b.min_grace_days
  }
  return { maxAnnualRatePct: maxRate, minGraceDays: minGrace }
}

/** Save an interest policy; supersede, never edit. */
export async function saveInterestPolicy(
  p: Principal,
  input: {
    scope: 'firm' | 'matter'
    matter?: number
    annualRatePct: number
    graceDays: number
    effectiveFrom?: string
  },
): Promise<{ id: number }> {
  requireStaff(p)
  if (!(input.annualRatePct >= 0)) throw new OperationRefused('bad_rate', 'the rate is zero or above')
  if (!Number.isInteger(input.graceDays) || input.graceDays < 0) {
    throw new OperationRefused('bad_grace', 'grace days are a whole number, zero or above')
  }
  if ((input.scope === 'matter') !== (input.matter !== undefined)) {
    throw new OperationRefused('bad_scope', 'a matter policy names its matter; a firm policy names none')
  }
  return withPrincipal(p, async (tx) => {
    const rules = await packInterestRules(tx, p.firm)
    if (rules.maxAnnualRatePct !== null && input.annualRatePct > rules.maxAnnualRatePct) {
      throw new OperationRefused(
        'interest_over_cap',
        `the rate ${input.annualRatePct}% exceeds the pack cap ${rules.maxAnnualRatePct}%`,
      )
    }
    if (rules.minGraceDays !== null && input.graceDays < rules.minGraceDays) {
      throw new OperationRefused(
        'grace_below_minimum',
        `the pack requires at least ${rules.minGraceDays} grace days`,
      )
    }
    if (input.scope === 'matter') {
      const m = await tx.query(`select id from deedbox.matter where id = $1 for update`, [
        input.matter,
      ])
      if (m.rowCount === 0) throw new OperationRefused('not_found', 'matter not found')
    }
    const prior = await tx.query(
      `update deedbox.interest_policy set active = false
        where active and scope = $1 and matter is not distinct from $2
        returning annual_rate_pct, grace_days`,
      [input.scope, input.matter ?? null],
    )
    const r = await tx.query(
      `insert into deedbox.interest_policy (scope, matter, annual_rate_pct, grace_days, effective_from)
       values ($1, $2, $3, $4::int, coalesce($5::date, current_date)) returning id`,
      [
        input.scope,
        input.matter ?? null,
        input.annualRatePct,
        input.graceDays,
        input.effectiveFrom ?? null,
      ],
    )
    await emitRegister(tx, p, {
      kind: 'record.changed',
      subjectType: 'interest_policy',
      subject: r.rows[0].id as number,
      matter: input.matter,
      detail: {
        before:
          prior.rowCount! > 0
            ? {
                annual_rate_pct: Number(prior.rows[0].annual_rate_pct),
                grace_days: prior.rows[0].grace_days,
              }
            : null,
        after: { annual_rate_pct: input.annualRatePct, grace_days: input.graceDays },
      },
    })
    return { id: r.rows[0].id as number }
  })
}

interface ChargeBasis {
  billId: number
  matter: number
  ratePct: number
  graceDays: number
  dueDate: string
  periodFrom: string
  periodTo: string
  amount: number
}

/** Yesterday in the firm's timezone — the default accrual frontier. */
async function accrualFrontier(tx: Tx): Promise<string> {
  const r = await tx.query(
    `select ((now() at time zone (select timezone from deedbox.firm order by id limit 1))::date
             - 1)::text as d`,
  )
  return r.rows[0].d as string
}

/**
 * The charge computation: simple daily interest on the day-by-day outstanding
 * principal (every interest entry excluded), rounded to the cent at period
 * end. Also validates statement presence, period bounds and non-overlap.
 */
async function computeChargeInTx(
  tx: Tx,
  firm: number,
  billId: number,
  periodFrom: string | undefined,
  periodTo: string | undefined,
  lock = true, // false for the read-only preview
): Promise<ChargeBasis> {
  const b = await tx.query(
    `select id, matter, state, due_date::text as due_date, interest_statement
       from deedbox.bill where id = $1 ${lock ? 'for update' : ''}`,
    [billId],
  )
  if (b.rowCount === 0) throw new OperationRefused('not_found', 'bill not found')
  if (b.rows[0].state !== 'issued') {
    throw new OperationRefused('not_issued', 'interest accrues on issued bills only')
  }
  if (b.rows[0].interest_statement === null) {
    throw new OperationRefused(
      'no_interest_statement',
      'this bill was issued without an interest statement — it accrues nothing, ever',
    )
  }
  const stmt = b.rows[0].interest_statement as { annual_rate_pct: number; grace_days: number }
  const ratePct = Number(stmt.annual_rate_pct)
  const graceDays = Number(stmt.grace_days ?? 0)

  const rules = await packInterestRules(tx, firm)
  if (rules.maxAnnualRatePct !== null && ratePct > rules.maxAnnualRatePct) {
    throw new OperationRefused(
      'interest_over_cap',
      `the stated rate ${ratePct}% now exceeds the pack cap ${rules.maxAnnualRatePct}% — no charge may post`,
    )
  }

  const earliest = await tx.query(
    `select greatest(
              ($1::date + $2::int),
              coalesce((select max(ic.period_to) + 1 from deedbox.interest_charge ic
                         where ic.bill = $3), '-infinity'::date)
            )::text as d`,
    [b.rows[0].due_date, graceDays, billId],
  )
  const from = periodFrom ?? (earliest.rows[0].d as string)
  const to = periodTo ?? (await accrualFrontier(tx))
  if (from < (earliest.rows[0].d as string)) {
    throw new OperationRefused(
      'period_too_early',
      `interest starts no earlier than ${earliest.rows[0].d} (due date + grace, past any charged period)`,
    )
  }
  if (from > to) {
    throw new OperationRefused('nothing_accrued', 'no accrual days in the period yet')
  }
  const overlap = await tx.query(
    `select 1 from deedbox.interest_charge
      where bill = $1 and daterange(period_from, period_to, '[]') && daterange($2::date, $3::date, '[]')`,
    [billId, from, to],
  )
  if (overlap.rowCount! > 0) {
    throw new OperationRefused('period_overlap', 'the period overlaps a charge already posted')
  }

  const amt = await tx.query(
    `select coalesce(round(sum(greatest(s.bal, 0)) * $4::numeric / 100 / 365, 2), 0) as amount
       from (
         select (
           select coalesce(sum(j.signed_amount), 0)
             from deedbox.bill_journal_entry j
            where j.bill = $1
              and j.effective_date <= d.day
              and j.entry_kind <> 'interest_charge'
              and not (j.entry_kind = 'reversal' and exists (
                    select 1 from deedbox.bill_journal_entry t
                     where t.id = j.reverses and t.entry_kind = 'interest_charge'))
         ) as bal
         from generate_series($2::date, $3::date, interval '1 day') as d(day)
       ) s`,
    [billId, from, to, ratePct],
  )
  return {
    billId,
    matter: b.rows[0].matter as number,
    ratePct,
    graceDays,
    dueDate: b.rows[0].due_date as string,
    periodFrom: from,
    periodTo: to,
    amount: Number(amt.rows[0].amount),
  }
}

/** Post one charge: record + journal entry + supplementary rendering. */
async function postChargeInTx(
  tx: Tx,
  p: Principal,
  basis: ChargeBasis,
  computedBy: 'system' | 'manual',
  approvedBy: number,
): Promise<{ id: number }> {
  const rendering = JSON.stringify({
    document: 'interest_charge',
    bill: basis.billId,
    period_from: basis.periodFrom,
    period_to: basis.periodTo,
    annual_rate_pct: basis.ratePct,
    amount: basis.amount,
    computation: 'simple daily interest on outstanding principal',
  })
  const artefact = await tx.query(
    `insert into deedbox.stored_artefact (kind, content_ref, content_hash, content_type, size_bytes)
     values ('interest_charge_rendering', $1, $2, 'application/json', $3) returning id`,
    [rendering, createHash('sha256').update(rendering).digest('hex'), Buffer.byteLength(rendering)],
  )
  const c = await tx.query(
    `insert into deedbox.interest_charge
       (bill, period_from, period_to, rate_pct_applied, amount, computed_by,
        approved_by, approved_at, supplementary_rendering)
     values ($1, $2::date, $3::date, $4, $5, $6, $7, now(), $8) returning id`,
    [
      basis.billId,
      basis.periodFrom,
      basis.periodTo,
      basis.ratePct,
      basis.amount,
      computedBy,
      approvedBy,
      String(artefact.rows[0].id),
    ],
  )
  await tx.query(
    `insert into deedbox.bill_journal_entry
       (bill, entry_kind, signed_amount, source_type, source, effective_date, entered_by)
     values ($1, 'interest_charge', $2, 'interest_charge', $3, $4::date, $5)`,
    [basis.billId, basis.amount, c.rows[0].id, basis.periodTo, p.id],
  )
  return { id: c.rows[0].id as number }
}

/** Charge preview — the computation, nothing written. */
export async function previewInterestCharge(
  p: Principal,
  input: { bill: number; periodFrom?: string; periodTo?: string },
): Promise<{ periodFrom: string; periodTo: string; ratePct: number; amount: number }> {
  requireStaff(p)
  return withPrincipal(
    p,
    async (tx) => {
      const basis = await computeChargeInTx(tx, p.firm, input.bill, input.periodFrom, input.periodTo, false)
      return {
        periodFrom: basis.periodFrom,
        periodTo: basis.periodTo,
        ratePct: basis.ratePct,
        amount: basis.amount,
      }
    },
    { readOnly: true },
  )
}

/** Add an interest charge on demand (the acting staff member approves). */
export async function addInterestCharge(
  p: Principal,
  input: { bill: number; periodFrom?: string; periodTo?: string },
): Promise<{ id: number; amount: number; periodFrom: string; periodTo: string }> {
  requireStaff(p)
  return withPrincipal(p, async (tx) => {
    const basis = await computeChargeInTx(tx, p.firm, input.bill, input.periodFrom, input.periodTo)
    if (!(basis.amount > 0)) {
      throw new OperationRefused('nothing_accrued', 'no interest accrued over the period')
    }
    const charge = await postChargeInTx(tx, p, basis, 'manual', p.id)
    await emitRegister(tx, p, {
      kind: 'record.created',
      subjectType: 'interest_charge',
      subject: charge.id,
      matter: basis.matter,
      detail: {
        bill: basis.billId,
        period_from: basis.periodFrom,
        period_to: basis.periodTo,
        rate_pct: basis.ratePct,
        amount: basis.amount,
        computed_by: 'manual',
      },
    })
    return {
      id: charge.id,
      amount: basis.amount,
      periodFrom: basis.periodFrom,
      periodTo: basis.periodTo,
    }
  })
}

/**
 * The system half — sweep eligible bills and PARK proposals (0021).
 * Serves the accrual job and the interest panel's refresh alike; posts
 * nothing. A bill with a pending proposal is left alone.
 */
export async function generateInterestProposals(
  p: Principal,
): Promise<{ proposals: { id: number; bill: number; amount: number }[] }> {
  const candidates = await withPrincipal(
    p,
    async (tx) => {
      const r = await tx.query(
        `select b.id from deedbox.bill b
          where b.state = 'issued' and b.interest_statement is not null
            and deedbox.bill_outstanding(b.id) > 0
            and not exists (select 1 from deedbox.interest_charge_proposal icp
                             where icp.bill = b.id and icp.state = 'pending')
          order by b.id`,
      )
      return r.rows.map((x) => x.id as number)
    },
    { readOnly: true },
  )

  const proposals: { id: number; bill: number; amount: number }[] = []
  for (const billId of candidates) {
    try {
      const created = await withPrincipal(p, async (tx) => {
        const basis = await computeChargeInTx(tx, p.firm, billId, undefined, undefined)
        if (!(basis.amount > 0)) return null
        const row = await tx.query(
          `insert into deedbox.interest_charge_proposal
             (bill, period_from, period_to, rate_pct_applied, amount)
           values ($1, $2::date, $3::date, $4, $5) returning id`,
          [billId, basis.periodFrom, basis.periodTo, basis.ratePct, basis.amount],
        )
        await emitRegister(tx, p, {
          kind: 'record.created',
          subjectType: 'interest_charge_proposal',
          subject: row.rows[0].id as number,
          matter: basis.matter,
          detail: {
            bill: billId,
            period_from: basis.periodFrom,
            period_to: basis.periodTo,
            amount: basis.amount,
          },
        })
        return { id: row.rows[0].id as number, bill: billId, amount: basis.amount }
      })
      if (created) proposals.push(created)
    } catch (e) {
      // an ineligible bill (nothing accrued yet, cap change, overlap) is
      // simply not proposed; anything else is a real failure
      if (!(e instanceof OperationRefused)) throw e
    }
  }
  return { proposals }
}

/**
 * Approve a parked proposal. The amount is RECOMPUTED for the
 * proposal's period at posting time; the register records parked vs posted.
 */
export async function approveInterestProposal(
  p: Principal,
  input: { proposal: number },
): Promise<
  | { posted: true; chargeId: number; amount: number }
  | { posted: false; dismissedReason: string }
> {
  requireStaff(p)
  return withPrincipal(p, async (tx) => {
    const prop = await tx.query(
      `select id, bill, period_from::text as period_from, period_to::text as period_to, amount
         from deedbox.interest_charge_proposal
        where id = $1 and state = 'pending' for update`,
      [input.proposal],
    )
    if (prop.rowCount === 0) {
      throw new OperationRefused('not_pending', 'no pending proposal by that id')
    }
    const row = prop.rows[0]
    const basis = await computeChargeInTx(
      tx,
      p.firm,
      row.bill as number,
      row.period_from as string,
      row.period_to as string,
    )
    if (!(basis.amount > 0)) {
      // a payment landed since computation and nothing accrues any more:
      // the proposal dismisses itself, and the dismissal COMMITS — a thrown
      // refusal here would roll its own record back
      const reason = 'nothing accrues over the period at posting time'
      await tx.query(
        `update deedbox.interest_charge_proposal
            set state = 'dismissed', resolved_by = $2, reason = $3
          where id = $1`,
        [input.proposal, p.id, reason],
      )
      await emitRegister(tx, p, {
        kind: 'record.changed',
        subjectType: 'interest_charge_proposal',
        subject: input.proposal,
        matter: basis.matter,
        reason,
        detail: { dismissed_on_approval: true, parked_amount: Number(row.amount) },
      })
      return { posted: false as const, dismissedReason: reason }
    }
    const charge = await postChargeInTx(tx, p, basis, 'system', p.id)
    await tx.query(
      `update deedbox.interest_charge_proposal
          set state = 'approved', resolved_by = $2, interest_charge = $3
        where id = $1`,
      [input.proposal, p.id, charge.id],
    )
    await emitRegister(tx, p, {
      kind: 'record.created',
      subjectType: 'interest_charge',
      subject: charge.id,
      matter: basis.matter,
      detail: {
        bill: basis.billId,
        proposal: input.proposal,
        period_from: basis.periodFrom,
        period_to: basis.periodTo,
        rate_pct: basis.ratePct,
        parked_amount: Number(row.amount),
        amount: basis.amount,
        computed_by: 'system',
      },
    })
    return { posted: true as const, chargeId: charge.id, amount: basis.amount }
  })
}

/** Dismiss a parked proposal, reason required. */
export async function dismissInterestProposal(
  p: Principal,
  input: { proposal: number; reason: string },
): Promise<void> {
  requireStaff(p)
  if (!input.reason.trim()) {
    throw new OperationRefused('reason_required', 'a dismissal carries its reason')
  }
  await withPrincipal(p, async (tx) => {
    const r = await tx.query(
      `update deedbox.interest_charge_proposal
          set state = 'dismissed', resolved_by = $2, reason = $3
        where id = $1 and state = 'pending'
        returning bill`,
      [input.proposal, p.id, input.reason],
    )
    if (r.rowCount === 0) throw new OperationRefused('not_pending', 'no pending proposal by that id')
    const m = await tx.query(`select matter from deedbox.bill where id = $1`, [r.rows[0].bill])
    await emitRegister(tx, p, {
      kind: 'record.changed',
      subjectType: 'interest_charge_proposal',
      subject: input.proposal,
      matter: m.rows[0].matter as number,
      reason: input.reason,
      detail: { dismissed: true },
    })
  })
}
