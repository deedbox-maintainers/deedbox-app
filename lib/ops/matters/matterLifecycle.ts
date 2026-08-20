// Matter lifecycle — close (direct or via approval), reopen, archive,
// hold/resume.
//
// The close guard and serialisation point: inside the closing transaction, the
// matter row lock is taken first, then every ledger of the matter is locked in
// ascending-id order and held to commit — so no receipt, payment or dishonour
// can race the close. The hard guard mirrors the ledger-close guard's clauses
// (0013): zero balance, no active earmark, no instrument outside a
// terminal-good state. Open dormant cases are warnings only. Position figures
// are computed fresh from the journals, never from the position cache.
//
// The single-approval discipline (0006) is structural: a matter reaches closed
// only with exactly one approved close request decided in the closing
// transaction.

import type { Principal, Tx } from '@/lib/db'
import { withPrincipal, emitRegister, OperationRefused } from '@/lib/db'
import { requireCapability, requireStaff, settingBool, settingText } from '@/lib/ops/shared'

export interface FinancialPosition {
  unbilled: number
  outstanding: number
  heldGross: number
  heldEarmarked: number
  heldAvailable: number
  ledgers: { id: number; balance: number }[]
  dormantWarnings: number[]
}

export interface ConditionEvaluation {
  unbilled: { present: boolean; behaviour: string }
  outstanding: { present: boolean; behaviour: string }
  heldFunds: { present: boolean; behaviour: string }
}

/**
 * Lock the matter's ledgers ascending and evaluate the hard money guard.
 * With lock=false the same clauses are evaluated WITHOUT taking locks — the
 * bulk dry-run's simulation, honest that commit re-verifies under lock.
 */
async function moneyCloseGuard(
  tx: Tx,
  matterId: number,
  lock = true,
): Promise<{ position: FinancialPosition; hardFailures: string[] }> {
  const ledgers = await tx.query(
    `select id from deedbox.matter_ledger where matter = $1 order by id${lock ? ' for update' : ''}`,
    [matterId],
  )
  const hardFailures: string[] = []
  const ledgerBalances: { id: number; balance: number }[] = []
  let heldGross = 0
  for (const row of ledgers.rows) {
    const b = await tx.query(`select deedbox.ledger_balance($1) as b`, [row.id])
    const balance = Number(b.rows[0].b)
    ledgerBalances.push({ id: row.id as number, balance })
    heldGross += balance
    if (balance !== 0) {
      hardFailures.push(`ledger ${row.id} holds ${balance.toFixed(2)}`)
    }
  }
  const ledgerIds = ledgers.rows.map((r) => r.id as number)
  let heldEarmarked = 0
  if (ledgerIds.length > 0) {
    const em = await tx.query(
      `select coalesce(sum(amount), 0) as total, count(*)::int as n
         from deedbox.earmark where matter_ledger = any($1) and state = 'active'`,
      [ledgerIds],
    )
    heldEarmarked = Number(em.rows[0].total)
    if (em.rows[0].n > 0) hardFailures.push(`${em.rows[0].n} active earmark(s)`)

    const inst = await tx.query(
      `select count(*)::int as n
         from deedbox.instrument i
         join deedbox.ledger_line l on l.transaction = i.transaction
        where l.matter_ledger = any($1)
          and i.state not in ('presented','replaced','cleared','dishonoured','cancelled')`,
      [ledgerIds],
    )
    if (inst.rows[0].n > 0) {
      hardFailures.push(`${inst.rows[0].n} instrument(s) not in a terminal-good state`)
    }
  }
  const dormant =
    ledgerIds.length > 0
      ? await tx.query(
          `select id from deedbox.dormant_case
            where matter_ledger = any($1) and state <> 'resolved' and state <> 'remitted'`,
          [ledgerIds],
        )
      : { rows: [] as { id: number }[] }

  const unbilledR = await tx.query(
    `select coalesce((select sum(value) from deedbox.time_entry
                       where matter = $1 and billed_state = 'unbilled' and deleted_at is null), 0)
          + coalesce((select sum(amount) from deedbox.disbursement
                       where matter = $1 and billed_state = 'unbilled' and deleted_at is null), 0) as v`,
    [matterId],
  )
  const outstandingR = await tx.query(
    `select coalesce(sum(deedbox.bill_outstanding(b.id)), 0) as v
       from deedbox.bill b where b.matter = $1 and b.state = 'issued'`,
    [matterId],
  )

  return {
    position: {
      unbilled: Number(unbilledR.rows[0].v),
      outstanding: Number(outstandingR.rows[0].v),
      heldGross,
      heldEarmarked,
      heldAvailable: heldGross - heldEarmarked,
      ledgers: ledgerBalances,
      dormantWarnings: dormant.rows.map((r) => r.id as number),
    },
    hardFailures,
  }
}

