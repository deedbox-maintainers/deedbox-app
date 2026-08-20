// Receipt and payment history — the find-a-transaction reads behind the
// Receipts screen and the payments page's "Find a payment" panel. Born from
// the first real installation's second support email: receipts could be
// recorded but nowhere found; payments had a queue but no history search.
// Pins: find by payer/payee name, by gapless number, by matter (current AND
// prior number); date narrowing; and the empty-query recency listing.

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import type { Pool } from 'pg'
import { closePool } from '@/lib/db'
import type { Principal } from '@/lib/db'
import { createMatter } from '@/lib/ops/matters'
import {
  recordMoneyReceipt,
  draftMoneyPayment,
  submitMoneyPayment,
  authoriseMoneyPayment,
  executeMoneyPayment,
} from '@/lib/ops/money'
import { receiptHistory, paymentHistory } from '@/lib/reads/money'
import { makeAdminPool, buildFixture, addStaff, type Fixture } from './helpers'

let admin: Pool
let fx: Fixture
let P: Principal
let S: Principal
let matter = 0
let ledger = 0
let receiptNo = ''
let paymentNo = ''

const TAG = 'hist'

describe('receipt and payment history are findable', () => {
  beforeAll(async () => {
    admin = makeAdminPool()
    fx = await buildFixture(admin, TAG)
    P = { kind: 'staff', id: fx.staff, firm: fx.firm }
    S = { kind: 'staff', id: await addStaff(admin, fx, 'sam.hist'), firm: fx.firm }
    const m = await createMatter(P, {
      title: 'History host hist',
      clientParty: fx.clientParty,
      responsibleLawyer: fx.staff,
      office: fx.office,
      practiceArea: fx.practiceArea,
    })
    matter = m.id
    await admin.query(
      `update deedbox.matter set prior_reference = 'HX-4471' where id = $1`,
      [matter],
    )
    const r = await recordMoneyReceipt(P, {
      matter,
      account: fx.account,
      amount: 750,
      method: 'electronic_transfer',
      payerDescription: 'Wilhelmina Kastrup settlement monies',
    })
    ledger = r.ledger
    receiptNo = r.receiptNumber
    const d = await draftMoneyPayment(P, {
      matterLedger: ledger,
      amount: 200,
      method: 'electronic_transfer',
      reason: 'counsel fees on brief',
      payeeDescription: 'Osgood Chambers clerking',
    })
    await submitMoneyPayment(P, { payment: d.id })
    await authoriseMoneyPayment(S, { payment: d.id })
    const ex = await executeMoneyPayment(P, { payment: d.id })
    paymentNo = ex.paymentNumber
  })

  afterAll(async () => {
    await closePool()
    await admin.end()
  })

  it('a receipt is findable by payer, by number, and by the matter’s prior number', async () => {
    for (const q of ['Wilhelmina Kastrup', receiptNo, 'HX-4471']) {
      const rows = await receiptHistory(P, { q })
      expect(rows.some((r) => r.receiptNumber === receiptNo), q).toBe(true)
    }
  })

  it('a date range narrows receipts honestly', async () => {
    const past = await receiptHistory(P, { q: 'Kastrup', to: '2001-01-01' })
    expect(past.length).toBe(0)
    const today = await receiptHistory(P, { q: 'Kastrup', from: '2001-01-01' })
    expect(today.some((r) => r.receiptNumber === receiptNo)).toBe(true)
  })

  it('a payment is findable by payee, by number, and by its reason', async () => {
    for (const q of ['Osgood Chambers', paymentNo, 'counsel fees']) {
      const rows = await paymentHistory(P, { q })
      const hit = rows.find((r) => r.paymentNumber === paymentNo)
      expect(hit, q).toBeTruthy()
      expect(hit!.state).toBe('executed')
    }
  })

  it('an empty query serves recency, and the matter columns carry through', async () => {
    const rows = await paymentHistory(P, {})
    const hit = rows.find((r) => r.paymentNumber === paymentNo)
    expect(hit).toBeTruthy()
    expect(hit!.matterNumber).toBeTruthy()
    expect(hit!.matterTitle).toContain('History host')
  })
})
