// The client-money payment-out ceremony. A payment is a DOCUMENT walking a
// machine: draft → submitted (the required-approvals count computed and
// frozen at that one stated read moment: 2 at or above the firm's dual
// threshold or where the pack compels, else 1) → authorised (counted
// approvals; requester never approves; the second approver is distinct from
// both) → executed (ONE transaction through the posting protocol:
// available-funds and below-zero guards at the lines, entitlement
// actionability/headroom for firm transfers at the document machine, earmark
// consumption with residual re-earmark, the gapless P- number, instrument
// creation where the method demands) — or rejected / cancelled / blocked,
// each honestly registered. Execution failures follow the execution shape:
// the refusal is captured by the refusal-capture protocol, and the payment
// blocks in a follow-up committed transaction linked by the register.
//
// Implementation notes: the pack's method catalogue flags instrument-backed
// methods (neutral: cheque) — an outbound instrument number comes from the
// payment's own gapless number when the firm supplies none; earmark
// consumption writes the residual earmark in the same transaction,
// registered.

import type { Principal, Tx } from '@/lib/db'
import {
  withPrincipal,
  emitRegister,
  OperationRefused,
  runMoneyOperation,
  MoneyRefusal,
} from '@/lib/db'
import { requireStaff, requireCapability, hasCapability, settingText, settingBool, bankIdentifierKeys } from '@/lib/ops/shared'

function cents(x: number | string): number {
  return Math.round(Number(x) * 100)
}

/** Draft a payment document. No money effect. */
/** The stored shape of a payee's bank details: the account name plus the
 *  identifiers exactly as given (keys are the pack's declared field keys),
 *  trimmed; null when nothing was given. Never assembled. */
function bankDetailsJson(d?: { accountName?: string; identifiers?: Record<string, string> }): string | null {
  if (!d) return null
  const out: Record<string, string> = {}
  if (d.accountName?.trim()) out.account_name = d.accountName.trim()
  for (const [k, v] of Object.entries(d.identifiers ?? {})) {
    if (typeof v === 'string' && v.trim() && k !== 'account_name') out[k] = v.trim()
  }
  return Object.keys(out).length ? JSON.stringify(out) : null
}

