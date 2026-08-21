// The held-funds bridge, billed attribution, line-item export,
// unallocated-remainder routing, and payment details + the send
// ceremony. Runs LAST of the billing suites under the pinned alphabetical
// order; flips billing.payment_details_require_approval inside a finally.

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import type { Pool } from 'pg'
import { closePool } from '@/lib/db'
import type { Principal } from '@/lib/db'
import { MoneyRefusal } from '@/lib/db'
import { createMatter } from '@/lib/ops/matters'
import { changeRestriction } from '@/lib/ops/matters/restriction'
import {
  addStaffRate,
  createTimeEntry,
  createDraftBillGroup,
  issueBillGroup,
  recordPayment,
  allocatePayment,
  replaceBillAttribution,
  exportBillLines,
  savePaymentDetails,
  approvePaymentDetails,
  previewBillSend,
  sendBill,
  previewHeldFundsApplication,
  prepareFirmWideHeldFunds,
  commitHeldFundsApplication,
  authoriseHeldFundsItem,
  abandonHeldFundsRun,
  routeUnallocatedRemainders,
} from '@/lib/ops/billing'
import { dispatchOutboundQueue, runRequisitionDocumentHtml } from '@/lib/ops/outbound'
import { heldFundsRunRequisition } from '@/lib/reads/billing'
import { setDocumentByteStore } from '@/lib/ops/documents/store'
import { makeAdminPool, buildFixture, addStaff, setFirmSetting, type Fixture } from './helpers'

let admin: Pool
let fx: Fixture
let P: Principal
let second: number
let S: Principal