async function evaluateConditions(
  tx: Tx,
  position: FinancialPosition,
): Promise<{ evaluation: ConditionEvaluation; blockFailures: string[] }> {
  const behaviours = {
    unbilled: (await settingText(tx, 'matter.close_condition_unbilled')) ?? 'warn',
    outstanding: (await settingText(tx, 'matter.close_condition_outstanding')) ?? 'warn',
    heldFunds: (await settingText(tx, 'matter.close_condition_held_funds')) ?? 'block',
  }
  const evaluation: ConditionEvaluation = {
    unbilled: { present: position.unbilled > 0, behaviour: behaviours.unbilled },
    outstanding: { present: position.outstanding > 0, behaviour: behaviours.outstanding },
    heldFunds: { present: position.heldGross !== 0, behaviour: behaviours.heldFunds },
  }
  const blockFailures: string[] = []
  if (evaluation.unbilled.present && behaviours.unbilled === 'block')
    blockFailures.push(`unbilled work remains (${position.unbilled.toFixed(2)})`)
  if (evaluation.outstanding.present && behaviours.outstanding === 'block')
    blockFailures.push(`bills remain outstanding (${position.outstanding.toFixed(2)})`)
  if (evaluation.heldFunds.present && behaviours.heldFunds === 'block')
    blockFailures.push(`client money remains held (${position.heldGross.toFixed(2)})`)
  return { evaluation, blockFailures }
}

async function lockMatter(tx: Tx, matterId: number) {
  const m = await tx.query(
    `select id, status, restricted from deedbox.matter where id = $1 for update`,
    [matterId],
  )
  if (m.rowCount === 0) throw new OperationRefused('not_found', 'matter not found')
  return m.rows[0] as { id: number; status: string; restricted: boolean }
}

/**
 * Close. Direct path when approval is not required: the request row is
 * born approved and the matter closes in the same transaction. Approval path:
 * a pending request is created; approveCloseRequest executes the close.
 */
export async function closeMatter(
  p: Principal,
  input: { matter: number; note?: string },
): Promise<{ closed: boolean; pendingRequest?: number; position: FinancialPosition }> {
  return withPrincipal(p, async (tx) => {
    await requireCapability(tx, p, 'matter.close')

    if (await settingBool(tx, 'matter.close_requires_approval')) {
      const m = await lockMatter(tx, input.matter)
      if (m.status !== 'open' && m.status !== 'on_hold') {
        throw new OperationRefused('wrong_status', `a ${m.status} matter cannot be closed`)
      }
      const { position } = await moneyCloseGuard(tx, input.matter)
      const { evaluation } = await evaluateConditions(tx, position)
      // The request path: held-funds "block" refuses even the request; other
      // failures are recorded on the request for the approver.
      if (evaluation.heldFunds.present && evaluation.heldFunds.behaviour === 'block') {
        throw new OperationRefused('close_refused', 'client money remains held')
      }
      const pending = await tx.query(
        `select 1 from deedbox.matter_close_request where matter = $1 and state = 'pending'`,
        [input.matter],
      )
      if (pending.rowCount! > 0) {
        throw new OperationRefused('request_pending', 'a close request is already pending')
      }
      const req = await tx.query(
        `insert into deedbox.matter_close_request
           (matter, requested_by, financial_position, condition_evaluation)
         values ($1, $2, $3, $4) returning id`,
        [input.matter, p.id, JSON.stringify(position), JSON.stringify(evaluation)],
      )
      await emitRegister(tx, p, {
        kind: 'record.created',
        subjectType: 'matter_close_request',
        subject: req.rows[0].id as number,
        matter: input.matter,
        detail: { position, evaluation },
      })
      return { closed: false, pendingRequest: req.rows[0].id as number, position }
    }

    const { position } = await closeMatterDirectInTx(tx, p, input)
    return { closed: true, position }
  })
}