export async function draftMoneyPayment(
  p: Principal,
  input: {
    matterLedger: number
    amount: number
    method: string
    reason: string
    payeeParty?: number
    payeeDescription?: string
    /** Where the money goes, as the payee gave it (0050); printed on the
     *  requisition. Identifier keys follow the pack's own declaration
     *  (bank.account_identifiers) — a key the pack does not declare refuses. */
    payeeBankDetails?: { accountName?: string; identifiers?: Record<string, string> }
    purpose?: 'general' | 'firm_transfer' | 'remittance'
    entitlement?: number
    earmark?: number
    /** A remittance names its dormant case. */
    dormantCase?: number
  },
): Promise<{ id: number }> {
  requireStaff(p)
  if (!(input.amount > 0)) throw new OperationRefused('bad_amount', 'a payment is above zero')
  if (!input.reason.trim()) throw new OperationRefused('reason_required', 'a payment carries its reason')
  if (!input.payeeParty && !input.payeeDescription?.trim()) {
    throw new OperationRefused('payee_required', 'name the payee, or describe them')
  }
  if ((input.purpose === 'firm_transfer') !== (input.entitlement !== undefined)) {
    throw new OperationRefused(
      'entitlement_required',
      'a firm transfer names its entitlement; other purposes never do',
    )
  }
  return withPrincipal(p, async (tx) => {
    await requireCapability(tx, p, 'money.record_payment')
    // where the pack declares identifier fields, only those keys are stored
    if (input.payeeBankDetails?.identifiers) {
      const keys = await bankIdentifierKeys(tx, p.firm)
      if (keys) {
        for (const [given, value] of Object.entries(input.payeeBankDetails.identifiers)) {
          if (value?.trim() && !keys.includes(given)) {
            throw new OperationRefused('unknown_field', `the pack declares no ${given} identifier`)
          }
        }
      }
    }
    const ledger = await tx.query(
      `select id, matter, status from deedbox.matter_ledger where id = $1`,
      [input.matterLedger],
    )
    if (ledger.rowCount === 0) throw new OperationRefused('not_found', 'ledger not found')
    if (ledger.rows[0].status !== 'open') {
      throw new OperationRefused('ledger_closed', 'payments draft against open ledgers only')
    }
    // the hard stop at ENTRY, in the drafter's own moment: a payment beyond
    // what the ledger holds available (balance less active earmarks) never
    // drafts. A payment drafted AGAINST an earmark spends that earmark, so
    // the named earmark's amount counts as spendable here. The execute-time
    // line guards remain the wall of record — funds can move between draft
    // and execution — but nobody drafts an overdraw and finds out at the
    // bank.
    const funds = await tx.query(
      `select deedbox.ledger_available($1)
              + coalesce((select e.amount from deedbox.earmark e
                           where e.id = $2 and e.matter_ledger = $1 and e.state = 'active'), 0)
              as spendable`,
      [input.matterLedger, input.earmark ?? null],
    )
    const spendable = Number(funds.rows[0].spendable)
    if (input.amount > spendable) {
      throw new OperationRefused(
        'exceeds_available',
        `the ledger holds $${spendable.toFixed(2)} available — a payment of $${input.amount.toFixed(2)} cannot be drafted; receipt the funds first or reduce the amount`,
      )
    }
    const r = await tx.query(
      `insert into deedbox.money_payment
         (matter_ledger, payee_party, payee_description, method, amount, reason,
          requested_by, purpose, entitlement, earmark, dormant_case, payee_bank_details)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12::jsonb) returning id`,
      [
        input.matterLedger,
        input.payeeParty ?? null,
        input.payeeDescription ?? null,
        input.method,
        input.amount,
        input.reason,
        p.id,
        input.purpose ?? 'general',
        input.entitlement ?? null,
        input.earmark ?? null,
        input.dormantCase ?? null,
        bankDetailsJson(input.payeeBankDetails),
      ],
    )
    await emitRegister(tx, p, {
      kind: 'record.created',
      subjectType: 'money_payment',
      subject: r.rows[0].id as number,
      matter: ledger.rows[0].matter as number,
      detail: { amount: input.amount, method: input.method, purpose: input.purpose ?? 'general' },
    })
    return { id: r.rows[0].id as number }
  })
}

/**
 * The dual-control read: 2 at/above the firm threshold or where the pack's
 * method catalogue (`money.payment_methods` — the catalogue's home for
 * per-method rules) flags the method dual-controlled, else 1.
 */
async function requiredApprovalsInTx(tx: Tx, firm: number, amount: number, method: string): Promise<number> {
  const threshold = Number((await settingText(tx, 'money.dual_authorisation_threshold')) ?? NaN)
  if (Number.isFinite(threshold) && amount >= threshold) return 2
  const decl = await tx.query(
    `select d.body from deedbox.pack_declaration d
       join deedbox.firm f on f.id = $1
       join deedbox.country_pack cp on cp.id = f.country_pack
       join deedbox.pack_version v on v.id = d.pack_version and v.id = cp.active_version
      where d.rule_point = 'money.payment_methods'`,
    [firm],
  )
  for (const row of decl.rows) {
    const b = row.body as { methods?: { key: string; dual_control?: boolean }[] }
    for (const m of b.methods ?? []) {
      if (m.key === method && m.dual_control) return 2
    }
  }
  return 1
}

