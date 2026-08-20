// Held-funds application, the ONE bridge between the two money worlds,
// executing the corresponding client-money operation jointly. Preview derives
// candidates and writes the bulk-operation record + run + items with nothing
// financial moving. Commit drafts and submits one firm-transfer payment
// document per item; the money world's authorisation ceremony (authoriser ≠
// requester, dual control at or above the firm threshold) then gates each
// item — an approval that completes the count executes the WHOLE bridge in
// one database transaction: the payment executes under the posting protocol
// (entitlement actionability and headroom checked by the document machine at
// the executed transition, the below-zero and earmark guards at the lines),
// and the billing side writes the receivable payment, the allocation entry,
// the collection fan and the item's completion. A posting refusal is captured
// in the refusal register by runMoneyOperation, the payment blocks, the item
// records the typed reason, and the remaining items proceed independently.
//
// Implementation notes: the run actor is always the payment's requester, so
// the separation rule means every item parks awaiting_authorisation at commit
// and completes through the authorisation queue (the inline-complete case
// cannot arise for a fresh payment); the transfer's payee is recorded by
// description ("the firm — costs transfer") — the firm holds no party row;
// the transfer method is electronic_transfer; canonical lock order holds:
// ledger → bill → counters (money_payment before receivable_receipt,
// purpose-enum order) → chain.

import type { Principal, Tx } from '@/lib/db'
import { withPrincipal, emitRegister, OperationRefused, runMoneyOperation, MoneyRefusal } from '@/lib/db'
import { requireStaff, requireCapability, hasCapability, settingText, settingBool } from '@/lib/ops/shared'
import { allocateInTx } from './payments'

interface Candidate {
  matterLedger: number
  account: number
  entitlement: number
  bill: number
  matter: number
  amount: number
}

interface RefusedCandidate {
  entitlement: number
  bill: number | null
  reason: string
}

function cents(x: number | string): number {
  return Math.round(Number(x) * 100)
}

async function deriveCandidates(
  tx: Tx,
  matters: number[],
): Promise<{ executable: Candidate[]; refused: RefusedCandidate[] }> {
  const rows = await tx.query(
    `select e.id as entitlement, e.bill, e.amount as ent_amount,
            ml.id as ledger, ml.account, ml.matter,
            deedbox.entitlement_status(e.id) as status,
            e.amount - deedbox.entitlement_consumed(e.id) as headroom,
            deedbox.ledger_available(ml.id) as available,
            case when e.bill is not null then deedbox.bill_outstanding(e.bill) end as outstanding
       from deedbox.entitlement e
       join deedbox.matter_ledger ml on ml.id = e.matter_ledger
      where ml.matter = any($1) and ml.status = 'open' and e.cancelled_at is null
      order by e.id`,
    [matters],
  )
  const executable: Candidate[] = []
  const refused: RefusedCandidate[] = []
  for (const r of rows.rows) {
    if (r.status !== 'actionable') {
      refused.push({ entitlement: r.entitlement, bill: r.bill, reason: `entitlement is ${r.status}` })
      continue
    }
    if (r.bill === null) {
      refused.push({
        entitlement: r.entitlement,
        bill: null,
        reason: 'pack-basis entitlements apply through their own ceremony, not this run',
      })
      continue
    }
    const headroom = cents(r.headroom)
    const available = cents(r.available)
    const outstanding = cents(r.outstanding)
    const amount = Math.min(headroom, available, outstanding)
    if (outstanding <= 0) {
      refused.push({ entitlement: r.entitlement, bill: r.bill, reason: 'nothing outstanding on the bill' })
    } else if (headroom <= 0) {
      refused.push({ entitlement: r.entitlement, bill: r.bill, reason: 'no headroom remains on the entitlement' })
    } else if (available <= 0) {
      refused.push({ entitlement: r.entitlement, bill: r.bill, reason: 'no available (non-earmarked) funds held' })
    } else {
      executable.push({
        matterLedger: r.ledger as number,
        account: r.account as number,
        entitlement: r.entitlement as number,
        bill: r.bill as number,
        matter: r.matter as number,
        amount: amount / 100,
      })
    }
  }
  return { executable, refused }
}