/**
 * The direct close path as an in-transaction core: lock, status check, money
 * guard, condition evaluation, one named refusal, the born-approved request,
 * the close itself. Exported for the bulk machinery and the import
 * pipeline (imported already-closed matters), which run it inside their own
 * transactions — every domain rule fires identically.
 */
export async function closeMatterDirectInTx(
  tx: Tx,
  p: Principal,
  input: { matter: number; note?: string },
): Promise<{ position: FinancialPosition }> {
  const m = await lockMatter(tx, input.matter)
  if (m.status !== 'open' && m.status !== 'on_hold') {
    throw new OperationRefused('wrong_status', `a ${m.status} matter cannot be closed`)
  }
  const { position, hardFailures } = await moneyCloseGuard(tx, input.matter)
  const { evaluation, blockFailures } = await evaluateConditions(tx, position)

  // Direct path: every failing condition is named in one refusal.
  const failures = [...hardFailures, ...blockFailures]
  if (failures.length > 0) {
    throw new OperationRefused('close_refused', `close refused: ${failures.join('; ')}`)
  }
  const req = await tx.query(
    `insert into deedbox.matter_close_request
       (matter, requested_by, financial_position, condition_evaluation,
        state, decided_by, decided_at, decision_note)
     values ($1, $2, $3, $4, 'approved', $2, now(), $5) returning id`,
    [input.matter, p.id, JSON.stringify(position), JSON.stringify(evaluation), input.note ?? null],
  )
  await executeClose(tx, p, input.matter, position, evaluation, req.rows[0].id as number)
  return { position }
}

/**
 * The bulk dry-run's lock-free close simulation: the same guard clauses and
 * condition behaviours evaluated without taking locks, in a read-only
 * transaction.
 * Returns the reasons the commit-time close would refuse for, empty when the
 * matter would close cleanly right now.
 */
export async function simulateCloseInTx(
  tx: Tx,
  matterId: number,
): Promise<{ refusals: string[] }> {
  const { position, hardFailures } = await moneyCloseGuard(tx, matterId, false)
  const { blockFailures } = await evaluateConditions(tx, position)
  return { refusals: [...hardFailures, ...blockFailures] }
}

/**
 * The close screen's live view: the same position figures and
 * per-condition evaluation the close operation uses, computed fresh from the
 * journals in a read-only transaction — no locks taken, honest that the
 * closing transaction re-verifies everything under lock.
 */
export async function closePositionInTx(
  tx: Tx,
  matterId: number,
): Promise<{
  position: FinancialPosition
  evaluation: ConditionEvaluation
  refusals: string[]
}> {
  const { position, hardFailures } = await moneyCloseGuard(tx, matterId, false)
  const { evaluation, blockFailures } = await evaluateConditions(tx, position)
  return { position, evaluation, refusals: [...hardFailures, ...blockFailures] }
}

