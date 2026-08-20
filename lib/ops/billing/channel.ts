// Channel events. Started and failed rows touch no figure anywhere;
// settlement is ONE database transaction that creates the receipt on the
// side the routing seam directs, so money never half-lands. Idempotency is
// structural: the (channel, channel_event_ref) uniqueness keys the payment
// row, replays return the stored outcome, and the payment_reference row lock
// is the double-settlement guard.
//
// The routing seam: the pack declaration `channel.destination` names,
// per target kind, office | client_money | firm_setting; the firm setting
// `channel.bill_destination` (shipped office) is read only where the pack
// names firm_setting or is silent; top-up targets are engine-fixed to
// client money.
//
// Implementation notes: channel principals are integration_key (or
// system_job for the stored-method collection loop), mirroring the
// activity-signal interface; the client-money posting's source is the
// CHANNEL PAYMENT row (source_type 'channel_payment') — provenance is the
// settlement event itself, and the receipt document points at the posted
// transaction; a client-money route requires the matter to hold exactly one
// open client ledger, refusing the settlement whole otherwise (fail-closed —
// the verbatim event is retained for retry); the surcharge rule's body is
// {method, pct} per declaration, evidence only, never entering the receipt.

import type { Principal, Tx } from '@/lib/db'
import { withPrincipal, emitRegister, OperationRefused } from '@/lib/db'
import { allocateInTx } from './payments'
import { statementSplitsInTx } from './statements'
import { applyInstalmentCoverageInTx } from './arrangements'
import { satisfyTopUpInTx } from './topups'
import { createHash } from 'node:crypto'

function requireChannelPrincipal(p: Principal): void {
  if (p.kind !== 'integration_key' && p.kind !== 'system_job') {
    throw new OperationRefused('channel_only', 'channel events arrive through channel principals')
  }
}

/** A channel reports a payment started. Idempotent by event ref. */
export async function startChannelPayment(
  p: Principal,
  input: {
    channel: string
    channelEventRef: string
    referenceCode: string
    method: string
    amount: number
    verbatim?: unknown
  },
): Promise<{ id: number; replay: boolean }> {
  requireChannelPrincipal(p)
  if (!(input.amount > 0)) throw new OperationRefused('bad_amount', 'a channel payment is above zero')
  return withPrincipal(p, async (tx) => {
    const replay = await tx.query(
      `select id from deedbox.channel_payment where channel = $1 and channel_event_ref = $2`,
      [input.channel, input.channelEventRef],
    )
    if (replay.rowCount! > 0) return { id: replay.rows[0].id as number, replay: true }
    const ref = await tx.query(
      `select id, active, expected_amount from deedbox.payment_reference where code = $1`,
      [input.referenceCode],
    )
    if (ref.rowCount === 0) throw new OperationRefused('reference_unknown', 'no payment reference by that code')
    if (!ref.rows[0].active) {
      throw new OperationRefused('reference_inactive', 'the payment reference is no longer active')
    }
    const history = [
      {
        event: 'started',
        event_ref: input.channelEventRef,
        amount: input.amount,
        expected_amount: ref.rows[0].expected_amount === null ? null : Number(ref.rows[0].expected_amount),
        verbatim: input.verbatim ?? null,
      },
    ]
    const r = await tx.query(
      `insert into deedbox.channel_payment
         (payment_reference, channel, method, amount, state_history, channel_event_ref)
       values ($1, $2, $3, $4, $5, $6) returning id`,
      [
        ref.rows[0].id,
        input.channel,
        input.method,
        input.amount,
        JSON.stringify(history),
        input.channelEventRef,
      ],
    )
    await emitRegister(tx, p, {
      kind: 'record.created',
      subjectType: 'channel_payment',
      subject: r.rows[0].id as number,
      detail: { channel: input.channel, amount: input.amount },
    })
    return { id: r.rows[0].id as number, replay: false }
  })
}

