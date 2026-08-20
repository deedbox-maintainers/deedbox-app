// Ledger transfers (same account), cross-account transfers, earmarks, and
// entitlements. A same-account transfer is two ledger lines netting to
// zero, no cash-book line, one gapless T- number, one approved
// authorisation (subject_type ledger_transfer). A cross-account transfer
// is an intent row linking one payment-out and one receipt — two real
// balanced postings in ONE database transaction, so the intent can never
// half-exist. Earmark placement and payment execution contend on the same
// ledger lock, so the last-cent race resolves deterministically;
// entitlement establishment moves no money and validates its basis
// structurally.

import type { Principal, Tx } from '@/lib/db'
import {
  withPrincipal,
  emitRegister,
  OperationRefused,
  runMoneyOperation,
} from '@/lib/db'
import { requireStaff, requireCapability, settingBool } from '@/lib/ops/shared'
import { createHash } from 'node:crypto'

function cents(x: number | string): number {
  return Math.round(Number(x) * 100)
}

/**
 * Money authorisation applied to a transfer intent: an authoriser (never the eventual
 * executor) approves the stated movement before it exists as a row — the
 * authorisation's subject is the source ledger, its note the intent, and
 * the transfer operation verifies both plus the separation at execution.
 */
export async function authoriseTransferIntent(
  p: Principal,
  input: { fromLedger: number; toLedger: number; amount: number; reason: string },
): Promise<{ authorisation: number }> {
  requireStaff(p)
  return withPrincipal(p, async (tx) => {
    await requireCapability(tx, p, 'money.authorise_payment')
    const r = await tx.query(
      `insert into deedbox.payment_authorisation (subject_type, subject, authoriser, decision, note)
       values ('ledger_transfer', $1, $2, 'approved', $3) returning id`,
      [
        input.fromLedger,
        p.id,
        `transfer ${input.amount.toFixed(2)} from ledger ${input.fromLedger} to ${input.toLedger}: ${input.reason}`,
      ],
    )
    const matter = await tx.query(`select matter from deedbox.matter_ledger where id = $1`, [
      input.fromLedger,
    ])
    await emitRegister(tx, p, {
      kind: 'money.payment_authorised',
      subjectType: 'ledger_transfer_intent',
      subject: input.fromLedger,
      matter: matter.rowCount! > 0 ? (matter.rows[0].matter as number) : undefined,
      privileged: true,
      detail: {
        before: { authorised: false },
        after: { authorised: true, to_ledger: input.toLedger, amount: input.amount },
      },
    })
    return { authorisation: r.rows[0].id as number }
  })
}

/**
 * Transfer between two ledgers of one account. The caller
 * supplies the approved authorisation from authoriseTransferIntent; the
 * authoriser and the executor are different people.
 */
