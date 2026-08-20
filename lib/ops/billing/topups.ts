// Top-up requests, carrying the funds-policy half of the threshold machinery:
// the threshold crossing, the threshold-alert row, the request, and the
// responsible-lawyer alert are ONE atomic act inside the evaluation's
// transaction, and the once-per-arming uniqueness makes one shortfall produce
// exactly one request and one alert, structurally. Satisfaction is driven by
// the client-money receipt carrying the request's reference (the settlement
// transaction calls satisfyTopUpInTx); the policy re-arms only when available
// recovers to at least the minimum.
//
// Implementation note: the available measure sums deedbox.ledger_available
// over the matter's OPEN client ledgers (balance minus active earmarks — the
// client-money shared definition).

import type { Principal, Tx } from '@/lib/db'
import { withPrincipal, emitRegister, OperationRefused } from '@/lib/db'
import { requireStaff } from '@/lib/ops/shared'
import { randomBytes } from 'node:crypto'

async function availableForMatter(tx: Tx, matterId: number): Promise<number> {
  const r = await tx.query(
    `select coalesce(sum(deedbox.ledger_available(ml.id)), 0) as a
       from deedbox.matter_ledger ml
      where ml.matter = $1 and ml.ledger_kind = 'client_matter' and ml.status = 'open'`,
    [matterId],
  )
  return Number(r.rows[0].a)
}

async function issueReferenceInTx(tx: Tx, requestId: number, amount: number): Promise<number> {
  const code = randomBytes(24).toString('base64url')
  const r = await tx.query(
    `insert into deedbox.payment_reference (code, target_kind, target, expected_amount)
     values ($1, 'top_up_request', $2, $3) returning id`,
    [code, requestId, amount],
  )
  return r.rows[0].id as number
}

/**
 * Evaluate one matter's funds policy; a crossing below the minimum
 * generates the request, the threshold-alert row, and the alert in this
 * one transaction. Callable by staff after money movements and by the
 * register-driven runner (jobs slice).
 */
export async function evaluateFundsPolicy(
  p: Principal,
  input: { matter: number },
): Promise<{ generated: number | null }> {
  return withPrincipal(p, async (tx) => {
    const pol = await tx.query(
      `select id, matter, minimum_threshold, target_amount, attach_to_next_bill,
              auto_issue, arming_version
         from deedbox.matter_funds_policy where matter = $1 for update`,
      [input.matter],
    )
    if (pol.rowCount === 0) return { generated: null }
    const policy = pol.rows[0]
    const available = await availableForMatter(tx, input.matter)
    if (Math.round(available * 100) >= Math.round(Number(policy.minimum_threshold) * 100)) {
      return { generated: null }
    }
    const open = await tx.query(
      `select 1 from deedbox.top_up_request
        where funds_policy = $1 and state in ('pending_confirmation','issued')`,
      [policy.id],
    )
    if (open.rowCount! > 0) return { generated: null } // one open request, structurally

    // the threshold-alert row inside THIS transaction: alert and request are one act
    const alert = await tx.query(
      `insert into deedbox.threshold_alert
         (subject_type, subject, threshold_pct, arming_version, recipients)
       values ('funds_policy', $1, 100, $2, $3)
       on conflict (subject_type, subject, threshold_pct, arming_version) do nothing
       returning id`,
      [
        policy.id,
        policy.arming_version,
        JSON.stringify([
          (
            await tx.query(`select responsible_lawyer from deedbox.matter where id = $1`, [
              input.matter,
            ])
          ).rows[0].responsible_lawyer,
        ]),
      ],
    )
    if (alert.rowCount === 0) return { generated: null } // this arming already fired

    const amount = Math.round((Number(policy.target_amount) - available) * 100) / 100
    const num = await tx.query(`select deedbox.allocate_number('top_up_request') as n`)
    const responsible = await tx.query(
      `select m.responsible_lawyer, s.email from deedbox.matter m
        join deedbox.staff_member s on s.id = m.responsible_lawyer
       where m.id = $1`,
      [input.matter],
    )
    const state = policy.auto_issue ? 'issued' : 'pending_confirmation'
    const req = await tx.query(
      `insert into deedbox.top_up_request
         (funds_policy, request_number, amount_requested, attach_to_next_bill,
          alerted_staff, state)
       values ($1, $2, $3, $4, $5, 'pending_confirmation') returning id`,
      [
        policy.id,
        num.rows[0].n,
        amount,
        policy.attach_to_next_bill,
        responsible.rows[0].responsible_lawyer,
      ],
    )
    const requestId = req.rows[0].id as number
    if (state === 'issued') {
      const refId = await issueReferenceInTx(tx, requestId, amount)
      await tx.query(
        `update deedbox.top_up_request set state = 'issued', payment_reference = $2 where id = $1`,
        [requestId, refId],
      )
    }
    await tx.query(
      `insert into deedbox.outbound_message
         (channel, recipient, rendered_artefact, purpose, related_type, related)
       values ('email', $1, $2, 'top_up_alert', 'top_up_request', $3)`,
      [responsible.rows[0].email, `top-up-${num.rows[0].n}`, requestId],
    )
    await emitRegister(tx, p, {
      kind: 'record.created',
      subjectType: 'top_up_request',
      subject: requestId,
      matter: input.matter,
      detail: {
        request_number: num.rows[0].n,
        amount_requested: amount,
        available,
        minimum: Number(policy.minimum_threshold),
        target: Number(policy.target_amount),
        auto_issue: policy.auto_issue,
      },
    })
    return { generated: requestId }
  })
}

