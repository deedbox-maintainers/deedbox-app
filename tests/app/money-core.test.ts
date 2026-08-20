// Client money, first increment: receipts and reversals, the payment
// ceremony, transfers, earmarks, entitlements, instruments, and the
// ledger/account lifecycle. Runs after the matters/merge suites under the
// pinned order; the dual-authorisation threshold setting is left at a value
// far above any later suite's amounts.

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import type { Pool } from 'pg'
import { closePool } from '@/lib/db'
import type { Principal } from '@/lib/db'
import { MoneyRefusal } from '@/lib/db'
import { createMatter } from '@/lib/ops/matters'
import { addStaffRate, createTimeEntry, createDraftBillGroup, issueBillGroup } from '@/lib/ops/billing'
import {
  recordMoneyReceipt,
  reverseMoneyTransaction,
  draftMoneyPayment,
  submitMoneyPayment,
  authoriseMoneyPayment,
  rejectMoneyPayment,
  executeMoneyPayment,
  resubmitBlockedPayment,
  authoriseTransferIntent,
  ledgerTransfer,
  placeEarmark,
  releaseEarmark,
  establishEntitlement,
  recordEntitlementNotice,
  cancelEntitlement,
  bankInstrument,
  dishonourInstrument,
  runStaleInstrumentSweep,
  openLedger,
  closeLedger,
  reopenLedger,
  createClientAccount,
  deactivateClientAccount,
} from '@/lib/ops/money'
import { makeAdminPool, buildFixture, addStaff, setFirmSetting, type Fixture } from './helpers'

let admin: Pool
let fx: Fixture
let P: Principal
let S: Principal
let T: Principal

function cents(x: number | string): number {
  return Math.round(Number(x) * 100)
}
function dateStr(daysAgo: number): string {
  return new Date(Date.now() - daysAgo * 86400000).toISOString().slice(0, 10)
}

async function newMatter(title: string): Promise<number> {
  const m = await createMatter(P, {
    title,
    clientParty: fx.clientParty,
    responsibleLawyer: fx.staff,
    office: fx.office,
    practiceArea: fx.practiceArea,
  })
  return m.id
}

beforeAll(async () => {
  admin = makeAdminPool()
  fx = await buildFixture(admin, 'mony')
  P = { kind: 'staff', id: fx.staff, firm: fx.firm }
  S = { kind: 'staff', id: await addStaff(admin, fx, 'sam.mony'), firm: fx.firm }
  T = { kind: 'staff', id: await addStaff(admin, fx, 'tam.mony'), firm: fx.firm }
  await addStaffRate(P, { staff: fx.staff, rate: 400, effectiveFrom: '2020-01-01' })
})

afterAll(async () => {
  await closePool()
  await admin.end()
})

