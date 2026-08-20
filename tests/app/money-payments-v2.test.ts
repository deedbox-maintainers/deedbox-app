// The payment form's second life (0050): a ledger found by the numbers a
// person knows, with its balance; the payee's bank details carried on the
// document; the bank's reference recorded at execution; and a form field that
// is not a number refuses on screen instead of reaching the database.

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
  placeEarmark,
} from '@/lib/ops/money'
import { findLedgers, paymentRequisition } from '@/lib/reads/money'
import { parse, FormValueError } from '@/components/forms'
import { makeAdminPool, buildFixture, addStaff, type Fixture } from './helpers'

function cents(x: number | string): number {
  return Math.round(Number(x) * 100)
}

let admin: Pool
let fx: Fixture
let P: Principal
let S: Principal

beforeAll(async () => {
  admin = makeAdminPool()
  fx = await buildFixture(admin, 'mpv')
  P = { kind: 'staff', id: fx.staff, firm: fx.firm }
  S = { kind: 'staff', id: await addStaff(admin, fx, 'sam.mpv'), firm: fx.firm }
})

afterAll(async () => {
  await closePool()
  await admin.end()
})

describe('form parsing never hands the database a non-number', () => {
  it('a human ledger number in a numeric box refuses typed; empty required refuses; optional empty is null', () => {
    const fd = new FormData()
    fd.set('matter_ledger', '2026-0415')
    fd.set('blank', '')
    fd.set('fine', '42')
    expect(() => parse.num(fd, 'matter_ledger')).toThrow(FormValueError)
    expect(() => parse.num(fd, 'blank')).toThrow(FormValueError)
    expect(parse.num(fd, 'fine')).toBe(42)
    expect(parse.numOrNull(fd, 'blank')).toBeNull()
    expect(() => parse.numOrNull(fd, 'matter_ledger')).toThrow(FormValueError)
  })
})

describe('the payment document carries the payee bank details and the bank reference', () => {
  let matter: number
  let ledger: number
  let matterNumber: string

  beforeAll(async () => {
    const m = await createMatter(P, {
      title: 'Payments v2 host',
      clientParty: fx.clientParty,
      responsibleLawyer: fx.staff,
      office: fx.office,
      practiceArea: fx.practiceArea,
    })
    matter = m.id
    matterNumber = m.matterNumber
    const r = await recordMoneyReceipt(P, {
      matter,
      account: fx.account,
      amount: 1500,
      method: 'electronic_transfer',
      payerDescription: 'funding for the payment tests',
    })
    ledger = r.ledger
  })

  it('finds the ledger by matter number, with balance and available', async () => {
    const found = await findLedgers(P, matterNumber)
    expect(found.length).toBe(1)
    expect(found[0].id).toBe(ledger)
    expect(cents(found[0].balance)).toBe(150000)
    expect(cents(found[0].available)).toBe(150000)
    expect(found[0].matterNumber).toBe(matterNumber)
    // and by ledger number; and nothing for nonsense
    const byLedger = await findLedgers(P, found[0].ledgerNumber)
    expect(byLedger[0].id).toBe(ledger)
    expect(await findLedgers(P, 'no-such-ledger-xyz')).toEqual([])
  })

  it('drafts with bank details, executes with the bank reference, and the requisition says it all', async () => {
    const d = await draftMoneyPayment(P, {
      matterLedger: ledger,
      amount: 250,
      method: 'electronic_transfer',
      reason: 'settlement to the other side',
      payeeDescription: 'Smith & Co Trust Account',
      // identifier keys follow the pack's declaration; the fixture firm's
      // pack declares none, so any keys are accepted and stored as given
      payeeBankDetails: {
        accountName: ' Smith & Co Law Practice Trust ',
        identifiers: { bsb: '013-999', account_number: '336194603' },
      },
    })
    const stored = await admin.query(`select payee_bank_details, external_reference from deedbox.money_payment where id = $1`, [d.id])
    expect(stored.rows[0].payee_bank_details).toEqual({ account_name: 'Smith & Co Law Practice Trust', bsb: '013-999', account_number: '336194603' })
    expect(stored.rows[0].external_reference).toBeNull()

    await submitMoneyPayment(P, { payment: d.id })
    await authoriseMoneyPayment(S, { payment: d.id })
    const ex = await executeMoneyPayment(P, { payment: d.id, externalReference: ' EFT-20260305-00042 ' })
    expect(ex.paymentNumber).toMatch(/^P-/)
    const after = await admin.query(`select state, external_reference from deedbox.money_payment where id = $1`, [d.id])
    expect(after.rows[0].state).toBe('executed')
    expect(after.rows[0].external_reference).toBe('EFT-20260305-00042')

    // executed documents are immutable — the reference cannot be edited afterwards
    await expect(
      admin.query(`update deedbox.money_payment set external_reference = 'tampered' where id = $1`, [d.id]),
    ).rejects.toThrow(/immutable/)

    const req = await paymentRequisition(P, d.id)
    expect(req.payment.payment_number).toBe(ex.paymentNumber)
    expect((req.payment.payee_bank_details as { bsb: string }).bsb).toBe('013-999')
    expect(req.payment.external_reference).toBe('EFT-20260305-00042')
    expect(req.authorisations.length).toBe(1)
    expect(req.authorisations[0].decision).toBe('approved')
  })

  it('a draft without bank details stores none, and empty strings never become a record', async () => {
    const d = await draftMoneyPayment(P, {
      matterLedger: ledger,
      amount: 10,
      method: 'electronic_transfer',
      reason: 'small one',
      payeeDescription: 'Someone',
      payeeBankDetails: { accountName: '  ', identifiers: { bsb: '', account_number: '' } },
    })
    const stored = await admin.query(`select payee_bank_details from deedbox.money_payment where id = $1`, [d.id])
    expect(stored.rows[0].payee_bank_details).toBeNull()
  })
})