function dateStr(daysAgo: number): string {
  return new Date(Date.now() - daysAgo * 86400000).toISOString().slice(0, 10)
}
function cents(x: number | string): number {
  return Math.round(Number(x) * 100)
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

async function issuedBillOn(matter: number, units: number, issueDaysAgo = 20): Promise<number> {
  const e = await createTimeEntry(P, {
    matter,
    workDate: dateStr(1),
    units,
    narrative: `settle work ${matter}-${units}`,
  })
  const g = await createDraftBillGroup(P, { matter, timeEntries: [e.id] })
  return (await issueBillGroup(P, { group: g.group, issueDate: dateStr(issueDaysAgo) })).bills[0].id
}

/** Fund a ledger via the posting protocol (deployment role, real triggers). */
async function fundLedger(ledger: number, account: number, amount: number): Promise<void> {
  await admin.query(
    `select deedbox.post_money_transaction(
       'receipt', current_date, $1, 'money_receipt', 900800,
       jsonb_build_array(
         jsonb_build_object('side','cash_book','account',$2::bigint,'signed_amount',$4::numeric),
         jsonb_build_object('side','matter_ledger','account',$2::bigint,'matter_ledger',$3::bigint,'signed_amount',$4::numeric)
       ))`,
    [fx.staff, account, ledger, amount],
  )
}

beforeAll(async () => {
  admin = makeAdminPool()
  fx = await buildFixture(admin, 'bset')
  P = { kind: 'staff', id: fx.staff, firm: fx.firm }
  second = await addStaff(admin, fx, 'sam.bset')
  S = { kind: 'staff', id: second, firm: fx.firm }
  await addStaffRate(P, { staff: fx.staff, rate: 400, effectiveFrom: '2020-01-01' })
  await admin.query(
    `insert into deedbox.contact_point (party, kind, value, is_primary)
     values ($1, 'email', 'client.bset@example.test', true)`,
    [fx.clientParty],
  )
})

afterAll(async () => {
  await closePool()
  await admin.end()
})

describe('billed attribution', () => {
  let bill: number

  it('replaces the set whole, sum-checked; the current set drives future fans only', async () => {
    const m = await newMatter('Attribution host')
    bill = await issuedBillOn(m, 10) // 400.00

    // a first allocation fans across the default attribution (all to P)
    const pay1 = await recordPayment(P, {
      receivedDate: dateStr(1),
      amount: 100,
      method: 'bank_transfer',
      allocations: [{ bill, amount: 100 }],
    })
    void pay1

    await expect(
      replaceBillAttribution(P, {
        bill,
        shares: [
          { staff: fx.staff, amount: 250 },
          { staff: second, amount: 100 },
        ],
      }),
    ).rejects.toMatchObject({ code: 'bad_sum' })

    await replaceBillAttribution(P, {
      bill,
      shares: [
        { staff: fx.staff, amount: 250 },
        { staff: second, amount: 150 },
      ],
    })
    const current = await admin.query(
      `select staff, billed_share from deedbox.bill_attribution
        where bill = $1 and superseded_at is null order by staff`,
      [bill],
    )
    expect(current.rowCount).toBe(2)
    const superseded = await admin.query(
      `select count(*)::int as n from deedbox.bill_attribution
        where bill = $1 and superseded_at is not null`,
      [bill],
    )
    expect(superseded.rows[0].n).toBeGreaterThan(0)

    // a second allocation fans across the NEW set: 100 × 250/400 and 150/400
    await recordPayment(P, {
      receivedDate: dateStr(1),
      amount: 100,
      method: 'bank_transfer',
      allocations: [{ bill, amount: 100 }],
    })
    const fans = await admin.query(
      `select ca.staff, ca.amount from deedbox.collection_attribution ca
        join deedbox.bill_journal_entry j on j.id = ca.allocation_entry
       where j.bill = $1 and j.entry_kind = 'payment_allocation'
       order by j.id, ca.staff`,
      [bill],
    )
    // first fan: 100.00 to P (the old set, standing); second fan: 62.50 / 37.50
    expect(fans.rows.length).toBe(3)
    expect(cents(fans.rows[0].amount)).toBe(10000)
    expect(cents(fans.rows[1].amount)).toBe(6250)
    expect(cents(fans.rows[2].amount)).toBe(3750)
  })
})

describe('line-item export', () => {
  it('exports the stable structure and registers a privileged export event', async () => {
    const m = await newMatter('Export host')
    await issuedBillOn(m, 5)
    const r = await exportBillLines(P, { matter: m })
    expect(r.rows).toBe(1)
    expect(r.restrictedMatters).toBe(0)
    const reg = await admin.query(
      `select privileged, artefact, detail from deedbox.register_entry
        where event_kind = 'export.performed' and subject = $1`,
      [r.artefact],
    )
    expect(reg.rowCount).toBe(1)
    expect(reg.rows[0].privileged).toBe(true)
    expect(reg.rows[0].detail.after.rows).toBe(1)
    const artefact = await admin.query(
      `select content_ref from deedbox.stored_artefact where id = $1`,
      [r.artefact],
    )
    const parsed = JSON.parse(artefact.rows[0].content_ref as string)
    expect(parsed.rows[0].category_key).toBeTruthy()
    expect(cents(parsed.rows[0].amount)).toBe(20000)
  })

  it('counts restricted matters for the anomaly rules', async () => {
    const m = await newMatter('Restricted export host')
    await issuedBillOn(m, 5)
    await changeRestriction(P, {
      matter: m,
      change: { action: 'add_grant', granteeKind: 'staff', grantee: fx.staff },
      reason: 'confidential engagement',
    })
    const r = await exportBillLines(P, { matter: m })
    expect(r.restrictedMatters).toBe(1)
    const reg = await admin.query(
      `select detail from deedbox.register_entry
        where event_kind = 'export.performed' and subject = $1`,
      [r.artefact],
    )
    expect(reg.rows[0].detail.after.restricted_matters).toBe(1)
  })
})

describe('payment details and the send ceremony', () => {
  it('versions supersede; approval off means immediate governance', async () => {
    const v1 = await savePaymentDetails(P, {
      accountHolderName: 'Fixture Firm Operating Account',
      bankName: 'Neutral Bank',
      identifierValues: { account_number: '12345678' },
    })
    expect(v1.state).toBe('approved')
    const v2 = await savePaymentDetails(P, {
      accountHolderName: 'Fixture Firm Operating Account',
      bankName: 'Neutral Bank',
      identifierValues: { account_number: '87654321' },
    })
    expect(v2.state).toBe('approved')
    const governing = await admin.query(
      `select id, identifier_values from deedbox.payment_details
        where state = 'approved' and superseded_at is null`,
    )
    expect(governing.rowCount).toBe(1)
    expect(governing.rows[0].id).toBe(v2.id)
    const reg = await admin.query(
      `select count(*)::int as n from deedbox.register_entry
        where event_kind = 'payment_details.changed' and privileged`,
    )
    expect(reg.rows[0].n).toBeGreaterThanOrEqual(2)
  })

  it('with approval on: pending parks, the author cannot approve, a second person can', async () => {
    await setFirmSetting(admin, 'billing.payment_details_require_approval', true, 20)
    try {
      const v3 = await savePaymentDetails(P, {
        accountHolderName: 'Fixture Firm Operating Account',
        bankName: 'Neutral Bank',
        identifierValues: { account_number: '11112222' },
      })
      expect(v3.state).toBe('pending')
      // the prior version keeps governing while pending
      const governing = await admin.query(
        `select identifier_values from deedbox.payment_details
          where state = 'approved' and superseded_at is null`,
      )
      expect(governing.rows[0].identifier_values.account_number).toBe('87654321')
      // one pending at a time
      await expect(
        savePaymentDetails(P, {
          accountHolderName: 'X',
          bankName: 'Y',
          identifierValues: { account_number: '9' },
        }),
      ).rejects.toMatchObject({ code: 'pending_exists' })
      // the author cannot approve their own version (schema separation)
      await expect(approvePaymentDetails(P, { version: v3.id })).rejects.toThrow(
        /different approver/,
      )
      await approvePaymentDetails(S, { version: v3.id })
      const after = await admin.query(
        `select id from deedbox.payment_details where state = 'approved' and superseded_at is null`,
      )
      expect(after.rows[0].id).toBe(v3.id)
    } finally {
      await setFirmSetting(admin, 'billing.payment_details_require_approval', false, 10)
    }
  })

  it('the despatch resolves the details in force AT SEND, and the ceremony is deliberate', async () => {
    const m = await newMatter('Send host')
    const bill = await issuedBillOn(m, 5)
    // the issue-time rendering froze the THEN-governing details; a change now…
    await savePaymentDetails(P, {
      accountHolderName: 'Fixture Firm Operating Account',
      bankName: 'Neutral Bank',
      identifierValues: { account_number: '33334444' },
    })

    await expect(
      sendBill(P, { bill, recipients: ['client.bset@example.test'], confirmed: false }),
    ).rejects.toMatchObject({ code: 'not_confirmed' })
    await expect(sendBill(P, { bill, recipients: [], confirmed: true })).rejects.toMatchObject({
      code: 'no_recipients',
    })

    const preview = await previewBillSend(P, { bill })
    expect(preview.paymentDetailsComplete).toBe(true)
    expect(preview.suggestedRecipient).toBe('client.bset@example.test')

    const sent = await sendBill(P, {
      bill,
      recipients: ['client.bset@example.test'],
      confirmed: true,
    })
    expect(sent.queued).toBe(1)
    expect(sent.paymentDetailsIncluded).toBe(true)
    const artefact = await admin.query(
      `select content_ref from deedbox.stored_artefact where id = $1`,
      [sent.artefact],
    )
    const rendering = JSON.parse(artefact.rows[0].content_ref as string)
    // …reaches this despatch: the block resolves at send, not at issue
    expect(rendering.payment_details.identifier_values.account_number).toBe('33334444')
    const outbound = await admin.query(
      `select 1 from deedbox.outbound_message
        where purpose = 'bill_despatch' and related = $1 and recipient = 'client.bset@example.test'`,
      [bill],
    )
    expect(outbound.rowCount).toBe(1)
    const reg = await admin.query(
      `select detail, artefact from deedbox.register_entry
        where subject_type = 'bill' and subject = $1 and event_kind = 'record.changed'
        order by id desc limit 1`,
      [bill],
    )
    expect(reg.rows[0].detail.sent_to).toEqual(['client.bset@example.test'])
    expect(reg.rows[0].artefact).toBe(String(sent.artefact))
  })
})

describe('the held-funds bridge', () => {
  let bill1: number
  let run1: number
  let item1: number

  it('preview derives candidates and writes the run; abandon closes a previewed run', async () => {
    bill1 = await issuedBillOn(fx.matter, 10) // 400.00 on the fixture matter (has the ledger)
    await fundLedger(fx.ledger, fx.account, 1000)
    await admin.query(
      `insert into deedbox.entitlement (matter_ledger, basis_kind, bill, amount, notice_required)
       values ($1, 'rendered_bill', $2, 400, false)`,
      [fx.ledger, bill1],
    )
    const preview = await previewHeldFundsApplication(P, { matter: fx.matter })
    run1 = preview.run
    expect(preview.executable.length).toBe(1)
    expect(cents(preview.executable[0].amount)).toBe(40000) // min(headroom, available, outstanding)
    const items = await admin.query(
      `select id, item_state from deedbox.funds_application where run = $1`,
      [run1],
    )
    expect(items.rowCount).toBe(1)
    expect(items.rows[0].item_state).toBe('previewed')
    item1 = items.rows[0].id

    // a second preview can be abandoned cleanly
    const p2 = await previewHeldFundsApplication(P, { matter: fx.matter })
    await abandonHeldFundsRun(P, { run: p2.run })
    const closed = await admin.query(
      `select state from deedbox.application_run where id = $1`,
      [p2.run],
    )
    expect(closed.rows[0].state).toBe('abandoned')
  })

  it('commit parks every item awaiting authorisation; the requester never authorises', async () => {
    const r = await commitHeldFundsApplication(P, { run: run1 })
    expect(r.awaiting).toEqual([item1])
    const item = await admin.query(
      `select item_state, money_payment from deedbox.funds_application where id = $1`,
      [item1],
    )
    expect(item.rows[0].item_state).toBe('awaiting_authorisation')
    const pay = await admin.query(
      `select state, required_authorisations, requested_by from deedbox.money_payment where id = $1`,
      [item.rows[0].money_payment],
    )
    expect(pay.rows[0].state).toBe('pending_authorisation')
    expect(pay.rows[0].required_authorisations).toBe(1)
    expect(pay.rows[0].requested_by).toBe(fx.staff)

    await expect(
      authoriseHeldFundsItem(P, { item: item1, decision: 'approve' }),
    ).rejects.toMatchObject({ code: 'separation' })
  })

  it('a completing approval executes the whole bridge in one transaction', async () => {
    const r = await authoriseHeldFundsItem(S, { item: item1, decision: 'approve' })
    if (!r.executed) throw new Error('expected the bridge to execute')
    expect(r.paymentNumber).toMatch(/^P-/)
    expect(r.receiptNumber).toMatch(/^OR-/)

    const balance = await admin.query(`select deedbox.ledger_balance($1) as b`, [fx.ledger])
    expect(cents(balance.rows[0].b)).toBe(60000) // 1000 − 400
    const outstanding = await admin.query(`select deedbox.bill_outstanding($1) as o`, [bill1])
    expect(cents(outstanding.rows[0].o)).toBe(0)
    const item = await admin.query(
      `select item_state, money_payment, receivable_payment, allocation_entry
         from deedbox.funds_application where id = $1`,
      [item1],
    )
    expect(item.rows[0].item_state).toBe('completed')
    expect(item.rows[0].receivable_payment).not.toBeNull()
    expect(item.rows[0].allocation_entry).not.toBeNull()
    const pay = await admin.query(
      `select state, transaction, payment_number from deedbox.money_payment where id = $1`,
      [item.rows[0].money_payment],
    )
    expect(pay.rows[0].state).toBe('executed')
    expect(pay.rows[0].transaction).not.toBeNull()
    const rp = await admin.query(
      `select source, funds_application from deedbox.receivable_payment where id = $1`,
      [item.rows[0].receivable_payment],
    )
    expect(rp.rows[0].source).toBe('held_funds_application')
    expect(rp.rows[0].funds_application).toBe(item1)
    const run = await admin.query(`select state from deedbox.application_run where id = $1`, [
      run1,
    ])
    expect(run.rows[0].state).toBe('completed')
    const consumed = await admin.query(
      `select deedbox.entitlement_status(e.id) as status from deedbox.entitlement e
        where e.bill = $1`,
      [bill1],
    )
    expect(consumed.rows[0].status).toBe('exhausted')
    const posted = await admin.query(
      `select 1 from deedbox.register_entry
        where event_kind = 'money.transaction_posted' and matter = $1`,
      [fx.matter],
    )
    expect(posted.rowCount).toBeGreaterThan(0)
  })

  it('a posting refusal blocks the payment, refuses the item, and lands in the refusal register', async () => {
    const m2 = await newMatter('Bridge shortfall host')
    const ledger2 = await admin.query(
      `insert into deedbox.matter_ledger (account, matter) values ($1, $2) returning id`,
      [fx.account, m2],
    )
    const bill2 = await issuedBillOn(m2, 10) // 400.00
    await fundLedger(ledger2.rows[0].id as number, fx.account, 100)
    await admin.query(
      `insert into deedbox.entitlement (matter_ledger, basis_kind, bill, amount, notice_required)
       values ($1, 'rendered_bill', $2, 400, false)`,
      [ledger2.rows[0].id, bill2],
    )
    const preview = await previewHeldFundsApplication(P, { matter: m2 })
    expect(cents(preview.executable[0].amount)).toBe(10000) // capped by available
    await commitHeldFundsApplication(P, { run: preview.run })
    const item = await admin.query(
      `select id, money_payment from deedbox.funds_application where run = $1`,
      [preview.run],
    )
    // between commit and approval, an earmark eats the whole balance
    await admin.query(
      `insert into deedbox.earmark (matter_ledger, amount, purpose, placed_by)
       values ($1, 100, 'settlement holdback', $2)`,
      [ledger2.rows[0].id, fx.staff],
    )
    await expect(
      authoriseHeldFundsItem(S, { item: item.rows[0].id, decision: 'approve' }),
    ).rejects.toThrow(MoneyRefusal)

    const after = await admin.query(
      `select item_state, refusal_reason from deedbox.funds_application where id = $1`,
      [item.rows[0].id],
    )
    expect(after.rows[0].item_state).toBe('refused')
    expect(after.rows[0].refusal_reason).toBeTruthy()
    const pay = await admin.query(`select state from deedbox.money_payment where id = $1`, [
      item.rows[0].money_payment,
    ])
    expect(pay.rows[0].state).toBe('blocked')
    const k11 = await admin.query(
      `select refusal_reason from deedbox.refused_operation
        where matter_ledger = $1 order by id desc limit 1`,
      [ledger2.rows[0].id],
    )
    expect(k11.rowCount).toBe(1)
    const run = await admin.query(`select state from deedbox.application_run where id = $1`, [
      preview.run,
    ])
    expect(run.rows[0].state).toBe('completed_with_refusals')
  })

  it('a rejection refuses the item with the authoriser\'s reason', async () => {
    const m3 = await newMatter('Bridge rejection host')
    const ledger3 = await admin.query(
      `insert into deedbox.matter_ledger (account, matter) values ($1, $2) returning id`,
      [fx.account, m3],
    )
    const bill3 = await issuedBillOn(m3, 5) // 200.00
    await fundLedger(ledger3.rows[0].id as number, fx.account, 500)
    await admin.query(
      `insert into deedbox.entitlement (matter_ledger, basis_kind, bill, amount, notice_required)
       values ($1, 'rendered_bill', $2, 200, false)`,
      [ledger3.rows[0].id, bill3],
    )
    const preview = await previewHeldFundsApplication(P, { matter: m3 })
    await commitHeldFundsApplication(P, { run: preview.run })
    const item = await admin.query(
      `select id, money_payment from deedbox.funds_application where run = $1`,
      [preview.run],
    )
    const r = await authoriseHeldFundsItem(S, {
      item: item.rows[0].id,
      decision: 'reject',
      note: 'query the disbursement first',
    })
    expect(r).toEqual({ executed: false, state: 'rejected' })
    const after = await admin.query(
      `select item_state, refusal_reason from deedbox.funds_application where id = $1`,
      [item.rows[0].id],
    )
    expect(after.rows[0].item_state).toBe('refused')
    expect(after.rows[0].refusal_reason).toContain('query the disbursement')
    const pay = await admin.query(
      `select state, rejection_reason from deedbox.money_payment where id = $1`,
      [item.rows[0].money_payment],
    )
    expect(pay.rows[0].state).toBe('rejected')
    // the ledger never moved
    const balance = await admin.query(`select deedbox.ledger_balance($1) as b`, [
      ledger3.rows[0].id,
    ])
    expect(cents(balance.rows[0].b)).toBe(50000)
  })
})

describe('unallocated-remainder routing', () => {
  it('the engine default compels nothing', async () => {
    const r = await routeUnallocatedRemainders(P)
    expect(r.routed).toEqual([])
  })

  it('a declared rule routes full remainders through the one bridge transaction', async () => {
    // a fresh payer whose only open ledger-bearing matter is unambiguous
    const payer = await admin.query(
      `insert into deedbox.party (kind, display_name) values ('person','Remainder Payer bset') returning id`,
    )
    await admin.query(
      `insert into deedbox.party_name (party, name_kind, full_name)
       values ($1, 'current', 'Remainder Payer bset')`,
      [payer.rows[0].id],
    )
    const m = await createMatter(P, {
      title: 'Remainder home',
      clientParty: payer.rows[0].id as number,
      responsibleLawyer: fx.staff,
      office: fx.office,
      practiceArea: fx.practiceArea,
    })
    const ledger = await admin.query(
      `insert into deedbox.matter_ledger (account, matter) values ($1, $2) returning id`,
      [fx.account, m.id],
    )
    await issuedBillOn(m.id, 5) // issue evidence for the accountable author

    const pv = await admin.query(
      `insert into deedbox.pack_version (pack, version)
       select id, '0.0.2' from deedbox.country_pack where code = 'xbse' returning id, pack`,
    )
    await admin.query(
      `insert into deedbox.pack_declaration (pack_version, rule_point, kind, body)
       values ($1, 'money.unallocated_routing', 'threshold_rule', '{"after_days": 0, "min_amount": 50}')`,
      [pv.rows[0].id],
    )
    await admin.query(`update deedbox.country_pack set active_version = $1 where id = $2`, [
      pv.rows[0].id,
      pv.rows[0].pack,
    ])

    const pay = await recordPayment(P, {
      payerParty: payer.rows[0].id as number,
      receivedDate: dateStr(1),
      amount: 200,
      method: 'bank_transfer',
    })
    // a partially-allocated payment must NOT route
    const partial = await recordPayment(P, {
      payerParty: payer.rows[0].id as number,
      receivedDate: dateStr(1),
      amount: 100,
      method: 'bank_transfer',
    })
    const partialBill = await admin.query(
      `select b.id from deedbox.bill b where b.matter = $1 and b.state = 'issued'`,
      [m.id],
    )
    await allocatePayment(P, {
      payment: partial.id,
      allocations: [{ bill: partialBill.rows[0].id, amount: 40 }],
    })

    const r = await routeUnallocatedRemainders(P)
    const routedMine = r.routed.find((x) => x.payment === pay.id)
    expect(routedMine).toBeDefined()
    expect(cents(routedMine!.amount)).toBe(20000)
    expect(r.routed.find((x) => x.payment === partial.id)).toBeUndefined()

    const mirror = await admin.query(
      `select id, reason from deedbox.receivable_payment where reverses = $1`,
      [pay.id],
    )
    expect(mirror.rowCount).toBe(1)
    expect(mirror.rows[0].reason).toContain('routed to client money')
    const balance = await admin.query(`select deedbox.ledger_balance($1) as b`, [
      ledger.rows[0].id,
    ])
    expect(cents(balance.rows[0].b)).toBe(20000)
    const receipt = await admin.query(
      `select receipt_number, payer_party from deedbox.money_receipt where id = $1`,
      [routedMine!.receipt],
    )
    expect(receipt.rows[0].receipt_number).toMatch(/^R-/)
    expect(receipt.rows[0].payer_party).toBe(payer.rows[0].id)
  })
})

describe('the firm-wide held-funds sweep', () => {
  it('finds a payable bill nobody claimed, records the claim once, and leaves prepared transfers alone', async () => {
    const mA = await newMatter('Sweep host A')
    const ledgerA = (
      await admin.query(
        `insert into deedbox.matter_ledger (account, matter) values ($1, $2) returning id`,
        [fx.account, mA],
      )
    ).rows[0].id as number
    const billA = await issuedBillOn(mA, 12) // 480.00
    await fundLedger(ledgerA, fx.account, 800)
    const before = await admin.query(
      `select count(*)::int as n from deedbox.entitlement where bill = $1`,
      [billA],
    )
    expect(before.rows[0].n).toBe(0)

    // the sweep discovers the bill with NO entitlement, records the claim,
    // and previews the run — capped at what the bill still owes
    const r1 = await prepareFirmWideHeldFunds(P)
    expect(r1.executable).toBeGreaterThanOrEqual(1)
    const item1 = await admin.query(
      `select amount, item_state from deedbox.funds_application where run = $1 and bill = $2`,
      [r1.run, billA],
    )
    expect(item1.rowCount).toBe(1)
    expect(cents(item1.rows[0].amount as string)).toBe(48000)
    expect(item1.rows[0].item_state).toBe('previewed')
    const claim = await admin.query(
      `select count(*)::int as n from deedbox.entitlement
        where bill = $1 and basis_kind = 'rendered_bill' and cancelled_at is null`,
      [billA],
    )
    expect(claim.rows[0].n).toBe(1)

    // a second sweep never doubles the claim; the bill is still executable
    const r2 = await prepareFirmWideHeldFunds(P)
    const claim2 = await admin.query(
      `select count(*)::int as n from deedbox.entitlement where bill = $1`,
      [billA],
    )
    expect(claim2.rows[0].n).toBe(1)
    const item2 = await admin.query(
      `select 1 from deedbox.funds_application where run = $1 and bill = $2`,
      [r2.run, billA],
    )
    expect(item2.rowCount).toBe(1)

    // once the run commits (the transfer parks awaiting authorisation), the
    // sweep leaves the bill alone — re-running never queues the money twice
    await commitHeldFundsApplication(P, { run: r2.run })
    const parked = await admin.query(
      `select item_state from deedbox.funds_application where run = $1 and bill = $2`,
      [r2.run, billA],
    )
    expect(parked.rows[0].item_state).toBe('awaiting_authorisation')
    const r3 = await prepareFirmWideHeldFunds(P).then(
      (x) => x as { run: number } | Error,
      (e: unknown) => e as Error,
    )
    if (r3 instanceof Error) {
      expect((r3 as { code?: string }).code).toBe('nothing_payable')
    } else {
      const again = await admin.query(
        `select 1 from deedbox.funds_application where run = $1 and bill = $2`,
        [r3.run, billA],
      )
      expect(again.rowCount).toBe(0)
    }
  })

  it('a bill on a matter holding no available money is not swept', async () => {
    const mB = await newMatter('Sweep host B, unfunded')
    const billB = await issuedBillOn(mB, 5)
    const r = await prepareFirmWideHeldFunds(P).then(
      (x) => x as { run: number } | Error,
      (e: unknown) => e as Error,
    )
    if (!(r instanceof Error)) {
      const item = await admin.query(
        `select 1 from deedbox.funds_application where run = $1 and bill = $2`,
        [r.run, billB],
      )
      expect(item.rowCount).toBe(0)
    }
    const claim = await admin.query(
      `select count(*)::int as n from deedbox.entitlement where bill = $1`,
      [billB],
    )
    expect(claim.rows[0].n).toBe(0)
  })
})

describe('despatch filing — the emailed bill lands on the matter', () => {
  it('a delivered despatch files the exact attachment, attributed to the sender; a storage outage never unsends', async () => {
    const mD = await newMatter('Despatch filing host')
    const billD = await issuedBillOn(mD, 8) // 320.00
    await sendBill(P, { bill: billD, recipients: ['filed.bset@example.test'], confirmed: true })
    const msg = await admin.query(
      `select id from deedbox.outbound_message
        where purpose = 'bill_despatch' and related = $1 and recipient = 'filed.bset@example.test'`,
      [billD],
    )
    expect(msg.rowCount).toBe(1)
    const msgId = msg.rows[0].id as number

    const storedBytes: Record<string, Buffer> = {}
    setDocumentByteStore(async ({ matter, filename, bytes }) => {
      const ref = `bset-despatch/${matter}/${filename}/${Object.keys(storedBytes).length}`
      storedBytes[ref] = bytes
      return { storageRef: ref, contentType: 'application/pdf' }
    })
    try {
      const fakePdfBytes = Buffer.from('%PDF-1.4 settle despatch filing proof')
      await dispatchOutboundQueue(
        P,
        async (m) => {
          if (m.purpose === 'bill_despatch') {
            return {
              attachments: [
                {
                  filename: 'Tax Invoice TEST-001.pdf',
                  contentType: 'application/pdf',
                  contentBase64: fakePdfBytes.toString('base64'),
                },
              ],
            }
          }
        },
        { limit: 200 },
      )
      const sentRow = await admin.query(
        `select state from deedbox.outbound_message where id = $1`,
        [msgId],
      )
      expect(sentRow.rows[0].state).toBe('sent')
      const df = await admin.query(
        `select id, matter, filename, source, size_bytes, storage_ref, uploaded_by
           from deedbox.document_file where external_ref = $1`,
        [`outbound_despatch:${msgId}`],
      )
      expect(df.rowCount).toBe(1)
      expect(df.rows[0].matter).toBe(mD)
      expect(df.rows[0].source).toBe('outbound_despatch')
      expect(df.rows[0].filename).toBe('Tax Invoice TEST-001.pdf')
      expect(Number(df.rows[0].size_bytes)).toBe(fakePdfBytes.length)
      expect(df.rows[0].uploaded_by).toBe(fx.staff)
      expect(storedBytes[df.rows[0].storage_ref as string]?.equals(fakePdfBytes)).toBe(true)
      const head = await admin.query(
        `select title, description, created_by from deedbox.document where current_file = $1`,
        [df.rows[0].id],
      )
      expect(head.rowCount).toBe(1)
      expect(head.rows[0].title).toBe('Tax Invoice TEST-001')
      expect(head.rows[0].description).toContain('filed.bset@example.test')
      expect(head.rows[0].created_by).toBe(fx.staff)
    } finally {
      setDocumentByteStore(null)
    }

    // the outage half: no byte store bound — the message still sends; the
    // filing failure is a register note, never a rolled-back despatch
    await sendBill(P, { bill: billD, recipients: ['filed2.bset@example.test'], confirmed: true })
    const msg2 = await admin.query(
      `select id from deedbox.outbound_message
        where purpose = 'bill_despatch' and related = $1 and recipient = 'filed2.bset@example.test'`,
      [billD],
    )
    const msg2Id = msg2.rows[0].id as number
    await dispatchOutboundQueue(
      P,
      async (m) => {
        if (m.purpose === 'bill_despatch') {
          return {
            attachments: [
              {
                filename: 'Tax Invoice TEST-001.pdf',
                contentType: 'application/pdf',
                contentBase64: Buffer.from('%PDF-1.4 outage half').toString('base64'),
              },
            ],
          }
        }
      },
      { limit: 50 },
    )
    const sent2 = await admin.query(`select state from deedbox.outbound_message where id = $1`, [
      msg2Id,
    ])
    expect(sent2.rows[0].state).toBe('sent')
    const df2 = await admin.query(
      `select 1 from deedbox.document_file where external_ref = $1`,
      [`outbound_despatch:${msg2Id}`],
    )
    expect(df2.rowCount).toBe(0)
    const note = await admin.query(
      `select detail from deedbox.register_entry
        where subject_type = 'outbound_message' and subject = $1
          and detail ? 'despatch_filing_failed'
        order by id desc limit 1`,
      [msg2Id],
    )
    expect(note.rowCount).toBe(1)
  })
})

describe('the consolidated run requisition', () => {
  it('one form covers the completed transfers with numbers, approvals and the total; an uncompleted run refuses', async () => {
    const mR = await newMatter('Requisition host')
    const ledgerR = (
      await admin.query(
        `insert into deedbox.matter_ledger (account, matter) values ($1, $2) returning id`,
        [fx.account, mR],
      )
    ).rows[0].id as number
    const billR = await issuedBillOn(mR, 10) // 400.00
    await fundLedger(ledgerR, fx.account, 1000)
    await admin.query(
      `insert into deedbox.entitlement (matter_ledger, basis_kind, bill, amount, notice_required)
       values ($1, 'rendered_bill', $2, 400, false)`,
      [ledgerR, billR],
    )
    const preview = await previewHeldFundsApplication(P, { matter: mR })
    await commitHeldFundsApplication(P, { run: preview.run })
    const item = await admin.query(
      `select id from deedbox.funds_application where run = $1`,
      [preview.run],
    )
    const done = await authoriseHeldFundsItem(S, { item: item.rows[0].id, decision: 'approve' })
    expect(done).toMatchObject({ executed: true })

    const req = await heldFundsRunRequisition(P, preview.run)
    expect(req.items.length).toBe(1)
    const it1 = req.items[0]
    expect(String(it1.bill_number)).toBeTruthy()
    expect(String(it1.receipt_number)).toMatch(/^OR-/)
    expect(it1.payment_number).toBeTruthy()
    expect(cents(it1.amount as string)).toBe(40000)
    expect(Array.isArray(it1.approvals)).toBe(true)
    expect((it1.approvals as unknown[]).length).toBeGreaterThanOrEqual(1)
    expect(it1.account_name).toBeTruthy()
    expect(req.excluded).toBe(0)
    expect(req.regional.currency).toBeTruthy()
    const total = req.items.reduce((s, i) => s + Number(i.amount), 0)
    expect(Math.round(total * 100)).toBe(40000)

    // the renderer produces the one-form document from exactly these facts
    const html = runRequisitionDocumentHtml(req)
    expect(html).toContain('EFT Requisition')
    expect(html).toContain(String(it1.receipt_number))
    expect(html).toContain('one transfer to the firm')

    // a run with nothing completed refuses typed — the requisition never
    // shows money that has not moved
    const second = await previewHeldFundsApplication(P, { matter: mR })
    await expect(heldFundsRunRequisition(P, second.run)).rejects.toMatchObject({
      code: 'nothing_completed',
    })
  })
})