/** A channel reports failure: single transition, nothing else. */
export async function failChannelPayment(
  p: Principal,
  input: { channel: string; channelEventRef: string; failureEventRef?: string; verbatim?: unknown },
): Promise<{ id: number; replay: boolean }> {
  requireChannelPrincipal(p)
  return withPrincipal(p, async (tx) => {
    const cp = await tx.query(
      `select id, state, state_history from deedbox.channel_payment
        where channel = $1 and channel_event_ref = $2 for update`,
      [input.channel, input.channelEventRef],
    )
    if (cp.rowCount === 0) throw new OperationRefused('not_found', 'no channel payment by that event ref')
    if (cp.rows[0].state === 'failed') return { id: cp.rows[0].id as number, replay: true }
    if (cp.rows[0].state === 'settled') {
      throw new OperationRefused('already_settled', 'a settled payment cannot fail')
    }
    const history = cp.rows[0].state_history as unknown[]
    history.push({
      event: 'failed',
      event_ref: input.failureEventRef ?? null,
      verbatim: input.verbatim ?? null,
    })
    await tx.query(
      `update deedbox.channel_payment set state = 'failed', state_history = $2 where id = $1`,
      [cp.rows[0].id, JSON.stringify(history)],
    )
    await emitRegister(tx, p, {
      kind: 'record.changed',
      subjectType: 'channel_payment',
      subject: cp.rows[0].id as number,
      detail: { before: 'started', after: 'failed' },
    })
    return { id: cp.rows[0].id as number, replay: false }
  })
}

async function surchargeFor(tx: Tx, firm: number, method: string, amount: number): Promise<number> {
  const r = await tx.query(
    `select d.body from deedbox.pack_declaration d
       join deedbox.firm f on f.id = $1
       join deedbox.country_pack cp on cp.id = f.country_pack
       join deedbox.pack_version v on v.id = d.pack_version and v.id = cp.active_version
      where d.rule_point = 'billing.surcharge'`,
    [firm],
  )
  for (const row of r.rows) {
    const b = row.body as { method?: string; pct?: number }
    if (b.method === method && b.pct !== undefined) {
      return Math.round(amount * b.pct) / 100 // pct of amount, to the cent
    }
  }
  return 0 // neutral default: nothing passed to the payer
}

async function destinationFor(
  tx: Tx,
  firm: number,
  targetKind: 'bill' | 'statement' | 'instalment',
): Promise<'office' | 'client_money'> {
  const r = await tx.query(
    `select d.body from deedbox.pack_declaration d
       join deedbox.firm f on f.id = $1
       join deedbox.country_pack cp on cp.id = f.country_pack
       join deedbox.pack_version v on v.id = d.pack_version and v.id = cp.active_version
      where d.rule_point = 'channel.destination'`,
    [firm],
  )
  for (const row of r.rows) {
    const b = row.body as Record<string, string>
    const named = b[targetKind]
    if (named === 'office' || named === 'client_money') return named
    if (named === 'firm_setting') break
  }
  const setting = await tx.query(
    `select deedbox.current_setting_value('channel.bill_destination') #>> '{}' as v`,
  )
  return (setting.rows[0].v as string | null) === 'client_money' ? 'client_money' : 'office'
}

/** The matter's single open client ledger — the client-money routing home. */
async function singleOpenLedger(tx: Tx, matterId: number): Promise<{ id: number; account: number }> {
  const r = await tx.query(
    `select id, account from deedbox.matter_ledger
      where matter = $1 and ledger_kind = 'client_matter' and status = 'open' order by id`,
    [matterId],
  )
  if (r.rowCount !== 1) {
    throw new OperationRefused(
      'no_single_ledger',
      `client-money routing needs exactly one open client ledger on the matter (found ${r.rowCount})`,
    )
  }
  return { id: r.rows[0].id as number, account: r.rows[0].account as number }
}

/**
 * Post the client-money receipt for a settlement and write its document.
 * The ledger demands a staff member as the entry's author; a channel
 * settlement has none, so the CALLER resolves the accountable staff member
 * from predicate-free evidence (the top-up's alerted lawyer, or the bill's
 * issuing author) — the matter table itself is behind the visibility
 * predicate and fails closed for channel principals.
 */
