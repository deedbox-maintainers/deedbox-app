import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import type { Pool } from 'pg'
import { closePool } from '@/lib/db'
import type { Principal } from '@/lib/db'
import { createMatter } from '@/lib/ops/matters'
import {
  addStaffRate,
  createTimeEntry,
  createDisbursement,
  replacePayerSet,
  createDraftBillGroup,
  abandonDraftGroup,
  submitForApproval,
  sendBackToDraft,
  issueBillGroup,
  recordPayment,
  allocatePayment,
  unallocatePayment,
  correctPayment,
  createCreditNote,
  applyCredit,
  writeOffBill,
  raiseDispute,
  resolveDispute,
  placeBillingHold,
  releaseBillingHold,
} from '@/lib/ops/billing'
import { splitByShares } from '@/lib/ops/billing/drafting'
import { makeAdminPool, buildFixture, setFirmSetting, type Fixture } from './helpers'

let admin: Pool
let fx: Fixture
let P: Principal

beforeAll(async () => {
  admin = makeAdminPool()
  fx = await buildFixture(admin, 'bis')
  P = { kind: 'staff', id: fx.staff, firm: fx.firm }
  await addStaffRate(P, { staff: fx.staff, rate: 400, effectiveFrom: '2020-01-01' })
})

afterAll(async () => {
  await closePool()
  await admin.end()
})

describe('largest-remainder splitting', () => {
  it('is exact to the cent for awkward shares', () => {
    const parts = splitByShares(100, [33.33, 33.33, 33.34])
    expect(parts.reduce((a, b) => a + b, 0)).toBeCloseTo(100, 10)
    const odd = splitByShares(0.01, [50, 50])
    expect(odd.reduce((a, b) => a + b, 0)).toBeCloseTo(0.01, 10)
  })
})