/** Submit: the approvals count computed and frozen. */
export async function submitMoneyPayment(p: Principal, input: { payment: number }): Promise<{ required: number }> {
  requireStaff(p)
  return withPrincipal(p, async (tx) => {
    const pay = await tx.query(
      `select mp.id, mp.state, mp.amount, mp.method, ml.matter
         from deedbox.money_payment mp
         join deedbox.matter_ledger ml on ml.id = mp.matter_ledger
        where mp.id = $1 for update of mp`,
      [input.payment],
    )
    if (pay.rowCount === 0) throw new OperationRefused('not_found', 'payment not found')
    if (pay.rows[0].state !== 'draft') {
      throw new OperationRefused('wrong_state', `a ${pay.rows[0].state} payment cannot submit`)
    }
    const required = await requiredApprovalsInTx(tx, p.firm, Number(pay.rows[0].amount), pay.rows[0].method as string)
    await tx.query(
      `update deedbox.money_payment
          set state = 'pending_authorisation', required_authorisations = $2::int
        where id = $1`,
      [input.payment, required],
    )
    await emitRegister(tx, p, {
      kind: 'record.changed',
      subjectType: 'money_payment',
      subject: input.payment,
      matter: pay.rows[0].matter as number,
      detail: { before: 'draft', after: 'pending_authorisation', required_authorisations: required },
    })
    return { required }
  })
}

/**
 * Authorise. The requester never approves; a second approval
 * demands `money.authorise_second` and a person distinct from both. Returns
 * whether the document reached authorised.
 */
export async function authoriseMoneyPayment(
  p: Principal,
  input: { payment: number; note?: string },
): Promise<{ authorised: boolean; approvals: number; required: number }> {
  requireStaff(p)
  return withPrincipal(p, async (tx) => {
    const pay = await tx.query(
      `select mp.id, mp.state, mp.requested_by, mp.required_authorisations, ml.matter
         from deedbox.money_payment mp
         join deedbox.matter_ledger ml on ml.id = mp.matter_ledger
        where mp.id = $1 for update of mp`,
      [input.payment],
    )
    if (pay.rowCount === 0) throw new OperationRefused('not_found', 'payment not found')
    const row = pay.rows[0]
    if (row.state !== 'pending_authorisation') {
      throw new OperationRefused('not_pending', `a ${row.state} payment takes no authorisation`)
    }
    if (row.requested_by === p.id && !(await settingBool(tx, 'money.self_authorisation'))) {
      throw new OperationRefused('separation', 'the requester never authorises their own payment')
    }
    await requireCapability(tx, p, 'money.authorise_payment')
    const prior = await tx.query(
      `select authoriser from deedbox.payment_authorisation
        where subject_type = 'money_payment' and subject = $1 and decision = 'approved'`,
      [input.payment],
    )
    if (prior.rows.some((r) => r.authoriser === p.id)) {
      throw new OperationRefused('already_authorised', 'one approval per authoriser')
    }
    if (prior.rowCount! > 0 && !(await hasCapability(tx, p.id, 'money.authorise_second'))) {
      throw new OperationRefused('capability_missing', 'the second approval requires money.authorise_second')
    }
    await tx.query(
      `insert into deedbox.payment_authorisation (subject_type, subject, authoriser, decision, note)
       values ('money_payment', $1, $2, 'approved', $3)`,
      [input.payment, p.id, input.note ?? null],
    )
    const approvals = prior.rowCount! + 1
    const required = row.required_authorisations as number
    const complete = approvals >= required
    if (complete) {
      await tx.query(`update deedbox.money_payment set state = 'authorised' where id = $1`, [
        input.payment,
      ])
    }
    await emitRegister(tx, p, {
      kind: 'money.payment_authorised',
      subjectType: 'money_payment',
      subject: input.payment,
      matter: row.matter as number,
      privileged: true,
      detail: {
        before: { state: 'pending_authorisation', approvals: approvals - 1 },
        after: { state: complete ? 'authorised' : 'pending_authorisation', approvals },
      },
    })
    return { authorised: complete, approvals, required }
  })
}