describe('receipts and reversals', () => {
  let matter: number
  let receiptTxn: number
  let ledger: number

  it('a first receipt auto-opens the ledger and posts through the protocol', async () => {
    matter = await newMatter('Receipt host mony')
    const r = await recordMoneyReceipt(P, {
      matter,
      account: fx.account,
      amount: 750,
      method: 'electronic_transfer',
      payerDescription: 'client transfer',
    })
    receiptTxn = r.transaction
    ledger = r.ledger
    expect(r.receiptNumber).toMatch(/^R-/)
    // a payer id the client register does not hold refuses on screen in the
    // operation's own words — never the raw foreign-key error page
    await expect(
      recordMoneyReceipt(P, {
        matter,
        account: fx.account,
        amount: 10,
        method: 'electronic_transfer',
        payerParty: 999999999,
      }),
    ).rejects.toMatchObject({ code: 'payer_unknown' })
    const balance = await admin.query(`select deedbox.ledger_balance($1) as b`, [r.ledger])
    expect(cents(balance.rows[0].b)).toBe(75000)
    const doc = await admin.query(
      `select amount, transaction, printable_artefact from deedbox.money_receipt where id = $1`,
      [r.receipt],
    )
    expect(doc.rows[0].transaction).toBe(r.transaction)
    expect(doc.rows[0].printable_artefact).toBeTruthy()
    const reg = await admin.query(
      `select 1 from deedbox.register_entry
        where event_kind = 'money.transaction_posted' and subject = $1 and matter = $2`,
      [r.transaction, matter],
    )
    expect(reg.rowCount).toBe(1)
  })

  it('an unavailable method is a captured refusal, not a silent error', async () => {
    await expect(
      recordMoneyReceipt(P, {
        matter,
        account: fx.account,
        amount: 10,
        method: 'bank_transfer', // not in the neutral catalogue
        payerDescription: 'x',
      }),
    ).rejects.toThrow(MoneyRefusal)
    const k11 = await admin.query(
      `select refusal_reason from deedbox.refused_operation
        where account = $1 and refusal_reason = 'method_unavailable'`,
      [fx.account],
    )
    expect(k11.rowCount).toBeGreaterThan(0)
  })

  it('a cheque receipt demands its instrument number and creates the inbound instrument', async () => {
    await expect(
      recordMoneyReceipt(P, {
        matter,
        account: fx.account,
        amount: 100,
        method: 'cheque',
        payerDescription: 'cheque payer',
      }),
    ).rejects.toMatchObject({ code: 'incomplete' })
    const r = await recordMoneyReceipt(P, {
      matter,
      account: fx.account,
      amount: 100,
      method: 'cheque',
      payerDescription: 'cheque payer',
      instrumentNumber: '000123',
    })
    const inst = await admin.query(
      `select i.direction, i.state, i.number from deedbox.instrument i
        where i.source_type = 'money_receipt' and i.source = $1`,
      [r.receipt],
    )
    expect(inst.rows[0]).toMatchObject({ direction: 'inbound', state: 'received', number: '000123' })
  })

  it('a reversal mirrors the whole transaction exactly once', async () => {
    const before = await admin.query(`select deedbox.ledger_balance($1) as b`, [ledger])
    const r = await reverseMoneyTransaction(P, {
      transaction: receiptTxn,
      reason: 'receipted against the wrong matter',
    })
    const after = await admin.query(`select deedbox.ledger_balance($1) as b`, [ledger])
    expect(cents(after.rows[0].b)).toBe(cents(before.rows[0].b) - 75000)
    await expect(
      reverseMoneyTransaction(P, { transaction: receiptTxn, reason: 'again' }),
    ).rejects.toMatchObject({ code: 'already_reversed' })
    await expect(
      reverseMoneyTransaction(P, { transaction: r.reversal, reason: 'undo the undo' }),
    ).rejects.toMatchObject({ code: 'not_reversible' })
  })
})