async function clientMoneyReceiptInTx(
  tx: Tx,
  p: Principal,
  matterId: number,
  enteredBy: number,
  channelPaymentId: number,
  amount: number,
  method: string,
  payerParty: number | null,
  topUpRequest: number | null,
): Promise<{ receiptId: number; receiptNumber: string }> {
  const ledger = await singleOpenLedger(tx, matterId)
  const txn = await tx.query(
    `select deedbox.post_money_transaction(
       'receipt', current_date, $1, 'channel_payment', $2,
       jsonb_build_array(
         jsonb_build_object('side','cash_book','account',$3::bigint,'signed_amount',$4::numeric),
         jsonb_build_object('side','matter_ledger','account',$3::bigint,'matter_ledger',$5::bigint,'signed_amount',$4::numeric)
       )) as t`,
    [p.kind === 'staff' ? p.id : enteredBy, channelPaymentId, ledger.account, amount, ledger.id],
  )
  const num = await tx.query(`select deedbox.allocate_number('money_receipt') as n`)
  const receiptNumber = num.rows[0].n as string
  const rendering = JSON.stringify({
    document: 'money_receipt',
    receipt_number: receiptNumber,
    amount,
    method,
    channel_payment: channelPaymentId,
  })
  const artefact = await tx.query(
    `insert into deedbox.stored_artefact (kind, content_ref, content_hash, content_type, size_bytes)
     values ('money_receipt_rendering', $1, $2, 'application/json', $3) returning id`,
    [rendering, createHash('sha256').update(rendering).digest('hex'), Buffer.byteLength(rendering)],
  )
  const receipt = await tx.query(
    `insert into deedbox.money_receipt
       (matter_ledger, receipt_number, payer_party, payer_description, method, received_date,
        amount, transaction, top_up_request, channel_payment, printable_artefact)
     values ($1, $2, $3, $4, $5, current_date, $6, $7, $8, $9, $10) returning id`,
    [
      ledger.id,
      receiptNumber,
      payerParty,
      payerParty === null ? 'channel payer' : null,
      method,
      amount,
      txn.rows[0].t,
      topUpRequest,
      channelPaymentId,
      String(artefact.rows[0].id),
    ],
  )
  return { receiptId: receipt.rows[0].id as number, receiptNumber }
}

export interface SettlementResult {
  channelPayment: number
  replay: boolean
  receiptType: 'receivable_payment' | 'money_receipt'
  receipt: number
  surcharge: number
}