/** Preview (dry run): the bulk-operation record, the run, the items; nothing moves. */
export async function previewHeldFundsApplication(
  p: Principal,
  input: { matter?: number; matters?: number[] },
): Promise<{
  run: number
  executable: Candidate[]
  refused: RefusedCandidate[]
}> {
  requireStaff(p)
  const matters = input.matters ?? (input.matter !== undefined ? [input.matter] : [])
  if (matters.length === 0) {
    throw new OperationRefused('no_scope', 'name a matter or a cross-matter selection')
  }
  return withPrincipal(p, async (tx) => {
    await requireCapability(tx, p, 'money.apply_held_funds')
    const { executable, refused } = await deriveCandidates(tx, matters)
    if (executable.length + refused.length === 0) {
      throw new OperationRefused('nothing_to_apply', 'no entitlements exist in this scope')
    }
    const summary = {
      scope: matters,
      executable: executable.map((c) => ({
        entitlement: c.entitlement,
        bill: c.bill,
        ledger: c.matterLedger,
        amount: c.amount,
        verdict: 'needs-authorisation',
      })),
      refused,
    }
    const op = await tx.query(
      `insert into deedbox.bulk_operation (operation_kind, dry_run_summary, reversible_until)
       values ('held_funds_application', $1, now()) returning id`,
      [JSON.stringify(summary)],
    )
    const run = await tx.query(
      `insert into deedbox.application_run (run_by, scope, bulk_operation)
       values ($1, $2, $3) returning id`,
      [p.id, matters.length === 1 ? 'single_matter' : 'cross_matter', op.rows[0].id],
    )
    const runId = run.rows[0].id as number
    for (const c of executable) {
      await tx.query(
        `insert into deedbox.funds_application (run, matter_ledger, entitlement, bill, amount)
         values ($1, $2, $3, $4, $5)`,
        [runId, c.matterLedger, c.entitlement, c.bill, c.amount],
      )
    }
    // refused candidates are itemised on the dry-run summary only — an item
    // row exists for executable work; a refused candidate has no honest
    // amount to record
    await emitRegister(tx, p, {
      kind: 'record.created',
      subjectType: 'application_run',
      subject: runId,
      detail: { executable: executable.length, refused: refused.length },
    })
    return { run: runId, executable, refused }
  })
}

/**
 * Commit: one firm-transfer payment document per item, drafted and
 * submitted; every item then awaits the authorisation ceremony.
 */