describe('drafting, approval and issue', () => {
  let matter: number
  let te1: number
  let te2: number
  let disb: number

  beforeAll(async () => {
    const m = await createMatter(P, {
      title: 'Issue matter bis',
      clientParty: fx.clientParty,
      responsibleLawyer: fx.staff,
      office: fx.office,
      practiceArea: fx.practiceArea,
    })
    matter = m.id
    te1 = (
      await createTimeEntry(P, {
        matter,
        workDate: '2026-08-13',
        units: 10, // 400.00
        narrative: 'issue test work one',
      })
    ).id
    te2 = (
      await createTimeEntry(P, {
        matter,
        workDate: '2026-08-13',
        units: 5, // 200.00
        narrative: 'issue test work two',
      })
    ).id
    disb = (
      await createDisbursement(P, {
        matter,
        incurredDate: '2026-08-13',
        description: 'search fee',
        amount: 33.55,
        taxTreatment: 'standard',
      })
    ).id
  })

  it('drafts a group: items lock on their lines, a second draft loses', async () => {
    const g = await createDraftBillGroup(P, {
      matter,
      timeEntries: [te1, te2],
      disbursements: [disb],
    })
    expect(g.bills.length).toBe(1) // single payer: the client
    const items = await admin.query(
      `select billed_state, bill_line from deedbox.time_entry where id = any($1)`,
      [[te1, te2]],
    )
    for (const r of items.rows) {
      expect(r.billed_state).toBe('on_draft')
      expect(r.bill_line).not.toBeNull()
    }
    await expect(
      createDraftBillGroup(P, { matter, timeEntries: [te1] }),
    ).rejects.toMatchObject({ code: 'not_unbilled' })

    // abandon releases everything, then re-draft for the rest of the tests
    await abandonDraftGroup(P, { group: g.group })
    const released = await admin.query(
      `select billed_state, bill_line from deedbox.time_entry where id = $1`,
      [te1],
    )
    expect(released.rows[0].billed_state).toBe('unbilled')
    expect(released.rows[0].bill_line).toBeNull()
  })

  it('splits sibling bills by payer shares with the residual recorded to the cent', async () => {
    const other = await admin.query(
      `insert into deedbox.party (kind, display_name) values ('organisation', 'Second Payer bis') returning id`,
    )
    await admin.query(
      `insert into deedbox.party_name (party, name_kind, full_name) values ($1, 'current', 'Second Payer bis')`,
      [other.rows[0].id],
    )
    await replacePayerSet(P, {
      matter,
      payers: [
        { party: fx.clientParty, sharePct: 66.67 },
        { party: other.rows[0].id, sharePct: 33.33 },
      ],
    })
    const g = await createDraftBillGroup(P, { matter, timeEntries: [te1] }) // 400.00
    expect(g.bills.length).toBe(2)
    const lines = await admin.query(
      `select l.amount from deedbox.bill_line l where l.bill = any($1) order by l.amount desc`,
      [g.bills],
    )
    const amounts = lines.rows.map((r) => Number(r.amount))
    expect(Math.round((amounts[0] + amounts[1]) * 100)).toBe(40000) // exact
    await abandonDraftGroup(P, { group: g.group })
    await replacePayerSet(P, { matter, payers: [{ party: fx.clientParty, sharePct: 100 }] })
  })

  it('approval: submit needs the setting; send-back returns to draft', async () => {
    const g = await createDraftBillGroup(P, { matter, timeEntries: [te1] })
    await expect(submitForApproval(P, { group: g.group })).rejects.toMatchObject({
      code: 'approval_off',
    })
    await setFirmSetting(admin, 'bill.approval_required', true, 60)
    try {
      await submitForApproval(P, { group: g.group })
      const pending = await admin.query(
        `select state from deedbox.bill where bill_group = $1`,
        [g.group],
      )
      expect(pending.rows[0].state).toBe('pending_approval')
      await sendBackToDraft(P, { group: g.group, note: 'trim the narrative' })
      const back = await admin.query(`select state from deedbox.bill where bill_group = $1`, [
        g.group,
      ])
      expect(back.rows[0].state).toBe('draft')
    } finally {
      await setFirmSetting(admin, 'bill.approval_required', false, 30)
      await abandonDraftGroup(P, { group: g.group })
    }
  })

  it('issues: gapless number, one issue_total, items billed, attribution, register', async () => {
    const g = await createDraftBillGroup(P, {
      matter,
      timeEntries: [te1, te2],
      disbursements: [disb],
      manualLines: [{ description: 'file retrieval', amount: 15 }],
    })
    const r = await issueBillGroup(P, { group: g.group })
    expect(r.bills.length).toBe(1)
    expect(r.bills[0].billNumber).toMatch(/^B-\d{6}$/)
    expect(r.bills[0].total).toBe(648.55) // 400 + 200 + 33.55 + 15

    const bill = await admin.query(
      `select state, issue_date, due_date, terms_days_applied, rendered_artefact
         from deedbox.bill where id = $1`,
      [r.bills[0].id],
    )
    expect(bill.rows[0].state).toBe('issued')
    expect(bill.rows[0].terms_days_applied).toBe(14) // the shipped setting
    expect(bill.rows[0].rendered_artefact).not.toBeNull()

    const journal = await admin.query(
      `select entry_kind, signed_amount from deedbox.bill_journal_entry where bill = $1`,
      [r.bills[0].id],
    )
    expect(journal.rowCount).toBe(1)
    expect(journal.rows[0].entry_kind).toBe('issue_total')
    expect(Number(journal.rows[0].signed_amount)).toBe(648.55)

    const outstanding = await admin.query(`select deedbox.bill_outstanding($1) as o`, [
      r.bills[0].id,
    ])
    expect(Number(outstanding.rows[0].o)).toBe(648.55)

    const billedItems = await admin.query(
      `select count(*)::int as n from deedbox.time_entry
        where id = any($1) and billed_state = 'billed'`,
      [[te1, te2]],
    )
    expect(billedItems.rows[0].n).toBe(2)

    const attribution = await admin.query(
      `select staff, billed_share from deedbox.bill_attribution
        where bill = $1 and superseded_at is null`,
      [r.bills[0].id],
    )
    // all time by fx.staff; disbursement + manual to the responsible (same person)
    expect(attribution.rowCount).toBe(1)
    expect(Number(attribution.rows[0].billed_share)).toBe(648.55)

    const reg = await admin.query(
      `select count(*)::int as n from deedbox.register_entry
        where event_kind = 'bill.issued' and subject = $1`,
      [r.bills[0].id],
    )
    expect(reg.rows[0].n).toBe(1)
  })

  it('payments: gapless receipts, capped allocations, reversal, correcting mirror', async () => {
    const issued = await admin.query(
      `select id, deedbox.bill_outstanding(id) as o from deedbox.bill
        where matter = $1 and state = 'issued' order by id limit 1`,
      [matter],
    )
    const billA = issued.rows[0].id as number
    const startOutstanding = Number(issued.rows[0].o) // 648.55

    const pay = await recordPayment(P, {
      payerParty: fx.clientParty,
      receivedDate: '2026-08-13',
      amount: 300,
      method: 'bank_transfer',
    })
    expect(pay.receiptNumber).toMatch(/^OR-\d{6}$/)

    await allocatePayment(P, { payment: pay.id, allocations: [{ bill: billA, amount: 250 }] })
    let o = await admin.query(`select deedbox.bill_outstanding($1) as o`, [billA])
    expect(Math.round(Number(o.rows[0].o) * 100)).toBe(Math.round((startOutstanding - 250) * 100))

    // the fan mirrors the bill's attribution
    const fan = await admin.query(
      `select ca.amount from deedbox.collection_attribution ca
         join deedbox.bill_journal_entry j on j.id = ca.allocation_entry
        where j.bill = $1 and j.entry_kind = 'payment_allocation'`,
      [billA],
    )
    expect(Number(fan.rows[0].amount)).toBe(250)

    // over the remainder: only 50 remains on the payment
    await expect(
      allocatePayment(P, { payment: pay.id, allocations: [{ bill: billA, amount: 100 }] }),
    ).rejects.toMatchObject({ code: 'over_allocated' })
    // beyond the bill's outstanding: a 1000 payment cannot land 999 on it
    const big = await recordPayment(P, {
      receivedDate: '2026-08-13',
      amount: 1000,
      method: 'bank_transfer',
    })
    await expect(
      allocatePayment(P, { payment: big.id, allocations: [{ bill: billA, amount: 999 }] }),
    ).rejects.toMatchObject({ code: 'beyond_outstanding' })

    // reverse the 250 allocation: outstanding restores, mirror fan lands
    const entry = await admin.query(
      `select id from deedbox.bill_journal_entry
        where bill = $1 and entry_kind = 'payment_allocation' order by id limit 1`,
      [billA],
    )
    await expect(
      unallocatePayment(P, { allocationEntry: entry.rows[0].id, reason: '' }),
    ).rejects.toMatchObject({ code: 'reason_required' })
    await unallocatePayment(P, { allocationEntry: entry.rows[0].id, reason: 'wrong bill' })
    o = await admin.query(`select deedbox.bill_outstanding($1) as o`, [billA])
    expect(Number(o.rows[0].o)).toBe(startOutstanding)
    await expect(
      unallocatePayment(P, { allocationEntry: entry.rows[0].id, reason: 'again' }),
    ).rejects.toMatchObject({ code: 'already_reversed' })

    // the correcting mirror: re-allocate, then correct — allocations reverse,
    // the mirror takes its own gapless number, the pair is derived-cancelled
    await allocatePayment(P, { payment: pay.id, allocations: [{ bill: billA, amount: 300 }] })
    const corr = await correctPayment(P, { payment: pay.id, reason: 'receipted to the wrong payer' })
    expect(corr.receiptNumber).toMatch(/^OR-\d{6}$/)
    expect(corr.receiptNumber).not.toBe(pay.receiptNumber)
    o = await admin.query(`select deedbox.bill_outstanding($1) as o`, [billA])
    expect(Number(o.rows[0].o)).toBe(startOutstanding)
    const mirror = await admin.query(
      `select reverses from deedbox.receivable_payment where id = $1`,
      [corr.mirror],
    )
    expect(mirror.rows[0].reverses).toBe(pay.id)
    await expect(
      allocatePayment(P, { payment: pay.id, allocations: [{ bill: billA, amount: 10 }] }),
    ).rejects.toMatchObject({ code: 'cancelled' })
  })

  it('credit notes, write-offs, disputes and holds work the journal honestly', async () => {
    const m2 = await createMatter(P, {
      title: 'Post-issue matter bis',
      clientParty: fx.clientParty,
      responsibleLawyer: fx.staff,
      office: fx.office,
      practiceArea: fx.practiceArea,
    })
    const entry = await createTimeEntry(P, {
      matter: m2.id,
      workDate: '2026-08-13',
      units: 25, // 25 × 6 × 400 / 60 = 1000.00
      narrative: 'post-issue base work',
    })
    const g = await createDraftBillGroup(P, { matter: m2.id, timeEntries: [entry.id] })
    const issued = await issueBillGroup(P, { group: g.group })
    const bill = issued.bills[0].id

    // credit note: gapless number; applications capped by note and outstanding
    const note = await createCreditNote(P, { bill, amount: 300, reason: 'fee concession' })
    expect(note.creditNumber).toMatch(/^CN-\d{6}$/)
    await applyCredit(P, { note: note.id, amount: 250 })
    let o = await admin.query(`select deedbox.bill_outstanding($1) as o`, [bill])
    expect(Number(o.rows[0].o)).toBe(750)
    await expect(applyCredit(P, { note: note.id, amount: 100 })).rejects.toMatchObject({
      code: 'beyond_note',
    })

    // write-off the remainder; beyond-outstanding refused
    await expect(
      writeOffBill(P, { bill, amount: 800, reason: 'too much' }),
    ).rejects.toMatchObject({ code: 'beyond_outstanding' })
    await writeOffBill(P, { bill, amount: 750, reason: 'commercial decision' })
    o = await admin.query(`select deedbox.bill_outstanding($1) as o`, [bill])
    expect(Number(o.rows[0].o)).toBe(0)

    // disputes: one open, detail and note never negotiable
    const d = await raiseDispute(P, { bill, detail: 'client queries the search fee' })
    await expect(raiseDispute(P, { bill, detail: 'second' })).rejects.toMatchObject({
      code: 'already_disputed',
    })
    await expect(resolveDispute(P, { dispute: d.id, resolutionNote: ' ' })).rejects.toMatchObject({
      code: 'note_required',
    })
    await resolveDispute(P, { dispute: d.id, resolutionNote: 'explained and accepted' })
    const resolved = await admin.query(
      `select resolved_at from deedbox.bill_dispute where id = $1`,
      [d.id],
    )
    expect(resolved.rows[0].resolved_at).not.toBeNull()

    // holds: the matter mirror follows both ways; the row is history forever
    const hold = await placeBillingHold(P, { matter: m2.id, reason: 'awaiting costs agreement' })
    let mirror = await admin.query(`select billing_hold from deedbox.matter where id = $1`, [m2.id])
    expect(mirror.rows[0].billing_hold).toBe(true)
    await expect(
      placeBillingHold(P, { matter: m2.id, reason: 'again' }),
    ).rejects.toMatchObject({ code: 'already_held' })
    await releaseBillingHold(P, { hold: hold.id })
    mirror = await admin.query(`select billing_hold from deedbox.matter where id = $1`, [m2.id])
    expect(mirror.rows[0].billing_hold).toBe(false)
    const kept = await admin.query(`select count(*)::int as n from deedbox.billing_hold where id = $1`, [
      hold.id,
    ])
    expect(kept.rows[0].n).toBe(1)
  })

  it('a refused issue consumes no bill number', async () => {
    const spare = await createTimeEntry(P, {
      matter,
      workDate: '2026-08-13',
      units: 1,
      narrative: 'spare unit',
    })
    const g = await createDraftBillGroup(P, { matter, timeEntries: [spare.id] })
    await expect(
      issueBillGroup(P, { group: g.group, issueDate: '2030-01-01' }),
    ).rejects.toMatchObject({ code: 'future_issue_date' })

    const issued = await issueBillGroup(P, { group: g.group })
    const seqOf = (n: string) => Number(n.slice(n.lastIndexOf('-') + 1))
    // the previous issued bill took the last number; the refusal took none
    const prev = await admin.query(
      `select bill_number from deedbox.bill
        where state = 'issued' and id <> $1 and bill_number is not null
        order by id desc limit 1`,
      [issued.bills[0].id],
    )
    expect(seqOf(issued.bills[0].billNumber)).toBe(seqOf(prev.rows[0].bill_number as string) + 1)

    const stillDraft = await admin.query(
      `select state from deedbox.bill_group where id = $1`,
      [g.group],
    )
    expect(stillDraft.rows[0].state).toBe('issued')
  })
})