/** Reject; reason required. */
export async function rejectMoneyPayment(
  p: Principal,
  input: { payment: number; reason: string },
): Promise<void> {
  requireStaff(p)
  if (!input.reason.trim()) throw new OperationRefused('reason_required', 'a rejection carries its reason')
  await withPrincipal(p, async (tx) => {
    await requireCapability(tx, p, 'money.authorise_payment')
    const pay = await tx.query(
      `select mp.id, mp.state, mp.requested_by, ml.matter
         from deedbox.money_payment mp join deedbox.matter_ledger ml on ml.id = mp.matter_ledger
        where mp.id = $1 for update of mp`,
      [input.payment],
    )
    if (pay.rowCount === 0) throw new OperationRefused('not_found', 'payment not found')
    if (pay.rows[0].state !== 'pending_authorisation') {
      throw new OperationRefused('not_pending', `a ${pay.rows[0].state} payment cannot reject`)
    }
    if (pay.rows[0].requested_by === p.id) {
      throw new OperationRefused('separation', 'the requester withdraws by cancelling, never by rejecting')
    }
    await tx.query(
      `insert into deedbox.payment_authorisation (subject_type, subject, authoriser, decision, note)
       values ('money_payment', $1, $2, 'rejected', $3)`,
      [input.payment, p.id, input.reason],
    )
    await tx.query(
      `update deedbox.money_payment set state = 'rejected', rejection_reason = $2 where id = $1`,
      [input.payment, input.reason],
    )
    await emitRegister(tx, p, {
      kind: 'money.payment_authorised',
      subjectType: 'money_payment',
      subject: input.payment,
      matter: pay.rows[0].matter as number,
      privileged: true,
      reason: input.reason,
      detail: { before: { state: 'pending_authorisation' }, after: { state: 'rejected' } },
    })
  })
}

/** Cancel a draft or blocked payment. */
export async function cancelMoneyPayment(
  p: Principal,
  input: { payment: number; reason?: string },
): Promise<void> {
  requireStaff(p)
  await withPrincipal(p, async (tx) => {
    const pay = await tx.query(
      `select mp.id, mp.state, ml.matter
         from deedbox.money_payment mp join deedbox.matter_ledger ml on ml.id = mp.matter_ledger
        where mp.id = $1 for update of mp`,
      [input.payment],
    )
    if (pay.rowCount === 0) throw new OperationRefused('not_found', 'payment not found')
    const from = pay.rows[0].state as string
    if (from !== 'draft' && from !== 'pending_authorisation' && from !== 'blocked') {
      throw new OperationRefused('wrong_state', `a ${from} payment cannot cancel`)
    }
    await tx.query(`update deedbox.money_payment set state = 'cancelled' where id = $1`, [
      input.payment,
    ])
    await emitRegister(tx, p, {
      kind: 'record.changed',
      subjectType: 'money_payment',
      subject: input.payment,
      matter: pay.rows[0].matter as number,
      reason: input.reason,
      detail: { before: { state: from }, after: { state: 'cancelled' } },
    })
  })
}

/** The pack method catalogue's instrument flag. */
async function methodInstrumentBacked(tx: Tx, firm: number, method: string): Promise<boolean> {
  const r = await tx.query(
    `select d.body from deedbox.pack_declaration d
       join deedbox.firm f on f.id = $1
       join deedbox.country_pack cp on cp.id = f.country_pack
       join deedbox.pack_version v on v.id = d.pack_version and v.id = cp.active_version
      where d.rule_point = 'money.payment_methods'`,
    [firm],
  )
  for (const row of r.rows) {
    const b = row.body as { methods?: { key: string; instrument_backed?: boolean }[] }
    for (const m of b.methods ?? []) {
      if (m.key === method) return m.instrument_backed ?? false
    }
  }
  return method === 'cheque' // the neutral default
}

export interface ExecutableDoc {
  id: number
  amount: string
  method: string
  purpose: string
  earmark: number | null
  entitlement: number | null
  dormant_case: number | null
  matter_ledger: number
  account: number
  matter: number
  first_authorisation: number
}