export async function commitHeldFundsApplication(
  p: Principal,
  input: { run: number },
): Promise<{ awaiting: number[]; refused: { item: number; reason: string }[] }> {
  requireStaff(p)
  const items = await withPrincipal(p, async (tx) => {
    await requireCapability(tx, p, 'money.apply_held_funds')
    const run = await tx.query(
      `select id, state from deedbox.application_run where id = $1 for update`,
      [input.run],
    )
    if (run.rowCount === 0) throw new OperationRefused('not_found', 'application run not found')
    if (run.rows[0].state !== 'previewed') {
      throw new OperationRefused('wrong_state', `a ${run.rows[0].state} run cannot commit`)
    }
    await tx.query(`update deedbox.application_run set state = 'committing' where id = $1`, [
      input.run,
    ])
    await tx.query(
      `update deedbox.bulk_operation bo set committed_at = now(), committed_by = $2
        from deedbox.application_run ar
       where ar.id = $1 and bo.id = ar.bulk_operation`,
      [input.run, p.id],
    )
    const r = await tx.query(
      `select id, matter_ledger, entitlement, bill, amount from deedbox.funds_application
        where run = $1 and item_state = 'previewed' order by id`,
      [input.run],
    )
    await emitRegister(tx, p, {
      kind: 'bulk.committed',
      subjectType: 'application_run',
      subject: input.run,
      detail: { items: r.rowCount },
    })
    return r.rows as { id: number; matter_ledger: number; entitlement: number; bill: number; amount: string }[]
  })

  const awaiting: number[] = []
  const refused: { item: number; reason: string }[] = []
  const threshold = Number(
    (await withPrincipal(p, (tx) => settingText(tx, 'money.dual_authorisation_threshold'), {
      readOnly: true,
    })) ?? NaN,
  )
  for (const item of items) {
    try {
      await withPrincipal(p, async (tx) => {
        // re-verify the item is still executable before drafting its payment
        const check = await tx.query(
          `select deedbox.entitlement_status($1) as status,
                  (select e.amount - deedbox.entitlement_consumed(e.id)
                     from deedbox.entitlement e where e.id = $1) as headroom,
                  deedbox.ledger_available($2) as available,
                  deedbox.bill_outstanding($3) as outstanding`,
          [item.entitlement, item.matter_ledger, item.bill],
        )
        const c = check.rows[0]
        const amt = cents(item.amount)
        if (c.status !== 'actionable') {
          throw new OperationRefused('entitlement_missing', `entitlement is ${c.status}`)
        }
        if (cents(c.headroom) < amt) throw new OperationRefused('beyond_headroom', 'headroom has shrunk')
        if (cents(c.available) < amt) throw new OperationRefused('beyond_available', 'available funds have shrunk')
        if (cents(c.outstanding) < amt) throw new OperationRefused('beyond_outstanding', 'the bill outstanding has shrunk')

        const required = Number.isFinite(threshold) && Number(item.amount) >= threshold ? 2 : 1
        const pay = await tx.query(
          `insert into deedbox.money_payment
             (matter_ledger, payee_description, method, amount, reason, requested_by,
              purpose, entitlement)
           values ($1, 'the firm — costs transfer', 'electronic_transfer', $2,
                   'transfer of billed costs against entitlement', $3, 'firm_transfer', $4)
           returning id`,
          [item.matter_ledger, Number(item.amount), p.id, item.entitlement],
        )
        await tx.query(
          `update deedbox.money_payment
              set state = 'pending_authorisation', required_authorisations = $2::int
            where id = $1`,
          [pay.rows[0].id, required],
        )
        await tx.query(
          `update deedbox.funds_application
              set item_state = 'awaiting_authorisation', money_payment = $2
            where id = $1`,
          [item.id, pay.rows[0].id],
        )
        await emitRegister(tx, p, {
          kind: 'record.changed',
          subjectType: 'funds_application',
          subject: item.id,
          detail: { awaiting_authorisation: true, money_payment: pay.rows[0].id, required },
        })
      })
      awaiting.push(item.id)
    } catch (e) {
      if (e instanceof OperationRefused) {
        await withPrincipal(p, async (tx) => {
          await tx.query(
            `update deedbox.funds_application
                set item_state = 'refused', refusal_reason = $2
              where id = $1`,
            [item.id, e.message],
          )
          await emitRegister(tx, p, {
            kind: 'record.changed',
            subjectType: 'funds_application',
            subject: item.id,
            detail: { refused: e.message },
          })
        })
        refused.push({ item: item.id, reason: e.message })
      } else {
        throw e
      }
    }
  }
  await recomputeRunState(p, input.run)
  return { awaiting, refused }
}

async function recomputeRunState(p: Principal, runId: number): Promise<void> {
  await withPrincipal(p, async (tx) => {
    const run = await tx.query(
      `select state from deedbox.application_run where id = $1 for update`,
      [runId],
    )
    if (run.rows[0].state !== 'committing') return
    const open = await tx.query(
      `select count(*) filter (where item_state in ('previewed','awaiting_authorisation'))::int as open,
              count(*) filter (where item_state = 'refused')::int as refused
         from deedbox.funds_application where run = $1`,
      [runId],
    )
    if ((open.rows[0].open as number) > 0) return
    const final = (open.rows[0].refused as number) > 0 ? 'completed_with_refusals' : 'completed'
    await tx.query(`update deedbox.application_run set state = $2 where id = $1`, [runId, final])
    await emitRegister(tx, p, {
      kind: 'record.changed',
      subjectType: 'application_run',
      subject: runId,
      detail: { before: { state: 'committing' }, after: { state: final } },
    })
  })
}

/**
 * The authorisation queue acting on one parked item. An approval
 * that completes the required count executes the whole bridge in one
 * database transaction; a rejection refuses the item with the authoriser's
 * reason. The separation rule binds: the authoriser is never the
 * requester, and a second authoriser is distinct from the first.
 */
export async function authoriseHeldFundsItem(
  p: Principal,
  input: { item: number; decision: 'approve' | 'reject'; note?: string },
): Promise<
  | { executed: true; receiptNumber: string; paymentNumber: string }
  | { executed: false; state: string }
