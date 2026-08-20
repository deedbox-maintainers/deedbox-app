// Payments. An unallocated payment is first-class; allocations write
// negative journal entries under per-payment and per-bill locks in canonical
// (ascending bill id) order; the journal caps are schema-enforced and
// prechecked here for itemised messages; corrections are mirrors, never
// edits and never unlinked negatives.

import type { Principal, Tx } from '@/lib/db'
import { withPrincipal, emitRegister, OperationRefused } from '@/lib/db'
import { requireStaff } from '@/lib/ops/shared'
import { applyInstalmentCoverageInTx } from './arrangements'

async function validMethod(tx: Tx, firm: number, method: string): Promise<void> {
  if (!method.trim()) throw new OperationRefused('method_required', 'a payment names its method')
  const declared = await tx.query(
    `select d.body from deedbox.pack_declaration d
       join deedbox.firm f on f.id = $1
       join deedbox.country_pack cp on cp.id = f.country_pack
       join deedbox.pack_version v on v.id = d.pack_version and v.id = cp.active_version
      where d.rule_point = 'money.payment_methods'`,
    [firm],
  )
  if (declared.rowCount === 0) return // neutral default constrains nothing further
  const names = declared.rows.flatMap((r) => {
    const b = r.body as { methods?: { key: string }[] }
    return (b.methods ?? []).map((m) => m.key)
  })
  if (names.length > 0 && !names.includes(method)) {
    throw new OperationRefused('method_unknown', `the pack does not declare method ${method}`)
  }
}

/** Net remaining unallocated amount on a payment. */
async function paymentRemainder(tx: Tx, paymentId: number): Promise<number> {
  const r = await tx.query(
    `select p.amount + coalesce((
        select sum(j.signed_amount) from deedbox.bill_journal_entry j
         where j.source_type = 'receivable_payment' and j.source = $1
           and j.entry_kind in ('payment_allocation','reversal')
      ), 0) as rem
       from deedbox.receivable_payment p where p.id = $1`,
    [paymentId],
  )
  if (r.rowCount === 0) throw new OperationRefused('not_found', 'payment not found')
  return Number(r.rows[0].rem)
}

/** Record a direct payment; gapless office receipt inside the txn. */
export async function recordPayment(
  p: Principal,
  input: {
    payerParty?: number
    receivedDate: string
    amount: number
    method: string
    reference?: string
    /** Optional same-transaction allocations, riding this recording. */
    allocations?: { bill: number; amount: number }[]
  },
): Promise<{ id: number; receiptNumber: string }> {
  requireStaff(p)
  if (!(input.amount > 0)) throw new OperationRefused('bad_amount', 'a payment is above zero')
  return withPrincipal(p, async (tx) => {
    await validMethod(tx, p.firm, input.method)
    const num = await tx.query(`select deedbox.allocate_number('receivable_receipt') as n`)
    const receiptNumber = num.rows[0].n as string
    const r = await tx.query(
      `insert into deedbox.receivable_payment
         (payer_party, received_date, amount, method, reference, receipt_number)
       values ($1, $2::date, $3, $4, $5, $6) returning id`,
      [
        input.payerParty ?? null,
        input.receivedDate,
        input.amount,
        input.method,
        input.reference ?? null,
        receiptNumber,
      ],
    )
    const id = r.rows[0].id as number
    await emitRegister(tx, p, {
      kind: 'record.created',
      subjectType: 'receivable_payment',
      subject: id,
      detail: { amount: input.amount, method: input.method, receipt_number: receiptNumber },
    })
    if (input.allocations && input.allocations.length > 0) {
      await allocateInTx(tx, p, id, input.allocations)
    }
    return { id, receiptNumber }
  })
}

/** Allocate a payment across bills. */
export async function allocatePayment(
  p: Principal,
  input: { payment: number; allocations: { bill: number; amount: number }[] },
): Promise<void> {
  requireStaff(p)
  if (input.allocations.length === 0) {
    throw new OperationRefused('nothing_to_allocate', 'name at least one split')
  }
  await withPrincipal(p, (tx) => allocateInTx(tx, p, input.payment, input.allocations))
}

// Payments are append-only, so the app role holds no update privilege and a
// row lock is unavailable by design. The per-payment serialisation point is a
// transaction-scoped advisory lock on the payment's id instead (class 4201).
async function lockPayment(tx: Tx, paymentId: number): Promise<void> {
  await tx.query(`select pg_advisory_xact_lock(4201, $1::int)`, [paymentId])
}

/**
 * The allocation body, callable inside a caller-owned transaction — statement
 * allocation and channel settlement ride these exact semantics in their own
 * single transactions.
 */