describe('the entry-time stop: a payment beyond available never drafts (0052)', () => {
  let matter: number
  let ledger: number

  beforeAll(async () => {
    const m = await createMatter(P, {
      title: 'Draft-stop host',
      clientParty: fx.clientParty,
      responsibleLawyer: fx.staff,
      office: fx.office,
      practiceArea: fx.practiceArea,
    })
    matter = m.id
    const r = await recordMoneyReceipt(P, {
      matter,
      account: fx.account,
      amount: 500,
      method: 'electronic_transfer',
      payerDescription: 'funding for the draft-stop tests',
    })
    ledger = r.ledger
  })

  it('refuses a draft beyond the ledger available, in plain words with both figures', async () => {
    await expect(
      draftMoneyPayment(P, {
        matterLedger: ledger,
        amount: 500.01,
        method: 'electronic_transfer',
        reason: 'too much',
        payeeDescription: 'Anyone',
      }),
    ).rejects.toMatchObject({ code: 'exceeds_available' })
    // exactly available is fine
    const ok = await draftMoneyPayment(P, {
      matterLedger: ledger,
      amount: 500,
      method: 'electronic_transfer',
      reason: 'the lot',
      payeeDescription: 'Anyone',
    })
    expect(ok.id).toBeGreaterThan(0)
  })

  it('an earmark reduces what a plain draft may take, and an earmark-bound draft spends its own earmark', async () => {
    const m = await createMatter(P, {
      title: 'Draft-stop earmark host',
      clientParty: fx.clientParty,
      responsibleLawyer: fx.staff,
      office: fx.office,
      practiceArea: fx.practiceArea,
    })
    const r = await recordMoneyReceipt(P, {
      matter: m.id,
      account: fx.account,
      amount: 300,
      method: 'electronic_transfer',
      payerDescription: 'earmark funding',
    })
    const e = await placeEarmark(P, { matterLedger: r.ledger, amount: 200, purpose: 'counsel fees' })
    // available is now 100 — a plain 150 draft refuses
    await expect(
      draftMoneyPayment(P, {
        matterLedger: r.ledger,
        amount: 150,
        method: 'electronic_transfer',
        reason: 'beyond available',
        payeeDescription: 'Anyone',
      }),
    ).rejects.toMatchObject({ code: 'exceeds_available' })
    // but the earmark's own payment may draw the earmarked money
    const bound = await draftMoneyPayment(P, {
      matterLedger: r.ledger,
      amount: 200,
      method: 'electronic_transfer',
      reason: 'counsel fees per earmark',
      payeeDescription: 'Counsel',
      earmark: e.id,
    })
    expect(bound.id).toBeGreaterThan(0)
  })

  it('finds the ledger by the client name', async () => {
    const who = await admin.query(`select display_name from deedbox.party where id = $1`, [fx.clientParty])
    const name = String(who.rows[0].display_name)
    const found = await findLedgers(P, name.slice(0, Math.max(3, name.length - 1)))
    expect(found.some((f) => f.matter === matter)).toBe(true)
  })
})