> {
  requireStaff(p)
  if (input.decision === 'reject' && !input.note?.trim()) {
    throw new OperationRefused('reason_required', 'a rejection carries its reason')
  }

  // step 1 (its own committed transaction): the authorisation row and the
  // document transition — approval evidence survives any later posting refusal
  const staged = await withPrincipal(p, async (tx) => {
    const item = await tx.query(
      `select fa.id, fa.item_state, fa.money_payment, fa.matter_ledger, fa.entitlement,
              fa.bill, fa.amount, ml.account, b.matter
         from deedbox.funds_application fa
         join deedbox.matter_ledger ml on ml.id = fa.matter_ledger
         join deedbox.bill b on b.id = fa.bill
        where fa.id = $1 for update of fa`,
      [input.item],
    )
    if (item.rowCount === 0) throw new OperationRefused('not_found', 'application item not found')
    const it = item.rows[0]
    if (it.item_state !== 'awaiting_authorisation') {
      throw new OperationRefused('not_awaiting', `a ${it.item_state} item takes no authorisation`)
    }
    const pay = await tx.query(
      `select id, state, requested_by, required_authorisations, run
         from deedbox.money_payment mp,
              lateral (select fa.run from deedbox.funds_application fa where fa.id = $2) r
        where mp.id = $1 for update of mp`,
      [it.money_payment, input.item],
    )
    const payment = pay.rows[0]
    if (payment.state !== 'pending_authorisation') {
      throw new OperationRefused('not_pending', `the payment is ${payment.state}`)
    }
    if (payment.requested_by === p.id && !(await settingBool(tx, 'money.self_authorisation'))) {
      throw new OperationRefused('separation', 'the requester never authorises their own transfer')
    }
    if (input.decision === 'reject') {
      await tx.query(
        `insert into deedbox.payment_authorisation (subject_type, subject, authoriser, decision, note)
         values ('money_payment', $1, $2, 'rejected', $3)`,
        [payment.id, p.id, input.note],
      )
      await tx.query(
        `update deedbox.money_payment set state = 'rejected', rejection_reason = $2 where id = $1`,
        [payment.id, input.note],
      )
      await tx.query(
        `update deedbox.funds_application set item_state = 'refused', refusal_reason = $2
          where id = $1`,
        [input.item, `authorisation rejected: ${input.note}`],
      )
      await emitRegister(tx, p, {
        kind: 'money.payment_authorised',
        subjectType: 'money_payment',
        subject: payment.id as number,
        matter: it.matter as number,
        privileged: true,
        reason: input.note,
        detail: {
          before: { state: 'pending_authorisation' },
          after: { state: 'rejected', decision: 'rejected' },
        },
      })
      return { kind: 'rejected' as const, run: payment.run as number }
    }

    await requireCapability(tx, p, 'money.authorise_payment')
    const prior = await tx.query(
      `select authoriser from deedbox.payment_authorisation
        where subject_type = 'money_payment' and subject = $1 and decision = 'approved'`,
      [payment.id],
    )
    if (prior.rows.some((r) => r.authoriser === p.id)) {
      throw new OperationRefused('already_authorised', 'one approval per authoriser')
    }
    if (prior.rowCount! > 0) {
      // a second approval demands the second-authoriser right
      if (!(await hasCapability(tx, p.id, 'money.authorise_second'))) {
        throw new OperationRefused('capability_missing', 'the second approval requires money.authorise_second')
      }
    }
    const auth = await tx.query(
      `insert into deedbox.payment_authorisation (subject_type, subject, authoriser, decision, note)
       values ('money_payment', $1, $2, 'approved', $3) returning id`,
      [payment.id, p.id, input.note ?? null],
    )
    const count = prior.rowCount! + 1
    const complete = count >= (payment.required_authorisations as number)
    if (complete) {
      await tx.query(`update deedbox.money_payment set state = 'authorised' where id = $1`, [
        payment.id,
      ])
    }
    await emitRegister(tx, p, {
      kind: 'money.payment_authorised',
      subjectType: 'money_payment',
      subject: payment.id as number,
      matter: it.matter as number,
      privileged: true,
      detail: {
        before: { state: 'pending_authorisation', approvals: count - 1 },
        after: { state: complete ? 'authorised' : 'pending_authorisation', approvals: count },
      },
    })
    return {
      kind: complete ? ('authorised' as const) : ('pending' as const),
      run: payment.run as number,
      payment: payment.id as number,
      authorisation: auth.rows[0].id as number,
      item: {
        id: it.id as number,
        matterLedger: it.matter_ledger as number,
        account: it.account as number,
        entitlement: it.entitlement as number,
        bill: it.bill as number,
        matter: it.matter as number,
        amount: Number(it.amount),
      },
    }
  })

  if (staged.kind === 'rejected') {
    await recomputeRunState(p, staged.run)
    return { executed: false, state: 'rejected' }
  }
  if (staged.kind === 'pending') {
    return { executed: false, state: 'awaiting_second_authorisation' }
  }

  // step 2: the bridge — shared with the payments screen's route
  return executeBridge(p, {
    payment: staged.payment,
    authorisation: staged.authorisation,
    run: staged.run,
    item: staged.item,
  })
}