describe('the payment ceremony', () => {
  let matter: number
  let ledger: number

  beforeAll(async () => {
    matter = await newMatter('Payment host mony')
    const r = await recordMoneyReceipt(P, {
      matter,
      account: fx.account,
      amount: 2000,
      method: 'electronic_transfer',
      payerDescription: 'funding',
    })
    ledger = r.ledger
  })

  it('draft → submit → separated authorisation → execute, with the P- number and posting', async () => {
    const d = await draftMoneyPayment(P, {
      matterLedger: ledger,
      amount: 300,
      method: 'electronic_transfer',
      reason: 'settlement disbursement to counsel',
      payeeDescription: 'Counsel chambers',
    })
    const sub = await submitMoneyPayment(P, { payment: d.id })
    expect(sub.required).toBe(1)
    await expect(authoriseMoneyPayment(P, { payment: d.id })).rejects.toMatchObject({
      code: 'separation',
    })
    const auth = await authoriseMoneyPayment(S, { payment: d.id })
    expect(auth.authorised).toBe(true)
    const ex = await executeMoneyPayment(P, { payment: d.id })
    expect(ex.paymentNumber).toMatch(/^P-/)
    const balance = await admin.query(`select deedbox.ledger_balance($1) as b`, [ledger])
    expect(cents(balance.rows[0].b)).toBe(170000)
    const doc = await admin.query(
      `select state, transaction, payment_number from deedbox.money_payment where id = $1`,
      [d.id],
    )
    expect(doc.rows[0].state).toBe('executed')
    expect(doc.rows[0].transaction).toBe(ex.transaction)
  })

  it('the dual threshold freezes two approvals at submission; the second needs the second right', async () => {
    await setFirmSetting(admin, 'money.dual_authorisation_threshold', 1000, 20)
    const d = await draftMoneyPayment(P, {
      matterLedger: ledger,
      amount: 1500,
      method: 'electronic_transfer',
      reason: 'large settlement payment',
      payeeDescription: 'Settlement agent',
    })
    const sub = await submitMoneyPayment(P, { payment: d.id })
    expect(sub.required).toBe(2)
    const first = await authoriseMoneyPayment(S, { payment: d.id })
    expect(first.authorised).toBe(false)
    await expect(authoriseMoneyPayment(S, { payment: d.id })).rejects.toMatchObject({
      code: 'already_authorised',
    })
    const second = await authoriseMoneyPayment(T, { payment: d.id })
    expect(second.authorised).toBe(true)
    const ex = await executeMoneyPayment(P, { payment: d.id })
    expect(ex.paymentNumber).toMatch(/^P-/)
    // leave the threshold far above anything later suites move
    await setFirmSetting(admin, 'money.dual_authorisation_threshold', 99999999, 10)
  })

  it('a below-zero execution blocks the payment and lands in the refusal register; resubmission executes after funding', async () => {
    // the draft-time stop (0052 batch) refuses an overdraw at entry, so the
    // execute wall is staged the honest way: fund enough to draft, then
    // drain the ledger before executing — funds genuinely move between
    // draft and execution
    await recordMoneyReceipt(P, {
      matter,
      account: fx.account,
      amount: 300,
      method: 'electronic_transfer',
      payerDescription: 'staging funds for the walled execution',
    })
    const d = await draftMoneyPayment(P, {
      matterLedger: ledger,
      amount: 500,
      method: 'electronic_transfer',
      reason: 'payment beyond the balance',
      payeeDescription: 'Overreach payee',
    })
    await submitMoneyPayment(P, { payment: d.id })
    await authoriseMoneyPayment(S, { payment: d.id })
    const drain = await draftMoneyPayment(P, {
      matterLedger: ledger,
      amount: 300,
      method: 'electronic_transfer',
      reason: 'drain before the walled execution',
      payeeDescription: 'Drain payee',
    })
    await submitMoneyPayment(P, { payment: drain.id })
    await authoriseMoneyPayment(S, { payment: drain.id })
    await executeMoneyPayment(P, { payment: drain.id })
    // the ledger holds 200.00 again — the drafted 500.00 now exceeds it
    await expect(executeMoneyPayment(P, { payment: d.id })).rejects.toThrow(MoneyRefusal)
    const doc = await admin.query(`select state from deedbox.money_payment where id = $1`, [d.id])
    expect(doc.rows[0].state).toBe('blocked')
    const k11 = await admin.query(
      `select 1 from deedbox.refused_operation
        where matter_ledger = $1 and refusal_reason = 'would_go_below_zero'`,
      [ledger],
    )
    expect(k11.rowCount).toBeGreaterThan(0)

    await recordMoneyReceipt(P, {
      matter,
      account: fx.account,
      amount: 400,
      method: 'electronic_transfer',
      payerDescription: 'top-up funding',
    })
    const ex = await resubmitBlockedPayment(P, { payment: d.id })
    expect(ex.paymentNumber).toMatch(/^P-/)
    const after = await admin.query(`select state from deedbox.money_payment where id = $1`, [d.id])
    expect(after.rows[0].state).toBe('executed')
  })

  it('rejection is terminal with its reason', async () => {
    const d = await draftMoneyPayment(P, {
      matterLedger: ledger,
      amount: 10,
      method: 'electronic_transfer',
      reason: 'to be rejected',
      payeeDescription: 'Nobody',
    })
    await submitMoneyPayment(P, { payment: d.id })
    await rejectMoneyPayment(S, { payment: d.id, reason: 'wrong payee entirely' })
    const doc = await admin.query(
      `select state, rejection_reason from deedbox.money_payment where id = $1`,
      [d.id],
    )
    expect(doc.rows[0].state).toBe('rejected')
    expect(doc.rows[0].rejection_reason).toContain('wrong payee')
  })
})