/** The read-only pre-read every execution path shares. */
export async function loadExecutableDoc(p: Principal, paymentId: number): Promise<ExecutableDoc> {
  return withPrincipal(
    p,
    async (tx) => {
      const pay = await tx.query(
        `select mp.id, mp.state, mp.amount, mp.method, mp.purpose, mp.earmark, mp.entitlement,
                mp.dormant_case, mp.matter_ledger, ml.account, ml.matter,
                (select a.id from deedbox.payment_authorisation a
                  where a.subject_type = 'money_payment' and a.subject = mp.id
                    and a.decision = 'approved'
                  order by a.id limit 1) as first_authorisation
           from deedbox.money_payment mp
           join deedbox.matter_ledger ml on ml.id = mp.matter_ledger
          where mp.id = $1`,
        [paymentId],
      )
      if (pay.rowCount === 0) throw new OperationRefused('not_found', 'payment not found')
      if (pay.rows[0].state !== 'authorised') {
        throw new OperationRefused('not_authorised', `a ${pay.rows[0].state} payment cannot execute`)
      }
      return pay.rows[0] as ExecutableDoc
    },
    { readOnly: true },
  )
}

/**
 * Execute an authorised payment: one transaction through the
 * posting protocol. On refusal the capture protocol records the typed
 * reason and the payment BLOCKS in a follow-up committed transaction.
 */
export async function executeMoneyPayment(
  p: Principal,
  input: { payment: number; instrumentNumber?: string; externalReference?: string },
): Promise<{ transaction: number; paymentNumber: string }> {
  requireStaff(p)
  // a transfer prepared for a specific bill executes through the held-funds
  // bridge, never here — this door would move the money and leave the bill
  // unpaid (the two-door seam, first live invoicing day). The payments
  // screen routes such payments to the bridge on this refusal.
  const bridged = await withPrincipal(
    p,
    (tx) =>
      tx.query(
        `select 1 from deedbox.funds_application
          where money_payment = $1 and item_state = 'awaiting_authorisation'`,
        [input.payment],
      ),
    { readOnly: true },
  )
  if (bridged.rowCount! > 0) {
    throw new OperationRefused(
      'held_funds_item',
      'this transfer pays a specific bill through the held-funds bridge — executing it alone would move the money without paying the bill',
    )
  }
  const doc = await loadExecutableDoc(p, input.payment)
  try {
    return await runMoneyOperation(
      p,
      { account: doc.account, matterLedger: doc.matter_ledger, operation: 'execute_payment' },
      (tx) => executePaymentCoreInTx(tx, p, doc, input.instrumentNumber, input.externalReference),
    )
  } catch (e) {
    if (e instanceof MoneyRefusal) {
      // the execution failure shape: block in a follow-up committed transaction
      await withPrincipal(p, async (tx) => {
        await tx.query(
          `update deedbox.money_payment set state = 'blocked' where id = $1 and state = 'authorised'`,
          [input.payment],
        )
        await emitRegister(tx, p, {
          kind: 'record.changed',
          subjectType: 'money_payment',
          subject: input.payment,
          matter: doc.matter,
          detail: { before: { state: 'authorised' }, after: { state: 'blocked' }, refusal: e.refusalId },
        })
      })
    }
    throw e
  }
}

/**
 * The execution body, callable inside a caller-owned money transaction — the
 * remittance ceremony and the cross-account transfer ride
 * these exact semantics with their own additional writes.
 */