interface BridgeItem {
  id: number
  matterLedger: number
  account: number
  entitlement: number
  bill: number
  matter: number
  amount: number
}

interface BridgeStage {
  payment: number
  authorisation: number
  run: number
  item: BridgeItem
}

/**
 * The completion half: the office-world writes that make an EXECUTED
 * transfer actually PAY its bill — the receivable receipt, the allocation,
 * and the item's completion. One home, three callers: the bridge, the
 * payments screen's route, and the self-heal for a transfer some other
 * door executed without finishing (the two-door seam found on the first
 * live invoicing day).
 */
async function completeItemInTx(
  tx: Tx,
  p: Principal,
  it: BridgeItem,
): Promise<{ receiptNumber: string; receivablePayment: number }> {
  const orNum = await tx.query(`select deedbox.allocate_number('receivable_receipt') as n`)
  const rp = await tx.query(
    `insert into deedbox.receivable_payment
       (payer_party, received_date, amount, method, source, funds_application, receipt_number)
     select b.payer_party, current_date, $2, 'trust_transfer', 'held_funds_application', $3, $4
       from deedbox.bill b where b.id = $1
     returning id`,
    [it.bill, it.amount, it.id, orNum.rows[0].n],
  )
  await allocateInTx(tx, p, rp.rows[0].id as number, [{ bill: it.bill, amount: it.amount }])
  const entry = await tx.query(
    `select id from deedbox.bill_journal_entry
      where source_type = 'receivable_payment' and source = $1 and entry_kind = 'payment_allocation'`,
    [rp.rows[0].id],
  )
  await tx.query(
    `update deedbox.funds_application
        set item_state = 'completed', receivable_payment = $2, allocation_entry = $3
      where id = $1`,
    [it.id, rp.rows[0].id, entry.rows[0].id],
  )
  return { receiptNumber: orNum.rows[0].n as string, receivablePayment: rp.rows[0].id as number }
}