export async function ledgerTransfer(
  p: Principal,
  input: {
    fromLedger: number
    toLedger: number
    amount: number
    reason: string
    authorisation: number
  },
): Promise<{ transfer: number; transferNumber: string; transaction: number }> {
  requireStaff(p)
  if (!(input.amount > 0)) throw new OperationRefused('bad_amount', 'a transfer is above zero')
  if (!input.reason.trim()) throw new OperationRefused('reason_required', 'a transfer carries its reason')
  if (input.fromLedger === input.toLedger) {
    throw new OperationRefused('same_ledger', 'a transfer joins two different ledgers')
  }
  const ledgers = await withPrincipal(
    p,
    async (tx) => {
      const r = await tx.query(
        `select id, account, matter, status, ledger_kind from deedbox.matter_ledger
          where id = any($1) order by id`,
        [[input.fromLedger, input.toLedger]],
      )
      if (r.rowCount !== 2) throw new OperationRefused('not_found', 'both ledgers must exist')
      for (const l of r.rows) {
        if (l.status !== 'open') throw new OperationRefused('ledger_closed', `ledger ${l.id} is closed`)
        if (l.ledger_kind !== 'client_matter') {
          throw new OperationRefused('wrong_kind', 'transfers join client-matter ledgers')
        }
      }
      if (r.rows[0].account !== r.rows[1].account) {
        throw new OperationRefused('cross_account', 'different accounts need the cross-account transfer')
      }
      return r.rows as { id: number; account: number; matter: number }[]
    },
    { readOnly: true },
  )
  const account = ledgers[0].account
  return runMoneyOperation(
    p,
    { account, matterLedger: input.fromLedger, operation: 'ledger_transfer' },
    async (tx) => {
      await requireCapability(tx, p, 'money.record_payment')
      const auth = await tx.query(
        `select authoriser, decision, subject_type, subject from deedbox.payment_authorisation
          where id = $1`,
        [input.authorisation],
      )
      if (
        auth.rowCount === 0 ||
        auth.rows[0].decision !== 'approved' ||
        auth.rows[0].subject_type !== 'ledger_transfer' ||
        auth.rows[0].subject !== input.fromLedger
      ) {
        throw new OperationRefused(
          'authorisation_missing',
          'the transfer needs an approved authorisation on this source ledger',
        )
      }
      if (auth.rows[0].authoriser === p.id && !(await settingBool(tx, 'money.self_authorisation'))) {
        throw new OperationRefused('separation', 'the authoriser never executes their own approval')
      }
      const num = await tx.query(`select deedbox.allocate_number('ledger_transfer') as n`)
      const transferSeq = Number((num.rows[0].n as string).replace(/^\D+/, ''))
      const txn = await tx.query(
        `select deedbox.post_money_transaction(
           'ledger_transfer', current_date, $1, 'ledger_transfer_number', $2,
           jsonb_build_array(
             jsonb_build_object('side','matter_ledger','account',$3::bigint,'matter_ledger',$4::bigint,'signed_amount',-($6::numeric)),
             jsonb_build_object('side','matter_ledger','account',$3::bigint,'matter_ledger',$5::bigint,'signed_amount',$6::numeric)
           ), $7, $8) as t`,
        [
          p.id,
          transferSeq,
          account,
          input.fromLedger,
          input.toLedger,
          input.amount,
          input.reason,
          input.authorisation,
        ],
      )
      const transfer = await tx.query(
        `insert into deedbox.ledger_transfer
           (transfer_number, from_ledger, to_ledger, amount, reason, authorisation, transaction)
         values ($1, $2, $3, $4, $5, $6, $7) returning id`,
        [
          num.rows[0].n,
          input.fromLedger,
          input.toLedger,
          input.amount,
          input.reason,
          input.authorisation,
          txn.rows[0].t,
        ],
      )
      const fromMatter = ledgers.find((l) => l.id === input.fromLedger)!.matter
      await emitRegister(tx, p, {
        kind: 'money.transaction_posted',
        subjectType: 'money_transaction',
        subject: txn.rows[0].t as number,
        matter: fromMatter,
        reason: input.reason,
        detail: {
          kind: 'ledger_transfer',
          transfer_number: num.rows[0].n,
          from_ledger: input.fromLedger,
          to_ledger: input.toLedger,
          amount: input.amount,
        },
      })
      return {
        transfer: transfer.rows[0].id as number,
        transferNumber: num.rows[0].n as string,
        transaction: txn.rows[0].t as number,
      }
    },
  )
}

/** Place an earmark; over-placement is refused with the arithmetic. */
export async function placeEarmark(
  p: Principal,
  input: { matterLedger: number; amount: number; purpose: string },
): Promise<{ id: number }> {
  requireStaff(p)
  if (!(input.amount > 0)) throw new OperationRefused('bad_amount', 'an earmark is above zero')
  if (!input.purpose.trim()) throw new OperationRefused('purpose_required', 'an earmark carries its purpose')
  const home = await withPrincipal(
    p,
    async (tx) => {
      const r = await tx.query(
        `select id, account, matter, status from deedbox.matter_ledger where id = $1`,
        [input.matterLedger],
      )
      if (r.rowCount === 0) throw new OperationRefused('not_found', 'ledger not found')
      if (r.rows[0].status !== 'open') throw new OperationRefused('ledger_closed', 'the ledger is closed')
      return r.rows[0] as { account: number; matter: number }
    },
    { readOnly: true },
  )
  return runMoneyOperation(
    p,
    { account: home.account, matterLedger: input.matterLedger, operation: 'place_earmark' },
    async (tx) => {
      await requireCapability(tx, p, 'money.manage_earmarks')
      // the ledger lock: placement and payment execution contend here
      await tx.query(`select id from deedbox.matter_ledger where id = $1 for update`, [
        input.matterLedger,
      ])
      const check = await tx.query(
        `select deedbox.ledger_balance($1) as balance,
                deedbox.ledger_active_earmarks($1) as marked`,
        [input.matterLedger],
      )
      const balance = cents(check.rows[0].balance)
      const marked = cents(check.rows[0].marked)
      if (marked + cents(input.amount) > balance) {
        throw new OperationRefused(
          'earmark_shortfall',
          `earmarks would reach ${((marked + cents(input.amount)) / 100).toFixed(2)} against a balance of ${(balance / 100).toFixed(2)}`,
        )
      }
      const r = await tx.query(
        `insert into deedbox.earmark (matter_ledger, amount, purpose, placed_by)
         values ($1, $2, $3, $4) returning id`,
        [input.matterLedger, input.amount, input.purpose, p.id],
      )
      await emitRegister(tx, p, {
        kind: 'record.created',
        subjectType: 'earmark',
        subject: r.rows[0].id as number,
        matter: home.matter,
        detail: { amount: input.amount, purpose: input.purpose },
      })
      return { id: r.rows[0].id as number }
    },
  )
}