export async function executePaymentCoreInTx(
  tx: Tx,
  p: Principal,
  doc: ExecutableDoc,
  instrumentNumber?: string,
  /** The bank's own reference for the transfer (0050) — written with the execution, immutable after. */
  externalReference?: string,
): Promise<{ transaction: number; paymentNumber: string }> {
  {
    {
      {
        await requireCapability(tx, p, 'money.record_payment')
        await tx.query(`select id from deedbox.matter_ledger where id = $1 for update`, [
          doc.matter_ledger,
        ])
        const amount = Number(doc.amount)
        const txnKind =
          doc.purpose === 'firm_transfer'
            ? 'firm_transfer'
            : doc.purpose === 'remittance'
              ? 'remittance'
              : 'payment_out'
        const payNum = await tx.query(`select deedbox.allocate_number('money_payment') as n`)
        const txn = await tx.query(
          `select deedbox.post_money_transaction(
             $6, current_date, $1, 'money_payment', $2,
             jsonb_build_array(
               jsonb_build_object('side','cash_book','account',$3::bigint,'signed_amount',-($5::numeric)),
               jsonb_build_object('side','matter_ledger','account',$3::bigint,'matter_ledger',$4::bigint,'signed_amount',-($5::numeric))
             ), (select reason from deedbox.money_payment where id = $2), $7) as t`,
          [p.id, doc.id, doc.account, doc.matter_ledger, amount, txnKind, doc.first_authorisation],
        )
        await tx.query(
          `update deedbox.money_payment
              set state = 'executed', transaction = $2, payment_number = $3,
                  external_reference = coalesce($4, external_reference)
            where id = $1`,
          [doc.id, txn.rows[0].t, payNum.rows[0].n, externalReference?.trim() || null],
        )
        // earmark consumption and the residual re-earmark happen IN THE
        // SCHEMA (the after-update trigger on the executed transition) —
        // the operations layer never re-implements enforcement the schema
        // performs; the register entry below carries the earmark's part
        if (await methodInstrumentBacked(tx, p.firm, doc.method)) {
          await tx.query(
            `insert into deedbox.instrument
               (account, direction, instrument_kind, number, amount, state, source_type, source,
                transaction, stale_after)
             values ($1, 'outbound', $2, $3, $4, 'created', 'money_payment', $5, $6,
                     current_date + 180)`,
            [
              doc.account,
              doc.method,
              instrumentNumber ?? (payNum.rows[0].n as string),
              amount,
              doc.id,
              txn.rows[0].t,
            ],
          )
        }
        await emitRegister(tx, p, {
          kind: 'money.transaction_posted',
          subjectType: 'money_transaction',
          subject: txn.rows[0].t as number,
          matter: doc.matter,
          detail: {
            kind: txnKind,
            amount,
            payment_number: payNum.rows[0].n,
            earmark_consumed: doc.earmark,
          },
        })
        return { transaction: txn.rows[0].t as number, paymentNumber: payNum.rows[0].n as string }
      }
    }
  }
}

/** Resubmit a blocked payment: back to authorised, then executed. */
export async function resubmitBlockedPayment(
  p: Principal,
  input: { payment: number; instrumentNumber?: string; externalReference?: string },
): Promise<{ transaction: number; paymentNumber: string }> {
  requireStaff(p)
  await withPrincipal(p, async (tx) => {
    const pay = await tx.query(
      `select mp.state, ml.matter from deedbox.money_payment mp
        join deedbox.matter_ledger ml on ml.id = mp.matter_ledger
       where mp.id = $1 for update of mp`,
      [input.payment],
    )
    if (pay.rowCount === 0) throw new OperationRefused('not_found', 'payment not found')
    if (pay.rows[0].state !== 'blocked') {
      throw new OperationRefused('not_blocked', `a ${pay.rows[0].state} payment cannot resubmit`)
    }
    await tx.query(`update deedbox.money_payment set state = 'authorised' where id = $1`, [
      input.payment,
    ])
    await emitRegister(tx, p, {
      kind: 'record.changed',
      subjectType: 'money_payment',
      subject: input.payment,
      matter: pay.rows[0].matter as number,
      detail: { before: { state: 'blocked' }, after: { state: 'authorised' } },
    })
  })
  return executeMoneyPayment(p, input)
}