// the bridge proper — ONE database transaction across both money worlds,
// wrapped for refusal capture
async function executeBridge(
  p: Principal,
  staged: BridgeStage,
): Promise<{ executed: true; paymentNumber: string; receiptNumber: string }> {
  const it = staged.item
  try {
    const result = await runMoneyOperation(
      p,
      { account: it.account, matterLedger: it.matterLedger, operation: 'held_funds_application' },
      async (tx) => {
        // canonical lock order: ledger → bill → counters → chain head
        await tx.query(`select id from deedbox.matter_ledger where id = $1 for update`, [
          it.matterLedger,
        ])
        const bill = await tx.query(`select id from deedbox.bill where id = $1 for update`, [
          it.bill,
        ])
        if (bill.rowCount === 0) throw new OperationRefused('not_found', 'bill not found')
        const outstanding = await tx.query(`select deedbox.bill_outstanding($1) as o`, [it.bill])
        if (cents(outstanding.rows[0].o) < cents(it.amount)) {
          throw new OperationRefused(
            'beyond_outstanding',
            'the bill outstanding shrank below the item amount',
          )
        }
        // the transfer posts: counters in purpose-enum order (money_payment
        // before receivable_receipt)
        const payNum = await tx.query(`select deedbox.allocate_number('money_payment') as n`)
        const txn = await tx.query(
          `select deedbox.post_money_transaction(
             'firm_transfer', current_date, $1, 'money_payment', $2,
             jsonb_build_array(
               jsonb_build_object('side','cash_book','account',$3::bigint,'signed_amount',-($5::numeric)),
               jsonb_build_object('side','matter_ledger','account',$3::bigint,'matter_ledger',$4::bigint,'signed_amount',-($5::numeric))
             ), 'transfer of billed costs against entitlement', $6) as t`,
          [p.id, staged.payment, it.account, it.matterLedger, it.amount, staged.authorisation],
        )
        // the document machine verifies actionability + headroom AT this hop
        await tx.query(
          `update deedbox.money_payment
              set state = 'executed', transaction = $2, payment_number = $3
            where id = $1`,
          [staged.payment, txn.rows[0].t, payNum.rows[0].n],
        )
        const done = await completeItemInTx(tx, p, it)
        await emitRegister(tx, p, {
          kind: 'money.transaction_posted',
          subjectType: 'money_transaction',
          subject: txn.rows[0].t as number,
          matter: it.matter,
          detail: {
            kind: 'firm_transfer',
            amount: it.amount,
            payment_number: payNum.rows[0].n,
            receipt_number: done.receiptNumber,
            application_item: it.id,
          },
        })
        return { paymentNumber: payNum.rows[0].n as string, receiptNumber: done.receiptNumber }
      },
    )
    await recomputeRunState(p, staged.run)
    return { executed: true, ...result }
  } catch (e) {
    if (e instanceof MoneyRefusal || e instanceof OperationRefused) {
      // the standard failure shape: the payment blocks in a follow-up committed
      // transaction and the item records the typed reason
      await withPrincipal(p, async (tx) => {
        await tx.query(`update deedbox.money_payment set state = 'blocked' where id = $1`, [
          staged.payment,
        ])
        await tx.query(
          `update deedbox.funds_application set item_state = 'refused', refusal_reason = $2
            where id = $1`,
          [it.id, e.message],
        )
        await emitRegister(tx, p, {
          kind: 'record.changed',
          subjectType: 'funds_application',
          subject: it.id,
          matter: it.matter,
          detail: { refused: e.message, payment_blocked: staged.payment },
        })
      })
      await recomputeRunState(p, staged.run)
      throw e
    }
    throw e
  }
}

/**
 * Execute a bridge transfer BY ITS PAYMENT — the payments screen's route.
 * The payment must already be authorised (its approvals happened on that
 * screen); the bridge then does what it always does: post the transfer and
 * pay the bill in one transaction.
 */
export async function executeHeldFundsPayment(
  p: Principal,
  input: { payment: number },
): Promise<{ executed: true; paymentNumber: string; receiptNumber: string }> {
  requireStaff(p)
  const staged = await withPrincipal(
    p,
    async (tx) => {
      const item = await tx.query(
        `select fa.id, fa.item_state, fa.money_payment, fa.matter_ledger, fa.entitlement,
                fa.bill, fa.amount, fa.run, ml.account, b.matter, mp.state as payment_state,
                (select a.id from deedbox.payment_authorisation a
                  where a.subject_type = 'money_payment' and a.subject = fa.money_payment
                    and a.decision = 'approved' order by a.id desc limit 1) as authorisation
           from deedbox.funds_application fa
           join deedbox.matter_ledger ml on ml.id = fa.matter_ledger
           join deedbox.bill b on b.id = fa.bill
           join deedbox.money_payment mp on mp.id = fa.money_payment
          where fa.money_payment = $1`,
        [input.payment],
      )
      if (item.rowCount === 0) {
        throw new OperationRefused('not_found', 'no held-funds application carries this payment')
      }
      const it = item.rows[0]
      if (it.item_state !== 'awaiting_authorisation') {
        throw new OperationRefused('not_awaiting', `a ${it.item_state} item takes no execution`)
      }
      if (it.payment_state !== 'authorised') {
        throw new OperationRefused('not_authorised', `the payment is ${it.payment_state} — approve it first`)
      }
      if (it.authorisation === null) {
        throw new OperationRefused('not_authorised', 'no approval is recorded for this payment')
      }
      return it
    },
    { readOnly: true },
  )
  return executeBridge(p, {
    payment: input.payment,
    authorisation: staged.authorisation as number,
    run: staged.run as number,
    item: {
      id: staged.id as number,
      matterLedger: staged.matter_ledger as number,
      account: staged.account as number,
      entitlement: staged.entitlement as number,
      bill: staged.bill as number,
      matter: staged.matter as number,
      amount: Number(staged.amount),
    },
  })
}