/** Approval path: a different staff member decides a pending request. */
export async function approveCloseRequest(
  p: Principal,
  input: { request: number; note?: string },
): Promise<{ position: FinancialPosition }> {
  return withPrincipal(p, async (tx) => {
    await requireCapability(tx, p, 'matter.close')
    const req = await tx.query(
      `select id, matter, requested_by, state from deedbox.matter_close_request
        where id = $1 for update`,
      [input.request],
    )
    if (req.rowCount === 0) throw new OperationRefused('not_found', 'close request not found')
    if (req.rows[0].state !== 'pending') {
      throw new OperationRefused('not_pending', 'only pending requests are decided')
    }
    if (req.rows[0].requested_by === p.id) {
      throw new OperationRefused('approver_separation', 'the requester never decides their own request')
    }
    const matterId = req.rows[0].matter as number
    const m = await lockMatter(tx, matterId)
    if (m.status !== 'open' && m.status !== 'on_hold') {
      throw new OperationRefused('wrong_status', `a ${m.status} matter cannot be closed`)
    }
    // Money may have moved since the request: guard and conditions run fresh
    // in the closing transaction, and the register records the fresh position.
    const { position, hardFailures } = await moneyCloseGuard(tx, matterId)
    const { evaluation, blockFailures } = await evaluateConditions(tx, position)
    const failures = [...hardFailures, ...blockFailures]
    if (failures.length > 0) {
      throw new OperationRefused('close_refused', `close refused: ${failures.join('; ')}`)
    }
    // The request keeps its at-request snapshot (immutable by guard); the
    // fresh position decided on lands on the register events below.
    await tx.query(
      `update deedbox.matter_close_request
          set state = 'approved', decided_by = $2, decided_at = now(), decision_note = $3
        where id = $1`,
      [input.request, p.id, input.note ?? null],
    )
    await executeClose(tx, p, matterId, position, evaluation, input.request)
    return { position }
  })
}

export async function rejectCloseRequest(
  p: Principal,
  input: { request: number; note: string },
): Promise<void> {
  await withPrincipal(p, async (tx) => {
    await requireCapability(tx, p, 'matter.close')
    const req = await tx.query(
      `select matter, requested_by, state from deedbox.matter_close_request where id = $1 for update`,
      [input.request],
    )
    if (req.rowCount === 0) throw new OperationRefused('not_found', 'close request not found')
    if (req.rows[0].state !== 'pending') {
      throw new OperationRefused('not_pending', 'only pending requests are decided')
    }
    if (req.rows[0].requested_by === p.id) {
      throw new OperationRefused('approver_separation', 'the requester never decides their own request')
    }
    await tx.query(
      `update deedbox.matter_close_request
          set state = 'rejected', decided_by = $2, decided_at = now(), decision_note = $3
        where id = $1`,
      [input.request, p.id, input.note],
    )
    await emitRegister(tx, p, {
      kind: 'record.changed',
      subjectType: 'matter_close_request',
      subject: input.request,
      matter: req.rows[0].matter as number,
      detail: { before: { state: 'pending' }, after: { state: 'rejected' } },
    })
  })
}

export async function withdrawCloseRequest(
  p: Principal,
  input: { request: number },
): Promise<void> {
  requireStaff(p)
  await withPrincipal(p, async (tx) => {
    const req = await tx.query(
      `select matter, requested_by, state from deedbox.matter_close_request where id = $1 for update`,
      [input.request],
    )
    if (req.rowCount === 0) throw new OperationRefused('not_found', 'close request not found')
    if (req.rows[0].state !== 'pending') {
      throw new OperationRefused('not_pending', 'only pending requests are withdrawn')
    }
    if (req.rows[0].requested_by !== p.id) {
      throw new OperationRefused('not_yours', 'only the requester withdraws their request')
    }
    await tx.query(
      `update deedbox.matter_close_request
          set state = 'withdrawn', decided_by = $2, decided_at = now()
        where id = $1`,
      [input.request, p.id],
    )
    await emitRegister(tx, p, {
      kind: 'record.changed',
      subjectType: 'matter_close_request',
      subject: input.request,
      matter: req.rows[0].matter as number,
      detail: { before: { state: 'pending' }, after: { state: 'withdrawn' } },
    })
  })
}

async function executeClose(
  tx: Tx,
  p: Principal,
  matterId: number,
  position: FinancialPosition,
  evaluation: ConditionEvaluation,
  requestId: number,
): Promise<void> {
  await tx.query(`update deedbox.matter set status = 'closed' where id = $1`, [matterId])
  await emitRegister(tx, p, {
    kind: 'matter.close_approved',
    subjectType: 'matter_close_request',
    subject: requestId,
    matter: matterId,
    detail: { position, evaluation },
  })
  await emitRegister(tx, p, {
    kind: 'matter.status_changed',
    subjectType: 'matter',
    subject: matterId,
    matter: matterId,
    detail: { before: 'open', after: 'closed', position },
  })
}