export async function allocateInTx(
  tx: Tx,
  p: Principal,
  paymentId: number,
  allocations: { bill: number; amount: number }[],
): Promise<void> {
  // per-payment lock, then the remainder check
  await lockPayment(tx, paymentId)
  const pay = await tx.query(
    `select id, amount, reverses,
            exists (select 1 from deedbox.receivable_payment m where m.reverses = deedbox.receivable_payment.id) as mirrored
       from deedbox.receivable_payment where id = $1`,
    [paymentId],
  )
  if (pay.rowCount === 0) throw new OperationRefused('not_found', 'payment not found')
  if (pay.rows[0].reverses !== null || pay.rows[0].mirrored) {
    throw new OperationRefused('cancelled', 'a cancelled payment never allocates')
  }
  const total = allocations.reduce((s, a) => s + a.amount, 0)
  const remainder = await paymentRemainder(tx, paymentId)
  if (total > remainder + 0.005) {
    throw new OperationRefused(
      'over_allocated',
      `the splits total ${total.toFixed(2)} but only ${remainder.toFixed(2)} remains unallocated`,
    )
  }

  // per-bill journal locks in canonical ascending order
  const sorted = [...allocations].sort((a, b) => a.bill - b.bill)
  for (const split of sorted) {
    if (!(split.amount > 0)) {
      throw new OperationRefused('bad_amount', 'each split is above zero')
    }
    const bill = await tx.query(
      `select id, matter, state from deedbox.bill where id = $1 for update`,
      [split.bill],
    )
    if (bill.rowCount === 0) throw new OperationRefused('not_found', `bill ${split.bill} not found`)
    if (bill.rows[0].state !== 'issued') {
      throw new OperationRefused('not_issued', `bill ${split.bill} is not issued`)
    }
    const outstanding = await tx.query(`select deedbox.bill_outstanding($1) as o`, [split.bill])
    if (split.amount > Number(outstanding.rows[0].o) + 0.005) {
      throw new OperationRefused(
        'beyond_outstanding',
        `allocating ${split.amount.toFixed(2)} to bill ${split.bill} exceeds its outstanding ${Number(outstanding.rows[0].o).toFixed(2)} — the surplus stays on the payment`,
      )
    }
    const entry = await tx.query(
      `insert into deedbox.bill_journal_entry
         (bill, entry_kind, signed_amount, source_type, source, effective_date, entered_by)
       values ($1, 'payment_allocation', $2, 'receivable_payment', $3, current_date, $4)
       returning id`,
      [split.bill, -split.amount, paymentId, p.id],
    )
    // the collection fan mirrors the bill's current attribution shares
    const attr = await tx.query(
      `select staff, billed_share from deedbox.bill_attribution
        where bill = $1 and superseded_at is null order by id`,
      [split.bill],
    )
    if (attr.rowCount! > 0) {
      const totalShare = attr.rows.reduce((s, a) => s + Number(a.billed_share), 0)
      let fanned = 0
      for (let i = 0; i < attr.rows.length; i++) {
        const isLast = i === attr.rows.length - 1
        const cut = isLast
          ? Math.round((split.amount - fanned) * 100) / 100
          : Math.round(((split.amount * Number(attr.rows[i].billed_share)) / totalShare) * 100) / 100
        fanned = Math.round((fanned + cut) * 100) / 100
        if (cut !== 0) {
          await tx.query(
            `insert into deedbox.collection_attribution (allocation_entry, staff, amount)
             values ($1, $2, $3)`,
            [entry.rows[0].id, attr.rows[i].staff, cut],
          )
        }
      }
    }
    // outstanding reaching zero stops a running reminder
    const after = await tx.query(`select deedbox.bill_outstanding($1) as o`, [split.bill])
    if (Number(after.rows[0].o) === 0) {
      await tx.query(
        `update deedbox.bill_reminder_state set status = 'stopped_paid'
          where bill = $1 and status = 'running'`,
        [split.bill],
      )
    }
    // cumulative instalment coverage rides the allocating transaction
    await applyInstalmentCoverageInTx(tx, p, split.bill)
    await emitRegister(tx, p, {
      kind: 'record.changed',
      subjectType: 'receivable_payment',
      subject: paymentId,
      matter: bill.rows[0].matter as number,
      detail: { allocated: { bill: split.bill, amount: split.amount } },
    })
  }
}

/** Reverse one allocation. */
export async function unallocatePayment(
  p: Principal,
  input: { allocationEntry: number; reason: string },
): Promise<void> {
  requireStaff(p)
  if (!input.reason.trim()) {
    throw new OperationRefused('reason_required', 'an unallocation always carries its reason')
  }
  await withPrincipal(p, (tx) => unallocateInTx(tx, p, input.allocationEntry, input.reason))
}