/**
 * The self-heal: a bridge transfer whose PAYMENT already executed without
 * the bill side (the two-door seam, before the payments screen routed
 * through the bridge) gets its completion half — receivable receipt,
 * allocation, item completed — against the transfer that already happened.
 */
export async function completeExecutedHeldFundsItem(
  p: Principal,
  input: { item: number },
): Promise<{ receiptNumber: string }> {
  requireStaff(p)
  const staged = await withPrincipal(
    p,
    async (tx) => {
      const item = await tx.query(
        `select fa.id, fa.item_state, fa.money_payment, fa.matter_ledger, fa.entitlement,
                fa.bill, fa.amount, fa.run, ml.account, b.matter,
                mp.state as payment_state, mp.transaction, mp.payment_number
           from deedbox.funds_application fa
           join deedbox.matter_ledger ml on ml.id = fa.matter_ledger
           join deedbox.bill b on b.id = fa.bill
           join deedbox.money_payment mp on mp.id = fa.money_payment
          where fa.id = $1`,
        [input.item],
      )
      if (item.rowCount === 0) throw new OperationRefused('not_found', 'application item not found')
      const it = item.rows[0]
      if (it.item_state !== 'awaiting_authorisation') {
        throw new OperationRefused('not_awaiting', `a ${it.item_state} item takes no completion`)
      }
      if (it.payment_state !== 'executed') {
        throw new OperationRefused('payment_not_executed', `the payment is ${it.payment_state} — this heal is only for transfers that already moved`)
      }
      return it
    },
    { readOnly: true },
  )
  const it: BridgeItem = {
    id: staged.id as number,
    matterLedger: staged.matter_ledger as number,
    account: staged.account as number,
    entitlement: staged.entitlement as number,
    bill: staged.bill as number,
    matter: staged.matter as number,
    amount: Number(staged.amount),
  }
  const result = await runMoneyOperation(
    p,
    { account: it.account, matterLedger: it.matterLedger, operation: 'held_funds_application' },
    async (tx) => {
      await tx.query(`select id from deedbox.matter_ledger where id = $1 for update`, [
        it.matterLedger,
      ])
      const bill = await tx.query(`select id from deedbox.bill where id = $1 for update`, [it.bill])
      if (bill.rowCount === 0) throw new OperationRefused('not_found', 'bill not found')
      const outstanding = await tx.query(`select deedbox.bill_outstanding($1) as o`, [it.bill])
      if (cents(outstanding.rows[0].o) < cents(it.amount)) {
        throw new OperationRefused(
          'beyond_outstanding',
          'the bill outstanding shrank below the item amount',
        )
      }
      const done = await completeItemInTx(tx, p, it)
      await emitRegister(tx, p, {
        kind: 'record.changed',
        subjectType: 'funds_application',
        subject: it.id,
        matter: it.matter,
        detail: {
          completed_after_external_execution: true,
          transaction: staged.transaction,
          payment_number: staged.payment_number,
          receipt_number: done.receiptNumber,
        },
      })
      return { receiptNumber: done.receiptNumber }
    },
  )
  await recomputeRunState(p, staged.run as number)
  return result
}

/** Abandon a previewed run before commit. */
export async function abandonHeldFundsRun(p: Principal, input: { run: number }): Promise<void> {
  requireStaff(p)
  await withPrincipal(p, async (tx) => {
    const run = await tx.query(
      `update deedbox.application_run set state = 'abandoned'
        where id = $1 and state = 'previewed' returning id`,
      [input.run],
    )
    if (run.rowCount === 0) {
      throw new OperationRefused('wrong_state', 'only a previewed run abandons')
    }
    await emitRegister(tx, p, {
      kind: 'record.changed',
      subjectType: 'application_run',
      subject: input.run,
      detail: { before: { state: 'previewed' }, after: { state: 'abandoned' } },
    })
  })
}