/** Reopen: capability-gated, reason never negotiable. */
export async function reopenMatter(
  p: Principal,
  input: { matter: number; reason: string },
): Promise<void> {
  if (!input.reason || !input.reason.trim()) {
    throw new OperationRefused('reason_required', 'reopening a matter requires a reason')
  }
  await withPrincipal(p, async (tx) => {
    await requireCapability(tx, p, 'matter.reopen')
    await reopenMatterInTx(tx, p, input)
  })
}

/** The reopen core, exported for the bulk machinery (capability checked by the caller). */
export async function reopenMatterInTx(
  tx: Tx,
  p: Principal,
  input: { matter: number; reason: string },
): Promise<void> {
  const m = await lockMatter(tx, input.matter)
  if (m.status !== 'closed' && m.status !== 'archived') {
    throw new OperationRefused('wrong_status', `a ${m.status} matter cannot be reopened`)
  }
  await tx.query(`update deedbox.matter set status = 'open' where id = $1`, [input.matter])
  await emitRegister(tx, p, {
    kind: 'matter.status_changed',
    subjectType: 'matter',
    subject: input.matter,
    matter: input.matter,
    reason: input.reason,
    detail: { before: m.status, after: 'open' },
  })
}

/** Archive: from closed only, with the money guard re-checked. */
export async function archiveMatter(p: Principal, input: { matter: number }): Promise<void> {
  await withPrincipal(p, async (tx) => {
    await requireCapability(tx, p, 'matter.close')
    await archiveMatterInTx(tx, p, input)
  })
}

/** The archive core, exported for the bulk machinery's reopen-undo fidelity. */
export async function archiveMatterInTx(
  tx: Tx,
  p: Principal,
  input: { matter: number },
): Promise<void> {
  const m = await lockMatter(tx, input.matter)
  if (m.status !== 'closed') {
    throw new OperationRefused('wrong_status', 'only closed matters are archived')
  }
  const { hardFailures } = await moneyCloseGuard(tx, input.matter)
  if (hardFailures.length > 0) {
    throw new OperationRefused('archive_refused', `archive refused: ${hardFailures.join('; ')}`)
  }
  await tx.query(`update deedbox.matter set status = 'archived' where id = $1`, [input.matter])
  await emitRegister(tx, p, {
    kind: 'matter.status_changed',
    subjectType: 'matter',
    subject: input.matter,
    matter: input.matter,
    detail: { before: 'closed', after: 'archived' },
  })
}

/** Hold / resume. */
export async function holdMatter(p: Principal, input: { matter: number }): Promise<void> {
  requireStaff(p)
  await withPrincipal(p, async (tx) => holdMatterInTx(tx, p, input))
}

/** The hold core, exported for the bulk machinery. */
export async function holdMatterInTx(
  tx: Tx,
  p: Principal,
  input: { matter: number },
): Promise<void> {
  const m = await lockMatter(tx, input.matter)
  if (m.status !== 'open') {
    throw new OperationRefused('wrong_status', `a ${m.status} matter cannot be put on hold`)
  }
  await tx.query(`update deedbox.matter set status = 'on_hold' where id = $1`, [input.matter])
  await emitRegister(tx, p, {
    kind: 'matter.status_changed',
    subjectType: 'matter',
    subject: input.matter,
    matter: input.matter,
    detail: { before: 'open', after: 'on_hold' },
  })
}

export async function resumeMatter(p: Principal, input: { matter: number }): Promise<void> {
  requireStaff(p)
  await withPrincipal(p, async (tx) => resumeMatterInTx(tx, p, input))
}

/** The resume core, exported for the bulk machinery. */
export async function resumeMatterInTx(
  tx: Tx,
  p: Principal,
  input: { matter: number },
): Promise<void> {
  const m = await lockMatter(tx, input.matter)
  if (m.status !== 'on_hold') {
    throw new OperationRefused('wrong_status', `a ${m.status} matter is not on hold`)
  }
  await tx.query(`update deedbox.matter set status = 'open' where id = $1`, [input.matter])
  await emitRegister(tx, p, {
    kind: 'matter.status_changed',
    subjectType: 'matter',
    subject: input.matter,
    matter: input.matter,
    detail: { before: 'on_hold', after: 'open' },
  })
}