describe('earmarks, entitlements and transfers', () => {
  let matter: number
  let ledger: number

  beforeAll(async () => {
    matter = await newMatter('Earmark host mony')
    const r = await recordMoneyReceipt(P, {
      matter,
      account: fx.account,
      amount: 1000,
      method: 'electronic_transfer',
      payerDescription: 'trust deposit',
    })
    ledger = r.ledger
  })

  it('earmarks reserve within balance; a consuming payment writes the residual', async () => {
    await expect(
      placeEarmark(P, { matterLedger: ledger, amount: 1500, purpose: 'too much' }),
    ).rejects.toMatchObject({ code: 'earmark_shortfall' })
    const em = await placeEarmark(P, { matterLedger: ledger, amount: 600, purpose: 'settlement holdback' })

    const d = await draftMoneyPayment(P, {
      matterLedger: ledger,
      amount: 250,
      method: 'electronic_transfer',
      reason: 'partial settlement from the holdback',
      payeeDescription: 'Settlement payee',
      earmark: em.id,
    })
    await submitMoneyPayment(P, { payment: d.id })
    await authoriseMoneyPayment(S, { payment: d.id })
    await executeMoneyPayment(P, { payment: d.id })
    const consumed = await admin.query(
      `select state, consumed_by_payment from deedbox.earmark where id = $1`,
      [em.id],
    )
    expect(consumed.rows[0].state).toBe('consumed')
    expect(consumed.rows[0].consumed_by_payment).toBe(d.id)
    const residual = await admin.query(
      `select id, amount, state from deedbox.earmark
        where matter_ledger = $1 and state = 'active' and purpose = 'settlement holdback'`,
      [ledger],
    )
    expect(residual.rowCount).toBe(1)
    expect(cents(residual.rows[0].amount)).toBe(35000)

    await releaseEarmark(P, { earmark: residual.rows[0].id, reason: 'holdback resolved' })
    const active = await admin.query(
      `select count(*)::int as n from deedbox.earmark where matter_ledger = $1 and state = 'active'`,
      [ledger],
    )
    expect(active.rows[0].n).toBe(0)
  })

  it('entitlements: notice gates actionability; cancellation needs zero consumption', async () => {
    const te = await createTimeEntry(P, { matter, workDate: dateStr(1), units: 5, narrative: 'mony work' })
    const g = await createDraftBillGroup(P, { matter, timeEntries: [te.id] })
    const bill = (await issueBillGroup(P, { group: g.group, issueDate: dateStr(5) })).bills[0].id

    const e = await establishEntitlement(P, {
      matterLedger: ledger,
      amount: 200,
      basisKind: 'rendered_bill',
      bill,
      noticeRequired: true,
    })
    expect(e.status).toBe('awaiting_notice')
    const n = await recordEntitlementNotice(P, {
      entitlement: e.id,
      noticeEventType: 'client_statement',
      noticeEvent: 900901,
    })
    expect(n.actionableFrom).toBeTruthy()
    const status = await admin.query(`select deedbox.entitlement_status($1) as s`, [e.id])
    expect(status.rows[0].s).toBe('actionable') // no pack notice period: immediate
    await cancelEntitlement(P, { entitlement: e.id, reason: 'client queried the bill' })
    const cancelled = await admin.query(
      `select cancelled_at from deedbox.entitlement where id = $1`,
      [e.id],
    )
    expect(cancelled.rows[0].cancelled_at).not.toBeNull()
  })

  it('a same-account transfer needs an approved intent from a different person', async () => {
    const m2 = await newMatter('Transfer destination mony')
    const dest = await openLedger(P, { matter: m2, account: fx.account })
    const auth = await authoriseTransferIntent(S, {
      fromLedger: ledger,
      toLedger: dest.id,
      amount: 150,
      reason: 'shared settlement split',
    })
    // the authoriser never executes their own approval
    await expect(
      ledgerTransfer(S, {
        fromLedger: ledger,
        toLedger: dest.id,
        amount: 150,
        reason: 'shared settlement split',
        authorisation: auth.authorisation,
      }),
    ).rejects.toMatchObject({ code: 'separation' })
    const t = await ledgerTransfer(P, {
      fromLedger: ledger,
      toLedger: dest.id,
      amount: 150,
      reason: 'shared settlement split',
      authorisation: auth.authorisation,
    })
    expect(t.transferNumber).toMatch(/^T-/)
    const destBalance = await admin.query(`select deedbox.ledger_balance($1) as b`, [dest.id])
    expect(cents(destBalance.rows[0].b)).toBe(15000)
  })
})