async function unallocateInTx(
  tx: Tx,
  p: Principal,
  entryId: number,
  reason: string,
): Promise<void> {
  const entry = await tx.query(
    `select j.id, j.bill, j.entry_kind, j.signed_amount, j.source, b.matter,
            exists (select 1 from deedbox.bill_journal_entry r where r.reverses = j.id) as reversed
       from deedbox.bill_journal_entry j join deedbox.bill b on b.id = j.bill
      where j.id = $1`,
    [entryId],
  )
  if (entry.rowCount === 0) throw new OperationRefused('not_found', 'allocation entry not found')
  const e = entry.rows[0]
  if (e.entry_kind !== 'payment_allocation') {
    throw new OperationRefused('not_allocation', 'only payment allocations unallocate here')
  }
  if (e.reversed) throw new OperationRefused('already_reversed', 'this allocation is already reversed')

  await tx.query(`select id from deedbox.bill where id = $1 for update`, [e.bill])
  const rev = await tx.query(
    `insert into deedbox.bill_journal_entry
       (bill, entry_kind, signed_amount, source_type, source, effective_date, entered_by, reverses, reason)
     values ($1, 'reversal', $2, 'receivable_payment', $3, current_date, $4, $5, $6)
     returning id`,
    [e.bill, -Number(e.signed_amount), e.source, p.id, entryId, reason],
  )
  // the reversal's fan mirrors the original's rows; the schema requires every
  // fan to sum to its entry's absolute amount, so the mirroring lives in the
  // reversal linkage, not the sign
  const fan = await tx.query(
    `select staff, amount from deedbox.collection_attribution where allocation_entry = $1`,
    [entryId],
  )
  for (const f of fan.rows) {
    await tx.query(
      `insert into deedbox.collection_attribution (allocation_entry, staff, amount)
       values ($1, $2, $3)`,
      [rev.rows[0].id, f.staff, Number(f.amount)],
    )
  }
  // a paid stop with outstanding restored returns to running
  const outstanding = await tx.query(`select deedbox.bill_outstanding($1) as o`, [e.bill])
  if (Number(outstanding.rows[0].o) > 0) {
    await tx.query(
      `update deedbox.bill_reminder_state set status = 'running'
        where bill = $1 and status = 'stopped_paid'`,
      [e.bill],
    )
  }
  await emitRegister(tx, p, {
    kind: 'record.changed',
    subjectType: 'receivable_payment',
    subject: e.source as number,
    matter: e.matter as number,
    reason,
    detail: { unallocated: { bill: e.bill, amount: -Number(e.signed_amount) } },
  })
}

/** The correcting mirror: never an edit, never an unlinked negative. */
export async function correctPayment(
  p: Principal,
  input: { payment: number; reason: string },
): Promise<{ mirror: number; receiptNumber: string }> {
  requireStaff(p)
  if (!input.reason.trim()) {
    throw new OperationRefused('reason_required', 'a correction always carries its reason')
  }
  return withPrincipal(p, async (tx) => {
    await lockPayment(tx, input.payment)
    const pay = await tx.query(
      `select id, amount, reverses,
              exists (select 1 from deedbox.receivable_payment m where m.reverses = deedbox.receivable_payment.id) as mirrored
         from deedbox.receivable_payment where id = $1`,
      [input.payment],
    )
    if (pay.rowCount === 0) throw new OperationRefused('not_found', 'payment not found')
    if (pay.rows[0].reverses !== null || pay.rows[0].mirrored) {
      throw new OperationRefused('already_mirrored', 'this payment is already corrected')
    }
    // reverse every un-reversed allocation, canonical order
    const open = await tx.query(
      `select j.id from deedbox.bill_journal_entry j
        where j.source_type = 'receivable_payment' and j.source = $1
          and j.entry_kind = 'payment_allocation'
          and not exists (select 1 from deedbox.bill_journal_entry r where r.reverses = j.id)
        order by j.bill`,
      [input.payment],
    )
    for (const row of open.rows) {
      await unallocateInTx(tx, p, row.id as number, input.reason)
    }
    const num = await tx.query(`select deedbox.allocate_number('receivable_receipt') as n`)
    const receiptNumber = num.rows[0].n as string
    const mirror = await tx.query(
      `insert into deedbox.receivable_payment
         (received_date, amount, method, receipt_number, reverses, reason)
       select received_date, amount, method, $2, id, $3
         from deedbox.receivable_payment where id = $1
       returning id`,
      [input.payment, receiptNumber, input.reason],
    )
    await emitRegister(tx, p, {
      kind: 'record.changed',
      subjectType: 'receivable_payment',
      subject: input.payment,
      reason: input.reason,
      detail: { corrected_by: mirror.rows[0].id, receipt_number: receiptNumber },
    })
    return { mirror: mirror.rows[0].id as number, receiptNumber }
  })
}
