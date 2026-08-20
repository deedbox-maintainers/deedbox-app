// 0048 — one-person client-money operation is a firm's own choice.
//
// The separation family (requester never authorises; authoriser never
// executes) shipped as an unconditional rule, which quietly made the
// product unusable for a lawful sole practice. It is now the firm setting
// `money.self_authorisation`: OFF keeps every wall exactly as shipped
// (pinned here so the default can never drift); ON lets one person raise,
// authorise and execute a payment alone, every step registered under their
// own name. Multi-approval distinctness survives the setting.

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
import { moneyViewerFlags } from '@/lib/reads/money'
import { makeAdminPool, buildFixture, setFirmSetting, type Fixture } from './helpers'

let admin: Pool
let fx: Fixture
let P: Principal

const TAG = 'solo'

async function fundedLedger(title: string): Promise<number> {
  const m = await createMatter(P, {
    title,
    clientParty: fx.clientParty,
    responsibleLawyer: fx.staff,
    office: fx.office,
    practiceArea: fx.practiceArea,
  })
  const r = await recordMoneyReceipt(P, {
    matter: m.id,
    account: fx.account,
    amount: 1000,
    method: 'electronic_transfer',
    payerDescription: 'funding',
  })
  return r.ledger
}

async function draftAndSubmit(ledger: number): Promise<number> {
  const d = await draftMoneyPayment(P, {
    matterLedger: ledger,
    amount: 100,
    method: 'electronic_transfer',
    reason: 'one-person practice payment',
    payeeDescription: 'Counsel chambers',
  })
  const sub = await submitMoneyPayment(P, { payment: d.id })
  expect(sub.required).toBe(1)
  return d.id
}

describe('one-person client-money operation is the firm’s choice', () => {
  beforeAll(async () => {
    admin = makeAdminPool()
    fx = await buildFixture(admin, TAG)
    P = { kind: 'staff', id: fx.staff, firm: fx.firm }
  })

  afterAll(async () => {
    await closePool()
    await admin.end()
  })

  it('with the setting off (the shipped default), the requester still cannot authorise', async () => {
    const ledger = await fundedLedger('Solo default wall solo')
    const payment = await draftAndSubmit(ledger)
    await expect(authoriseMoneyPayment(P, { payment })).rejects.toMatchObject({
      code: 'separation',
    })
  })

  it('with the setting on, one person raises, authorises and executes — registered throughout', async () => {
    await setFirmSetting(admin, 'money.self_authorisation', true, 0)
    // the screen flag follows the setting — Approve shows to the requester
    // only while the firm allows self-authorisation (the button was once
    // hidden despite the setting, leaving the approver unable to approve)
    expect((await moneyViewerFlags(P)).selfAuthorisation).toBe(true)
    const ledger = await fundedLedger('Solo full lifecycle solo')
    const payment = await draftAndSubmit(ledger)
    const auth = await authoriseMoneyPayment(P, { payment })
    expect(auth.authorised).toBe(true)
    const ex = await executeMoneyPayment(P, { payment })
    expect(ex.paymentNumber).toMatch(/^P-/)
    const doc = await admin.query(
      `select state, requested_by from deedbox.money_payment where id = $1`,
      [payment],
    )
    expect(doc.rows[0].state).toBe('executed')
    expect(doc.rows[0].requested_by).toBe(fx.staff)
    // the register carries every step under the one person's name
    const reg = await admin.query(
      `select count(*)::int as n from deedbox.register_entry
        where subject_type = 'money_payment' and subject = $1`,
      [payment],
    )
    expect(reg.rows[0].n).toBeGreaterThanOrEqual(3)
    await setFirmSetting(admin, 'money.self_authorisation', false, 0)
    expect((await moneyViewerFlags(P)).selfAuthorisation).toBe(false)
  })

  it('switching back off restores the wall', async () => {
    const ledger = await fundedLedger('Solo wall back solo')
    const payment = await draftAndSubmit(ledger)
    await expect(authoriseMoneyPayment(P, { payment })).rejects.toMatchObject({
      code: 'separation',
    })
  })
})