/** Settlement: one transaction, routed by the seam. */
export async function settleChannelPayment(
  p: Principal,
  input: { channel: string; channelEventRef: string; settlementEventRef?: string; verbatim?: unknown },
): Promise<SettlementResult> {
  requireChannelPrincipal(p)
  return withPrincipal(p, async (tx) => {
    const cp = await tx.query(
      `select cp.id, cp.state, cp.state_history, cp.amount, cp.method, cp.payment_reference,
              cp.resulting_receipt_type, cp.resulting_receipt
         from deedbox.channel_payment cp
        where cp.channel = $1 and cp.channel_event_ref = $2 for update`,
      [input.channel, input.channelEventRef],
    )
    if (cp.rowCount === 0) throw new OperationRefused('not_found', 'no channel payment by that event ref')
    const row = cp.rows[0]
    if (row.state === 'settled') {
      return {
        channelPayment: row.id as number,
        replay: true,
        receiptType: row.resulting_receipt_type as 'receivable_payment' | 'money_receipt',
        receipt: row.resulting_receipt as number,
        surcharge: 0,
      }
    }
    if (row.state === 'failed') {
      throw new OperationRefused('already_failed', 'a failed payment cannot settle')
    }
    // the per-reference row lock: the double-settlement guard
    const ref = await tx.query(
      `select id, target_kind, target, expected_amount, active
         from deedbox.payment_reference where id = $1 for update`,
      [row.payment_reference],
    )
    if (!ref.rows[0].active) {
      throw new OperationRefused('reference_inactive', 'the payment reference was deactivated before settlement')
    }
    const target = { kind: ref.rows[0].target_kind as string, id: ref.rows[0].target as number }
    const amount = Number(row.amount)
    const surcharge = await surchargeFor(tx, p.firm, row.method as string, amount)

    let receiptType: 'receivable_payment' | 'money_receipt'
    let receiptId: number

    if (target.kind === 'top_up_request') {
      // engine-fixed: client money, and the request satisfies in the same act
      const req = await tx.query(
        `select t.id, t.state, t.alerted_staff, fp.matter from deedbox.top_up_request t
           join deedbox.matter_funds_policy fp on fp.id = t.funds_policy
          where t.id = $1 for update of t`,
        [target.id],
      )
      if (req.rowCount === 0) throw new OperationRefused('not_found', 'the referenced top-up request is gone')
      const matterId = req.rows[0].matter as number
      const r = await clientMoneyReceiptInTx(
        tx, p, matterId, req.rows[0].alerted_staff as number, row.id as number,
        amount, row.method as string, null, target.id,
      )
      receiptType = 'money_receipt'
      receiptId = r.receiptId
      await satisfyTopUpInTx(tx, p, target.id)
    } else if (target.kind === 'bill') {
      const bill = await tx.query(
        `select id, matter, payer_party from deedbox.bill where id = $1`,
        [target.id],
      )
      if (bill.rowCount === 0) throw new OperationRefused('not_found', 'the referenced bill is gone')
      const dest = await destinationFor(tx, p.firm, 'bill')
      if (dest === 'client_money') {
        const issuer = await tx.query(
          `select entered_by from deedbox.bill_journal_entry
            where bill = $1 and entry_kind = 'issue_total'`,
          [target.id],
        )
        const r = await clientMoneyReceiptInTx(
          tx, p, bill.rows[0].matter as number, issuer.rows[0].entered_by as number,
          row.id as number, amount, row.method as string,
          bill.rows[0].payer_party as number, null,
        )
        receiptType = 'money_receipt'
        receiptId = r.receiptId
        // no allocation here: application to the bill follows the
        // entitlement chain later
      } else {
        const pay = await officePaymentInTx(tx, p, row.id as number, amount, row.method as string,
          bill.rows[0].payer_party as number)
        receiptType = 'receivable_payment'
        receiptId = pay
        const o = await tx.query(`select deedbox.bill_outstanding($1) as o`, [target.id])
        const cut = Math.min(Math.round(amount * 100), Math.round(Number(o.rows[0].o) * 100))
        if (cut > 0) {
          await allocateInTx(tx, p, pay, [{ bill: target.id, amount: cut / 100 }])
          await applyInstalmentCoverageInTx(tx, p, target.id)
        }
      }
    } else if (target.kind === 'statement') {
      const stmt = await tx.query(
        `select scope_kind, scope from deedbox.receivable_statement where id = $1`,
        [target.id],
      )
      if (stmt.rowCount === 0) throw new OperationRefused('not_found', 'the referenced statement is gone')
      const dest = await destinationFor(tx, p.firm, 'statement')
      if (dest === 'client_money') {
        if (stmt.rows[0].scope_kind !== 'matter') {
          throw new OperationRefused(
            'no_single_ledger',
            'a client-scope statement cannot route to client money — no single matter ledger exists',
          )
        }
        const issuer = await tx.query(
          `select j.entered_by from deedbox.bill_journal_entry j
            join deedbox.bill b on b.id = j.bill
           where b.matter = $1 and j.entry_kind = 'issue_total'
           order by j.id limit 1`,
          [stmt.rows[0].scope],
        )
        if (issuer.rowCount === 0) {
          throw new OperationRefused('not_found', 'no issued bill anchors this statement scope')
        }
        const r = await clientMoneyReceiptInTx(
          tx, p, stmt.rows[0].scope as number, issuer.rows[0].entered_by as number,
          row.id as number, amount, row.method as string, null, null,
        )
        receiptType = 'money_receipt'
        receiptId = r.receiptId
      } else {
        const payer = stmt.rows[0].scope_kind === 'client' ? (stmt.rows[0].scope as number) : null
        const pay = await officePaymentInTx(tx, p, row.id as number, amount, row.method as string, payer)
        receiptType = 'receivable_payment'
        receiptId = pay
        const { splits } = await statementSplitsInTx(tx, target.id, amount)
        if (splits.length > 0) {
          await allocateInTx(tx, p, pay, splits)
          for (const s of splits) await applyInstalmentCoverageInTx(tx, p, s.bill)
        }
      }
    } else if (target.kind === 'instalment') {
      const inst = await tx.query(
        `select i.id, i.state, i.arrangement, a.client_party
           from deedbox.instalment i
           join deedbox.payment_arrangement a on a.id = i.arrangement
          where i.id = $1 for update of i`,
        [target.id],
      )
      if (inst.rowCount === 0) throw new OperationRefused('not_found', 'the referenced instalment is gone')
      const dest = await destinationFor(tx, p.firm, 'instalment')
      if (dest === 'client_money') {
        throw new OperationRefused(
          'no_single_ledger',
          'instalment routing to client money is not declared for any launch pack — the office route is the neutral outcome',
        )
      }
      const pay = await officePaymentInTx(tx, p, row.id as number, amount, row.method as string,
        inst.rows[0].client_party as number)
      receiptType = 'receivable_payment'
      receiptId = pay
      if (inst.rows[0].state !== 'paid' && inst.rows[0].state !== 'missed') {
        await tx.query(`update deedbox.instalment set state = 'paid' where id = $1`, [target.id])
      }
      // allocate oldest-first across the arrangement's covered bills
      const covered = await tx.query(
        `select b.id, deedbox.bill_outstanding(b.id) as o
           from deedbox.arrangement_bill ab join deedbox.bill b on b.id = ab.bill
          where ab.arrangement = $1
          order by b.due_date, b.issue_date, b.bill_number`,
        [inst.rows[0].arrangement],
      )
      let remaining = Math.round(amount * 100)
      const splits: { bill: number; amount: number }[] = []
      for (const c of covered.rows) {
        if (remaining <= 0) break
        const cut = Math.min(remaining, Math.round(Number(c.o) * 100))
        if (cut > 0) {
          splits.push({ bill: c.id as number, amount: cut / 100 })
          remaining -= cut
        }
      }
      if (splits.length > 0) {
        await allocateInTx(tx, p, pay, splits)
        for (const s of splits) await applyInstalmentCoverageInTx(tx, p, s.bill)
      }
    } else {
      throw new OperationRefused('bad_target', `unroutable reference target ${target.kind}`)
    }

    // deactivate the reference when its expectation is met (the top-up
    // branch may already have deactivated it — an inactive reference is
    // immutable by trigger, so the update self-guards on active)
    const expected = ref.rows[0].expected_amount === null ? null : Number(ref.rows[0].expected_amount)
    if (expected === null || Math.round(amount * 100) >= Math.round(expected * 100)) {
      await tx.query(
        `update deedbox.payment_reference set active = false where id = $1 and active`,
        [ref.rows[0].id],
      )
    }

    const history = row.state_history as unknown[]
    history.push({
      event: 'settled',
      event_ref: input.settlementEventRef ?? null,
      surcharge_amount: surcharge,
      verbatim: input.verbatim ?? null,
    })
    await tx.query(
      `update deedbox.channel_payment
          set state = 'settled', state_history = $2, surcharge_amount = $3,
              resulting_receipt_type = $4, resulting_receipt = $5
        where id = $1`,
      [row.id, JSON.stringify(history), surcharge, receiptType, receiptId],
    )
    await emitRegister(tx, p, {
      kind: 'record.changed',
      subjectType: 'channel_payment',
      subject: row.id as number,
      detail: {
        before: 'started',
        after: 'settled',
        receipt_type: receiptType,
        receipt: receiptId,
        surcharge_amount: surcharge,
      },
    })
    return {
      channelPayment: row.id as number,
      replay: false,
      receiptType,
      receipt: receiptId,
      surcharge,
    }
  })
}

/** The office-side receipt of a settlement: a receivable payment, source channel. */
async function officePaymentInTx(
  tx: Tx,
  p: Principal,
  channelPaymentId: number,
  amount: number,
  method: string,
  payerParty: number | null,
): Promise<number> {
  const num = await tx.query(`select deedbox.allocate_number('receivable_receipt') as n`)
  const r = await tx.query(
    `insert into deedbox.receivable_payment
       (payer_party, received_date, amount, method, source, channel_payment, receipt_number)
     values ($1, current_date, $2, $3, 'channel', $4, $5) returning id`,
    [payerParty, amount, method, channelPaymentId, num.rows[0].n],
  )
  await emitRegister(tx, p, {
    kind: 'record.created',
    subjectType: 'receivable_payment',
    subject: r.rows[0].id as number,
    detail: { amount, method, source: 'channel', receipt_number: num.rows[0].n },
  })
  return r.rows[0].id as number
}