describe('instruments and lifecycle', () => {
  it('an inbound cheque banks, then dishonours on the bank authority with earmarks auto-releasing', async () => {
    const m = await newMatter('Dishonour host mony')
    const r = await recordMoneyReceipt(P, {
      matter: m,
      account: fx.account,
      amount: 500,
      method: 'cheque',
      payerDescription: 'cheque payer',
      instrumentNumber: '000900',
    })
    const inst = await admin.query(
      `select id from deedbox.instrument where source_type = 'money_receipt' and source = $1`,
      [r.receipt],
    )
    await bankInstrument(P, { instrument: inst.rows[0].id })
    // an earmark rides the banked money; the dishonour must auto-release it
    await placeEarmark(P, { matterLedger: r.ledger, amount: 400, purpose: 'pending settlement' })

    const d = await dishonourInstrument(P, {
      instrument: inst.rows[0].id,
      bankEvidence: 'bank advice 2026-08-14: insufficient funds',
      honouredAmount: 120,
    })
    expect(d.freshReceipt).not.toBeNull()
    const balance = await admin.query(`select deedbox.ledger_balance($1) as b`, [r.ledger])
    expect(cents(balance.rows[0].b)).toBe(12000) // reversal −500, honoured +120
    const state = await admin.query(
      `select state, dishonour_reversal from deedbox.instrument where id = $1`,
      [inst.rows[0].id],
    )
    expect(state.rows[0].state).toBe('dishonoured')
    expect(state.rows[0].dishonour_reversal).toBe(d.reversal)
    const earmarks = await admin.query(
      `select state from deedbox.earmark where matter_ledger = $1 order by id desc limit 1`,
      [r.ledger],
    )
    expect(earmarks.rows[0].state).toBe('released') // auto-released by the shortfall rule
  })

  it('the stale sweep flips aged outbound instruments', async () => {
    const aged = await admin.query(
      `insert into deedbox.instrument
         (account, direction, instrument_kind, number, amount, state, source_type, source,
          transaction, stale_after)
       select $1, 'outbound', 'cheque', 'STALE-1', 50, 'created', 'money_payment', 900902,
              (select id from deedbox.money_transaction order by id limit 1),
              current_date - 1
       returning id`,
      [fx.account],
    )
    const swept = await runStaleInstrumentSweep(P)
    expect(swept.staled).toContain(aged.rows[0].id)
    const state = await admin.query(`select state from deedbox.instrument where id = $1`, [
      aged.rows[0].id,
    ])
    expect(state.rows[0].state).toBe('stale')
  })

  it('a ledger closes clean with its closing copy first, and reopens privileged', async () => {
    const m = await newMatter('Close host mony')
    const r = await recordMoneyReceipt(P, {
      matter: m,
      account: fx.account,
      amount: 80,
      method: 'electronic_transfer',
      payerDescription: 'small deposit',
    })
    await expect(closeLedger(P, { ledger: r.ledger })).rejects.toMatchObject({
      code: 'balance_remains',
    })
    // pay it all away through the ceremony, then close
    const d = await draftMoneyPayment(P, {
      matterLedger: r.ledger,
      amount: 80,
      method: 'electronic_transfer',
      reason: 'return of deposit',
      payeeDescription: 'The client',
    })
    await submitMoneyPayment(P, { payment: d.id })
    await authoriseMoneyPayment(S, { payment: d.id })
    await executeMoneyPayment(P, { payment: d.id })
    await closeLedger(P, { ledger: r.ledger })
    const closed = await admin.query(
      `select status, closing_copy from deedbox.matter_ledger where id = $1`,
      [r.ledger],
    )
    expect(closed.rows[0].status).toBe('closed')
    expect(closed.rows[0].closing_copy).toBeTruthy()
    const copy = await admin.query(
      `select content_ref from deedbox.stored_artefact where id = $1::bigint`,
      [closed.rows[0].closing_copy],
    )
    const parsed = JSON.parse(copy.rows[0].content_ref as string)
    expect(parsed.final_balance).toBe(0)
    expect(parsed.lines.length).toBeGreaterThan(0)

    await reopenLedger(P, { ledger: r.ledger, reason: 'late refund arriving' })
    const reopened = await admin.query(
      `select status, reopened_count from deedbox.matter_ledger where id = $1`,
      [r.ledger],
    )
    expect(reopened.rows[0].status).toBe('open')
    expect(reopened.rows[0].reopened_count).toBe(1)
  })

  it('accounts create privileged; deactivation stands behind the schema guards', async () => {
    const a = await createClientAccount(P, { name: 'Controlled money mony', accountKind: 'pooled' })
    const reg = await admin.query(
      `select privileged from deedbox.register_entry
        where subject_type = 'client_account' and subject = $1 and event_kind = 'record.created'`,
      [a.id],
    )
    expect(reg.rows[0].privileged).toBe(true)
    await deactivateClientAccount(P, { account: a.id, reason: 'never used' })
    const row = await admin.query(`select active from deedbox.client_account where id = $1`, [a.id])
    expect(row.rows[0].active).toBe(false)
  })
})