/** Release an active earmark, reason captured. */
export async function releaseEarmark(
  p: Principal,
  input: { earmark: number; reason: string; amount?: number },
): Promise<{ remainderEarmark: number | null }> {
  requireStaff(p)
  if (!input.reason.trim()) throw new OperationRefused('reason_required', 'a release carries its reason')
  if (input.amount !== undefined && !(input.amount > 0)) {
    throw new OperationRefused('bad_amount', 'a partial release is above zero')
  }
  return withPrincipal(p, async (tx) => {
    await requireCapability(tx, p, 'money.manage_earmarks')
    const cur = await tx.query(
      `select matter_ledger, amount, purpose from deedbox.earmark
        where id = $1 and state = 'active' for update`,
      [input.earmark],
    )
    if (cur.rowCount === 0) throw new OperationRefused('not_active', 'no active earmark by that id')
    const held = Math.round(Number(cur.rows[0].amount) * 100)
    const releasing = input.amount === undefined ? held : Math.round(input.amount * 100)
    if (releasing > held) {
      throw new OperationRefused(
        'exceeds_earmark',
        `the set-aside holds $${(held / 100).toFixed(2)} — $${(releasing / 100).toFixed(2)} cannot be released`,
      )
    }
    // earmark rows are immutable in amount: a partial release closes the
    // entry and re-places the remainder as a fresh active entry in the SAME
    // transaction — the money is never unprotected in between, and the
    // register shows exactly what was released and what still stands (the
    // residual-re-earmark pattern consumption already uses)
    await tx.query(
      `update deedbox.earmark set state = 'released', released_by = $2, released_at = now()
        where id = $1`,
      [input.earmark, p.id],
    )
    let remainder: number | null = null
    if (releasing < held) {
      const re = await tx.query(
        `insert into deedbox.earmark (matter_ledger, amount, purpose, placed_by)
         values ($1, $2, $3, $4) returning id`,
        [cur.rows[0].matter_ledger, (held - releasing) / 100, cur.rows[0].purpose, p.id],
      )
      remainder = re.rows[0].id as number
    }
    const matter = await tx.query(
      `select matter from deedbox.matter_ledger where id = $1`,
      [cur.rows[0].matter_ledger],
    )
    await emitRegister(tx, p, {
      kind: 'record.changed',
      subjectType: 'earmark',
      subject: input.earmark,
      matter: matter.rows[0].matter as number,
      reason: input.reason,
      detail: {
        released: true,
        amount: releasing / 100,
        remainder: remainder === null ? null : { earmark: remainder, amount: (held - releasing) / 100 },
      },
    })
    return { remainderEarmark: remainder }
  })
}