/** Confirm a pending request; the reference issues. */
export async function confirmTopUpRequest(
  p: Principal,
  input: { request: number },
): Promise<void> {
  requireStaff(p)
  await withPrincipal(p, async (tx) => {
    const req = await tx.query(
      `select t.id, t.state, t.amount_requested, fp.matter
         from deedbox.top_up_request t
         join deedbox.matter_funds_policy fp on fp.id = t.funds_policy
        where t.id = $1 for update of t`,
      [input.request],
    )
    if (req.rowCount === 0) throw new OperationRefused('not_found', 'top-up request not found')
    if (req.rows[0].state !== 'pending_confirmation') {
      throw new OperationRefused('not_pending', `a ${req.rows[0].state} request cannot confirm`)
    }
    const refId = await issueReferenceInTx(tx, input.request, Number(req.rows[0].amount_requested))
    await tx.query(
      `update deedbox.top_up_request set state = 'issued', payment_reference = $2 where id = $1`,
      [input.request, refId],
    )
    await emitRegister(tx, p, {
      kind: 'record.changed',
      subjectType: 'top_up_request',
      subject: input.request,
      matter: req.rows[0].matter as number,
      detail: { before: 'pending_confirmation', after: 'issued' },
    })
  })
}

/** Cancel, reason required. */
export async function cancelTopUpRequest(
  p: Principal,
  input: { request: number; reason: string },
): Promise<void> {
  requireStaff(p)
  if (!input.reason.trim()) {
    throw new OperationRefused('reason_required', 'a cancellation carries its reason')
  }
  await withPrincipal(p, async (tx) => {
    const req = await tx.query(
      `select t.id, t.state, t.payment_reference, fp.matter
         from deedbox.top_up_request t
         join deedbox.matter_funds_policy fp on fp.id = t.funds_policy
        where t.id = $1 for update of t`,
      [input.request],
    )
    if (req.rowCount === 0) throw new OperationRefused('not_found', 'top-up request not found')
    if (req.rows[0].state !== 'pending_confirmation' && req.rows[0].state !== 'issued') {
      throw new OperationRefused('not_open', `a ${req.rows[0].state} request cannot cancel`)
    }
    if (req.rows[0].payment_reference !== null) {
      await tx.query(`update deedbox.payment_reference set active = false where id = $1 and active`, [
        req.rows[0].payment_reference,
      ])
    }
    await tx.query(`update deedbox.top_up_request set state = 'cancelled' where id = $1`, [
      input.request,
    ])
    await emitRegister(tx, p, {
      kind: 'record.changed',
      subjectType: 'top_up_request',
      subject: input.request,
      matter: req.rows[0].matter as number,
      reason: input.reason,
      detail: { before: req.rows[0].state, after: 'cancelled' },
    })
  })
}

/**
 * Satisfaction, inside the settlement transaction (settlement calls
 * this): issued → satisfied, reference deactivated, and the policy re-arms
 * when available has recovered to the minimum.
 */
export async function satisfyTopUpInTx(tx: Tx, p: Principal, requestId: number): Promise<void> {
  const req = await tx.query(
    `select t.id, t.state, t.payment_reference, t.funds_policy, fp.matter, fp.minimum_threshold
       from deedbox.top_up_request t
       join deedbox.matter_funds_policy fp on fp.id = t.funds_policy
      where t.id = $1 for update of t`,
    [requestId],
  )
  if (req.rowCount === 0) throw new OperationRefused('not_found', 'top-up request not found')
  const row = req.rows[0]
  if (row.state !== 'issued') {
    throw new OperationRefused('not_issued', `a ${row.state} request cannot satisfy`)
  }
  await tx.query(`update deedbox.top_up_request set state = 'satisfied' where id = $1`, [requestId])
  if (row.payment_reference !== null) {
    await tx.query(`update deedbox.payment_reference set active = false where id = $1 and active`, [
      row.payment_reference,
    ])
  }
  const available = await availableForMatter(tx, row.matter as number)
  if (Math.round(available * 100) >= Math.round(Number(row.minimum_threshold) * 100)) {
    await tx.query(
      `update deedbox.matter_funds_policy set arming_version = arming_version + 1 where id = $1`,
      [row.funds_policy],
    )
  }
  await emitRegister(tx, p, {
    kind: 'record.changed',
    subjectType: 'top_up_request',
    subject: requestId,
    matter: row.matter as number,
    detail: { before: 'issued', after: 'satisfied', available_after: available },
  })
}