describe('partial earmark release (0055 batch)', () => {
  it('releases part in one act — the remainder stays set aside, history intact', async () => {
    const m = await newMatter('Partial release host mony')
    const r = await recordMoneyReceipt(P, {
      matter: m,
      account: fx.account,
      amount: 500,
      method: 'electronic_transfer',
      payerDescription: 'partial release funding',
    })
    const em = await placeEarmark(P, { matterLedger: r.ledger, amount: 200, purpose: 'counsel brief fee' })

    // over-release refuses with the arithmetic
    await expect(
      releaseEarmark(P, { earmark: em.id, reason: 'too much', amount: 250 }),
    ).rejects.toMatchObject({ code: 'exceeds_earmark' })

    // part-release: the entry closes, the remainder re-places in the SAME act
    const part = await releaseEarmark(P, { earmark: em.id, reason: 'counsel paid less', amount: 80 })
    expect(part.remainderEarmark).not.toBeNull()
    const rows = await admin.query(
      `select id, state, amount from deedbox.earmark
        where matter_ledger = $1 order by id`,
      [r.ledger],
    )
    const orig = rows.rows.find((x) => x.id === em.id)!
    const rem = rows.rows.find((x) => x.id === part.remainderEarmark)!
    expect(orig.state).toBe('released')
    expect(rem.state).toBe('active')
    expect(cents(rem.amount)).toBe(12000)
    const avail = await admin.query(`select deedbox.ledger_available($1) a`, [r.ledger])
    expect(cents(avail.rows[0].a)).toBe(38000) // 500 held − 120 still set aside

    // full release of the remainder (no amount)
    const full = await releaseEarmark(P, { earmark: part.remainderEarmark!, reason: 'matter settled' })
    expect(full.remainderEarmark).toBeNull()
    const after = await admin.query(`select deedbox.ledger_available($1) a`, [r.ledger])
    expect(cents(after.rows[0].a)).toBe(50000)
  })
})