/** Establish an entitlement; no money moves. */
export async function establishEntitlement(
  p: Principal,
  input: {
    matterLedger: number
    amount: number
    basisKind: 'rendered_bill' | 'pack_defined'
    bill?: number
    packBasis?: string
    packBasisEvidence?: unknown
    noticeRequired?: boolean
  },
): Promise<{ id: number; status: string }> {
  requireStaff(p)
  if (!(input.amount > 0)) throw new OperationRefused('bad_amount', 'an entitlement is above zero')
  return withPrincipal(p, async (tx) => {
    await requireCapability(tx, p, 'money.manage_entitlements')
    const r = await tx.query(
      `insert into deedbox.entitlement
         (matter_ledger, basis_kind, bill, pack_basis, pack_basis_evidence, amount, notice_required)
       values ($1, $2, $3, $4, $5, $6, $7) returning id`,
      [
        input.matterLedger,
        input.basisKind,
        input.bill ?? null,
        input.packBasis ?? null,
        input.packBasisEvidence === undefined ? null : JSON.stringify(input.packBasisEvidence),
        input.amount,
        input.noticeRequired ?? false,
      ],
    )
    const status = await tx.query(`select deedbox.entitlement_status($1) as s`, [r.rows[0].id])
    const matter = await tx.query(
      `select matter from deedbox.matter_ledger where id = $1`,
      [input.matterLedger],
    )
    await emitRegister(tx, p, {
      kind: 'record.created',
      subjectType: 'entitlement',
      subject: r.rows[0].id as number,
      matter: matter.rows[0].matter as number,
      detail: {
        basis_kind: input.basisKind,
        bill: input.bill ?? null,
        amount: input.amount,
        notice_required: input.noticeRequired ?? false,
      },
    })
    return { id: r.rows[0].id as number, status: status.rows[0].s as string }
  })
}

/** Record the notice event; actionable_from computes from the pack period. */
export async function recordEntitlementNotice(
  p: Principal,
  input: { entitlement: number; noticeEventType: string; noticeEvent: number },
): Promise<{ actionableFrom: string }> {
  requireStaff(p)
  return withPrincipal(p, async (tx) => {
    await requireCapability(tx, p, 'money.manage_entitlements')
    const ent = await tx.query(
      `select e.id, e.notice_required, e.notice_given_at, e.cancelled_at, ml.matter
         from deedbox.entitlement e join deedbox.matter_ledger ml on ml.id = e.matter_ledger
        where e.id = $1 for update of e`,
      [input.entitlement],
    )
    if (ent.rowCount === 0) throw new OperationRefused('not_found', 'entitlement not found')
    if (ent.rows[0].cancelled_at !== null) {
      throw new OperationRefused('cancelled', 'a cancelled entitlement takes no notice')
    }
    if (!ent.rows[0].notice_required) {
      throw new OperationRefused('no_notice_needed', 'this entitlement requires no notice')
    }
    if (ent.rows[0].notice_given_at !== null) {
      throw new OperationRefused('already_noticed', 'the notice is already recorded')
    }
    const decl = await tx.query(
      `select d.body from deedbox.pack_declaration d
         join deedbox.firm f on f.id = $1
         join deedbox.country_pack cp on cp.id = f.country_pack
         join deedbox.pack_version v on v.id = d.pack_version and v.id = cp.active_version
        where d.rule_point = 'money.entitlement_bases'`,
      [p.firm],
    )
    let noticeDays = 0
    for (const row of decl.rows) {
      const b = row.body as { notice_days?: number }
      if (b.notice_days !== undefined) noticeDays = b.notice_days
    }
    const r = await tx.query(
      `update deedbox.entitlement
          set notice_given_at = now(), notice_event_type = $2, notice_event = $3,
              actionable_from = now() + make_interval(days => $4::int)
        where id = $1
        returning actionable_from::text as af`,
      [input.entitlement, input.noticeEventType, input.noticeEvent, noticeDays],
    )
    await emitRegister(tx, p, {
      kind: 'record.changed',
      subjectType: 'entitlement',
      subject: input.entitlement,
      matter: ent.rows[0].matter as number,
      detail: {
        notice_event_type: input.noticeEventType,
        notice_event: input.noticeEvent,
        actionable_from: r.rows[0].af,
      },
    })
    return { actionableFrom: r.rows[0].af as string }
  })
}

/** Cancel an unconsumed entitlement. */
export async function cancelEntitlement(
  p: Principal,
  input: { entitlement: number; reason: string },
): Promise<void> {
  requireStaff(p)
  if (!input.reason.trim()) throw new OperationRefused('reason_required', 'a cancellation carries its reason')
  await withPrincipal(p, async (tx) => {
    await requireCapability(tx, p, 'money.manage_entitlements')
    const consumed = await tx.query(`select deedbox.entitlement_consumed($1) as c`, [
      input.entitlement,
    ])
    if (cents(consumed.rows[0].c) > 0) {
      throw new OperationRefused('consumed', 'a drawn-on entitlement never cancels')
    }
    const r = await tx.query(
      `update deedbox.entitlement set cancelled_at = now(), cancelled_by = $2
        where id = $1 and cancelled_at is null
        returning matter_ledger`,
      [input.entitlement, p.id],
    )
    if (r.rowCount === 0) throw new OperationRefused('not_found', 'no uncancelled entitlement by that id')
    const matter = await tx.query(
      `select matter from deedbox.matter_ledger where id = $1`,
      [r.rows[0].matter_ledger],
    )
    await emitRegister(tx, p, {
      kind: 'record.changed',
      subjectType: 'entitlement',
      subject: input.entitlement,
      matter: matter.rows[0].matter as number,
      reason: input.reason,
      detail: { cancelled: true },
    })
  })
}

/**
 * Cross-account transfer: ONE database transaction holding two
 * real balanced postings — the payment out of the source ledger and the
 * receipt into the destination — with the cross_account_transfer intent row linking them, so
 * the intent can never half-exist. One authorisation governs: the intent
 * approval from authoriseTransferIntent, materialised onto the payment
 * document as its counted approval (the approver saw this exact movement;
 * the note records the materialisation), and the executor is never the
 * authoriser. Numbers flow from the shared transfer stream plus the
 * payment/receipt streams, counters in purpose-enum order.
 */
export async function crossAccountTransfer(
  p: Principal,
  input: {
    fromLedger: number
    toLedger: number
    amount: number
    reason: string
    authorisation: number
  },
): Promise<{ transferNumber: string; payment: number; receipt: number }> {
  requireStaff(p)
  if (!(input.amount > 0)) throw new OperationRefused('bad_amount', 'a transfer is above zero')
  if (!input.reason.trim()) throw new OperationRefused('reason_required', 'a transfer carries its reason')
  const ledgers = await withPrincipal(
    p,
    async (tx) => {
      const r = await tx.query(
        `select ml.id, ml.account, ml.matter, ml.status, ml.ledger_kind
           from deedbox.matter_ledger ml
          where ml.id = any($1)`,
        [[input.fromLedger, input.toLedger]],
      )
      if (r.rowCount !== 2) throw new OperationRefused('not_found', 'both ledgers must exist')
      const from = r.rows.find((x) => x.id === input.fromLedger)!
      const to = r.rows.find((x) => x.id === input.toLedger)!
      for (const l of [from, to]) {
        if (l.status !== 'open') throw new OperationRefused('ledger_closed', `ledger ${l.id} is closed`)
        if (l.ledger_kind !== 'client_matter') {
          throw new OperationRefused('wrong_kind', 'transfers join client-matter ledgers')
        }
      }
      if (from.account === to.account) {
        throw new OperationRefused('same_account', 'same-account movements use the ledger transfer')
      }
      return { from, to }
    },
    { readOnly: true },
  )
  return runMoneyOperation(
    p,
    {
      account: ledgers.from.account as number,
      matterLedger: input.fromLedger,
      operation: 'cross_account_transfer',
    },
    async (tx) => {
      await requireCapability(tx, p, 'money.record_payment')
      const auth = await tx.query(
        `select authoriser, decision, subject_type, subject from deedbox.payment_authorisation
          where id = $1`,
        [input.authorisation],
      )
      if (
        auth.rowCount === 0 ||
        auth.rows[0].decision !== 'approved' ||
        auth.rows[0].subject_type !== 'ledger_transfer' ||
        auth.rows[0].subject !== input.fromLedger
      ) {
        throw new OperationRefused(
          'authorisation_missing',
          'the transfer needs an approved intent authorisation on this source ledger',
        )
      }
      if (auth.rows[0].authoriser === p.id && !(await settingBool(tx, 'money.self_authorisation'))) {
        throw new OperationRefused('separation', 'the authoriser never executes their own approval')
      }
      // ledger locks ascending across both accounts
      await tx.query(
        `select id from deedbox.matter_ledger where id = any($1) order by id for update`,
        [[input.fromLedger, input.toLedger]],
      )
      // the payment document, its intent approval materialised, then executed
      const pay = await tx.query(
        `insert into deedbox.money_payment
           (matter_ledger, payee_description, method, amount, reason, requested_by, purpose)
         values ($1, 'cross-account transfer to the destination client account',
                 'electronic_transfer', $2, $3, $4, 'cross_account_transfer')
         returning id`,
        [input.fromLedger, input.amount, input.reason, p.id],
      )
      await tx.query(
        `update deedbox.money_payment
            set state = 'pending_authorisation', required_authorisations = 1
          where id = $1`,
        [pay.rows[0].id],
      )
      await tx.query(
        `insert into deedbox.payment_authorisation (subject_type, subject, authoriser, decision, note)
         values ('money_payment', $1, $2, 'approved', $3)`,
        [
          pay.rows[0].id,
          auth.rows[0].authoriser,
          `materialised from intent authorisation ${input.authorisation}`,
        ],
      )
      await tx.query(`update deedbox.money_payment set state = 'authorised' where id = $1`, [
        pay.rows[0].id,
      ])
      const num = await tx.query(`select deedbox.allocate_number('ledger_transfer') as n`)
      const payNum = await tx.query(`select deedbox.allocate_number('money_payment') as n`)
      const payTxn = await tx.query(
        `select deedbox.post_money_transaction(
           'payment_out', current_date, $1, 'money_payment', $2,
           jsonb_build_array(
             jsonb_build_object('side','cash_book','account',$3::bigint,'signed_amount',-($5::numeric)),
             jsonb_build_object('side','matter_ledger','account',$3::bigint,'matter_ledger',$4::bigint,'signed_amount',-($5::numeric))
           ), $6, $7) as t`,
        [
          p.id,
          pay.rows[0].id,
          ledgers.from.account,
          input.fromLedger,
          input.amount,
          input.reason,
          input.authorisation,
        ],
      )
      await tx.query(
        `update deedbox.money_payment
            set state = 'executed', transaction = $2, payment_number = $3
          where id = $1`,
        [pay.rows[0].id, payTxn.rows[0].t, payNum.rows[0].n],
      )
      // the receipt into the destination, the same shape as an ordinary receipt
      const rNum = await tx.query(`select deedbox.allocate_number('money_receipt') as n`)
      const receiptSeq = Number((rNum.rows[0].n as string).replace(/^\D+/, ''))
      const rTxn = await tx.query(
        `select deedbox.post_money_transaction(
           'receipt', current_date, $1, 'money_receipt_number', $2,
           jsonb_build_array(
             jsonb_build_object('side','cash_book','account',$3::bigint,'signed_amount',$5::numeric),
             jsonb_build_object('side','matter_ledger','account',$3::bigint,'matter_ledger',$4::bigint,'signed_amount',$5::numeric)
           )) as t`,
        [p.id, receiptSeq, ledgers.to.account, input.toLedger, input.amount],
      )
      const rendering = JSON.stringify({
        document: 'money_receipt',
        receipt_number: rNum.rows[0].n,
        amount: input.amount,
        method: 'electronic_transfer',
        cross_account_transfer: num.rows[0].n,
      })
      const artefact = await tx.query(
        `insert into deedbox.stored_artefact (kind, content_ref, content_hash, content_type, size_bytes)
         values ('money_receipt_rendering', $1, $2, 'application/json', $3) returning id`,
        [rendering, createHash('sha256').update(rendering).digest('hex'), Buffer.byteLength(rendering)],
      )
      const receipt = await tx.query(
        `insert into deedbox.money_receipt
           (matter_ledger, receipt_number, payer_description, method, received_date, amount,
            transaction, printable_artefact)
         values ($1, $2, 'cross-account transfer from the source client account',
                 'electronic_transfer', current_date, $3, $4, $5)
         returning id`,
        [input.toLedger, rNum.rows[0].n, input.amount, rTxn.rows[0].t, String(artefact.rows[0].id)],
      )
      await tx.query(
        `insert into deedbox.cross_account_transfer
           (reason, authorisation, payment, receipt, transfer_number)
         values ($1, $2, $3, $4, $5)`,
        [input.reason, input.authorisation, pay.rows[0].id, receipt.rows[0].id, num.rows[0].n],
      )
      await emitRegister(tx, p, {
        kind: 'money.transaction_posted',
        subjectType: 'money_transaction',
        subject: payTxn.rows[0].t as number,
        matter: ledgers.from.matter as number,
        reason: input.reason,
        detail: { kind: 'payment_out', cross_account_transfer: num.rows[0].n, amount: input.amount },
      })
      await emitRegister(tx, p, {
        kind: 'money.transaction_posted',
        subjectType: 'money_transaction',
        subject: rTxn.rows[0].t as number,
        matter: ledgers.to.matter as number,
        detail: { kind: 'receipt', cross_account_transfer: num.rows[0].n, amount: input.amount },
      })
      return {
        transferNumber: num.rows[0].n as string,
        payment: pay.rows[0].id as number,
        receipt: receipt.rows[0].id as number,
      }
    },
  )
}
