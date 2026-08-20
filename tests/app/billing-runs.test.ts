// Billing runs, draft edits and write-downs, statements, and interest
// (including the 0021 proposal parking).
//
// ORDERING CONTRACT: this file sorts AFTER billing-issue.test.ts (vitest
// runs suites alphabetically in one fork). Both windows of the global
// bill.approval_required setting use effective stamps newer than that
// suite's, and this suite restores false in a finally — the settings
// history is database-global and append-only.

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import type { Pool } from 'pg'
import { closePool } from '@/lib/db'
import type { Principal } from '@/lib/db'
import { OperationRefused } from '@/lib/db'
import { createMatter } from '@/lib/ops/matters'
import { closeMatter } from '@/lib/ops/matters/matterLifecycle'
import { recordMoneyReceipt, authoriseMoneyPayment, executeMoneyPayment } from '@/lib/ops/money'
import {
  applyHeldFundsToRunBills,
  applyHeldFundsToBills,
  executeHeldFundsPayment,
  completeExecutedHeldFundsItem,
  authoriseHeldFundsItem,
  heldFundsRunAba,
  savePaymentDetails,
  addStaffRate,
  createTimeEntry,
  createDraftBillGroup,
  removeDraftLine,
  writeDownDraftItem,
  addManualDraftLine,
  submitForApproval,
  issueBillGroup,
  replacePayerSet,
  createBillingRun,
  issueBillingRun,
  abandonBillingRun,
  placeBillingHold,
  generateStatement,
  allocateStatementPayment,
  recordPayment,
  raiseDispute,
  saveInterestPolicy,
  previewInterestCharge,
  addInterestCharge,
  generateInterestProposals,
  approveInterestProposal,
  dismissInterestProposal,
} from '@/lib/ops/billing'
import { makeAdminPool, buildFixture, addStaff, setFirmSetting, type Fixture } from './helpers'

let admin: Pool
let fx: Fixture
let P: Principal

/** ISO date n days before today (UTC — matches the scratch DB's current_date). */
function dateStr(daysAgo: number): string {
  return new Date(Date.now() - daysAgo * 86400000).toISOString().slice(0, 10)
}
function diffDays(from: string, to: string): number {
  return Math.round((Date.parse(to) - Date.parse(from)) / 86400000)
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

/** One unbilled time entry worth `units × 40.00` on the matter. */
async function newEntry(matter: number, units: number): Promise<number> {
  const e = await createTimeEntry(P, {
    matter,
    workDate: dateStr(1),
    units,
    narrative: `runs suite work ${matter}-${units}`,
  })
  return e.id
}

beforeAll(async () => {
  admin = makeAdminPool()
  fx = await buildFixture(admin, 'brun')
  P = { kind: 'staff', id: fx.staff, firm: fx.firm }
  await addStaffRate(P, { staff: fx.staff, rate: 400, effectiveFrom: '2020-01-01' })
})

afterAll(async () => {
  await closePool()
  await admin.end()
})

describe('draft edits and write-downs', () => {
  it('removes a line: item released, matter_total recomputed', async () => {
    const m = await newMatter('H2 remove')
    const te1 = await newEntry(m, 10) // 400.00
    const te2 = await newEntry(m, 5) // 200.00
    const g = await createDraftBillGroup(P, { matter: m, timeEntries: [te1, te2] })
    await removeDraftLine(P, { group: g.group, position: 1 })
    const item = await admin.query(
      `select billed_state, bill_line from deedbox.time_entry where id = $1`,
      [te1],
    )
    expect(item.rows[0].billed_state).toBe('unbilled')
    expect(item.rows[0].bill_line).toBeNull()
    const grp = await admin.query(
      `select matter_total from deedbox.bill_group where id = $1`,
      [g.group],
    )
    expect(cents(grp.rows[0].matter_total)).toBe(20000)
  })

  it('writes an item down across a 60/40 sibling set, exact to the cent, and issues on the edited shape', async () => {
    const m = await newMatter('H2 writedown')
    const outsider = await admin.query(
      `insert into deedbox.party (kind, display_name) values ('organisation','Insurer brun') returning id`,
    )
    await admin.query(
      `insert into deedbox.party_name (party, name_kind, full_name) values ($1,'current','Insurer brun')`,
      [outsider.rows[0].id],
    )
    await replacePayerSet(P, {
      matter: m,
      payers: [
        { party: fx.clientParty, sharePct: 60 },
        { party: outsider.rows[0].id as number, sharePct: 40 },
      ],
    })
    const te = await newEntry(m, 10) // 400.00 → siblings 240.00 / 160.00
    const g = await createDraftBillGroup(P, { matter: m, timeEntries: [te] })
    expect(g.bills.length).toBe(2)

    await writeDownDraftItem(P, {
      group: g.group,
      position: 1,
      writtenDownTo: 300.01,
      reason: 'agreed reduction',
    })
    const lines = await admin.query(
      `select l.amount, l.written_down_to, l.original_value, l.write_down_reason
         from deedbox.bill_line l join deedbox.bill b on b.id = l.bill
        where b.bill_group = $1 order by b.id`,
      [g.group],
    )
    const sum = lines.rows.reduce((s, l) => s + cents(l.amount), 0)
    expect(sum).toBe(30001)
    for (const l of lines.rows) {
      if (l.written_down_to !== null) {
        expect(cents(l.written_down_to)).toBeLessThan(cents(l.original_value))
        expect(l.write_down_reason).toBe('agreed reduction')
      }
    }
    const grp = await admin.query(
      `select matter_total, rounding_record from deedbox.bill_group where id = $1`,
      [g.group],
    )
    expect(cents(grp.rows[0].matter_total)).toBe(30001)
    expect(grp.rows[0].rounding_record['1']).toBeDefined()

    // the issue identity holds over the edited shape
    const issued = await issueBillGroup(P, { group: g.group })
    const issuedSum = issued.bills.reduce((s, b) => s + cents(b.total), 0)
    expect(issuedSum).toBe(30001)
  })

  it('adds a manual line split across siblings', async () => {
    const m = await newMatter('H2 manual')
    const te = await newEntry(m, 5)
    const g = await createDraftBillGroup(P, { matter: m, timeEntries: [te] })
    await addManualDraftLine(P, {
      group: g.group,
      description: 'photocopying',
      amount: 12.34,
    })
    const grp = await admin.query(
      `select matter_total from deedbox.bill_group where id = $1`,
      [g.group],
    )
    expect(cents(grp.rows[0].matter_total)).toBe(20000 + 1234)
  })

  it('while pending approval: submitter and approvers edit, others are refused, new lines are refused', async () => {
    const m = await newMatter('H2 pending')
    const te = await newEntry(m, 10)
    const g = await createDraftBillGroup(P, { matter: m, timeEntries: [te] })

    const lawyerRole = await admin.query(`select id from deedbox.role where system_key = 'lawyer'`)
    const stranger = await admin.query(
      `insert into deedbox.staff_member (person_name, login, role, office, email)
       values ('{"display":"Lou Lawyer"}','lou.brun', $1, $2, 'lou.brun@example.test')
       returning id`,
      [lawyerRole.rows[0].id, fx.office],
    )
    const S: Principal = { kind: 'staff', id: stranger.rows[0].id as number, firm: fx.firm }

    await setFirmSetting(admin, 'bill.approval_required', true, 20)
    try {
      await submitForApproval(P, { group: g.group })
      // a lawyer who is neither submitter nor approver is refused
      await expect(
        writeDownDraftItem(S, { group: g.group, position: 1, writtenDownTo: 100, reason: 'no' }),
      ).rejects.toMatchObject({ code: 'not_reviewer' })
      // the submitter still edits
      await writeDownDraftItem(P, {
        group: g.group,
        position: 1,
        writtenDownTo: 350,
        reason: 'pending trim',
      })
      // a NEW line cannot be drafted onto a pending bill
      await expect(
        addManualDraftLine(P, { group: g.group, description: 'late add', amount: 5 }),
      ).rejects.toMatchObject({ code: 'pending_approval' })
    } finally {
      await setFirmSetting(admin, 'bill.approval_required', false, 10)
    }
  })
})

describe('billing runs', () => {
  it('build: includes billable matters, excludes held/closed/empty with reasons', async () => {
    const mA = await newMatter('Run include')
    await newEntry(mA, 10)
    const mH = await newMatter('Run held')
    await newEntry(mH, 5)
    await placeBillingHold(P, { matter: mH, reason: 'fee discussion underway' })
    const mC = await newMatter('Run closed')
    await closeMatter(P, { matter: mC })
    const mN = await newMatter('Run nothing')

    const run = await createBillingRun(P, { filters: { matters: [mA, mH, mC, mN] } })
    expect(run.groups.length).toBe(1)
    expect(run.groups[0].matter).toBe(mA)
    const reasons = Object.fromEntries(run.excluded.map((e) => [e.matter, e.reason]))
    expect(reasons[mH]).toBe('billing hold')
    expect(reasons[mC]).toBe('matter closed')
    expect(reasons[mN]).toBe('nothing unbilled')

    const row = await admin.query(
      `select state, filter_snapshot from deedbox.billing_run where id = $1`,
      [run.run],
    )
    expect(row.rows[0].state).toBe('in_review')
    expect(row.rows[0].filter_snapshot.excluded.length).toBe(3)
    const grp = await admin.query(`select billing_run from deedbox.bill_group where id = $1`, [
      run.groups[0].group,
    ])
    expect(grp.rows[0].billing_run).toBe(run.run)
  })

  it('a WIP cut-off drafts only work dated on or before it; later work waits for the next run', async () => {
    const m = await newMatter('Run cut-off')
    const older = await createTimeEntry(P, { matter: m, workDate: dateStr(20), units: 10, narrative: 'older work' })
    const newer = await createTimeEntry(P, { matter: m, workDate: dateStr(2), units: 5, narrative: 'newer work' })
    const only = await newMatter('Run cut-off nothing yet')
    await createTimeEntry(P, { matter: only, workDate: dateStr(2), units: 5, narrative: 'too new' })

    const run = await createBillingRun(P, { filters: { matters: [m, only], throughDate: dateStr(10) } })
    expect(run.groups.length).toBe(1)
    expect(run.groups[0].matter).toBe(m)
    const reasons = Object.fromEntries(run.excluded.map((e) => [e.matter, e.reason]))
    expect(reasons[only]).toBe(`nothing unbilled on or before ${dateStr(10)}`)
    const states = await admin.query(
      `select id, billed_state from deedbox.time_entry where id = any($1) order by id`,
      [[older.id, newer.id]],
    )
    expect(states.rows.find((r) => r.id === older.id)?.billed_state).toBe('on_draft')
    expect(states.rows.find((r) => r.id === newer.id)?.billed_state).toBe('unbilled')
    const snap = await admin.query(`select filter_snapshot from deedbox.billing_run where id = $1`, [run.run])
    expect(snap.rows[0].filter_snapshot.filters.throughDate).toBe(dateStr(10))
  })

  it('issues every group, one transaction each, and registers the bulk commit', async () => {
    const m1 = await newMatter('Run issue A')
    await newEntry(m1, 10)
    const m2 = await newMatter('Run issue B')
    await newEntry(m2, 5)
    const run = await createBillingRun(P, { filters: { matters: [m1, m2] } })
    expect(run.groups.length).toBe(2)

    const r = await issueBillingRun(P, { run: run.run })
    expect(r.stoppedAt).toBeNull()
    expect(r.issued.length).toBe(2)
    for (const g of r.issued) {
      expect(g.bills[0].billNumber).toMatch(/^B-/)
    }
    const row = await admin.query(`select state from deedbox.billing_run where id = $1`, [run.run])
    expect(row.rows[0].state).toBe('issued')
    const reg = await admin.query(
      `select 1 from deedbox.register_entry
        where event_kind = 'bulk.committed' and subject_type = 'billing_run' and subject = $1`,
      [run.run],
    )
    expect(reg.rowCount).toBe(1)
  })

  it('stops at the first hard failure, leaves the rest in review, abandon releases them', async () => {
    const m1 = await newMatter('Run stop A')
    await newEntry(m1, 10)
    const m2 = await newMatter('Run stop B')
    const te2 = await newEntry(m2, 5)
    const run = await createBillingRun(P, { filters: { matters: [m1, m2] } })
    const g2 = run.groups.find((g) => g.matter === m2)!

    // hold the second group's only item back: its bill is now empty, and
    // empty bills refuse issue — an honest hard failure mid-run
    await removeDraftLine(P, { group: g2.group, position: 1 })

    const r = await issueBillingRun(P, { run: run.run })
    expect(r.issued.length).toBe(1)
    expect(r.stoppedAt).toMatchObject({ group: g2.group, position: 1 })
    const row = await admin.query(
      `select state, filter_snapshot from deedbox.billing_run where id = $1`,
      [run.run],
    )
    expect(row.rows[0].state).toBe('in_review')
    expect(row.rows[0].filter_snapshot.issue_stopped.group).toBe(g2.group)

    await abandonBillingRun(P, { run: run.run })
    const after = await admin.query(`select state from deedbox.billing_run where id = $1`, [
      run.run,
    ])
    expect(after.rows[0].state).toBe('abandoned')
    const item = await admin.query(`select billed_state from deedbox.time_entry where id = $1`, [
      te2,
    ])
    expect(item.rows[0].billed_state).toBe('unbilled')
    // the issued first group stands — a committed issue never unwinds
    const issuedBill = await admin.query(
      `select state from deedbox.bill where id = $1`,
      [r.issued[0].bills[0].id],
    )
    expect(issuedBill.rows[0].state).toBe('issued')
  })
})

describe('pay a run’s bills from held client money (0052 composer)', () => {
  it('entitles the ticked bill, parks one transfer awaiting authorisation, and refuses a second pass honestly', async () => {
    const m = await newMatter('Run held-funds host')
    await newEntry(m, 5) // 200.00
    const run = await createBillingRun(P, { filters: { matters: [m] } })
    expect(run.groups.length).toBe(1)
    const issued = await issueBillingRun(P, { run: run.run })
    expect(issued.stoppedAt).toBeNull()
    const bill = issued.issued[0].bills[0].id

    // held client money arrives on the matter after the bill issues
    await recordMoneyReceipt(P, {
      matter: m,
      account: fx.account,
      amount: 300,
      method: 'electronic_transfer',
      payerDescription: 'held money for the composer test',
    })

    const r = await applyHeldFundsToRunBills(P, { run: run.run, bills: [bill] })
    expect(r).toMatchObject({ entitled: 1, awaiting: 1, refused: 0, matters: 1 })

    // the entitlement exists on the bill, capped at what is owed
    const ent = await admin.query(
      `select amount from deedbox.entitlement where bill = $1 and cancelled_at is null`,
      [bill],
    )
    expect(ent.rowCount).toBe(1)
    expect(cents(ent.rows[0].amount)).toBe(20000)

    // one transfer parks awaiting authorisation — the ordinary ceremony
    const fa = await admin.query(
      `select item_state from deedbox.funds_application where bill = $1`,
      [bill],
    )
    expect(fa.rows.map((x) => x.item_state)).toContain('awaiting_authorisation')

    // a second pass never queues the same money twice
    await expect(
      applyHeldFundsToRunBills(P, { run: run.run, bills: [bill] }),
    ).rejects.toMatchObject({ code: 'nothing_payable' })
  })

  it('the bill door: a bill issued OUTSIDE any run prepares its transfer the same way', async () => {
    const m = await newMatter('Bill-door held-funds host')
    const entry = await newEntry(m, 5) // 200.00
    const g = await createDraftBillGroup(P, { matter: m, timeEntries: [entry] })
    const issued = await issueBillGroup(P, { group: g.group })
    const bill = issued.bills[0].id

    await recordMoneyReceipt(P, {
      matter: m,
      account: fx.account,
      amount: 500,
      method: 'electronic_transfer',
      payerDescription: 'held money for the bill-door test',
    })

    const r = await applyHeldFundsToBills(P, { bills: [bill] })
    expect(r).toMatchObject({ entitled: 1, awaiting: 1, refused: 0, matters: 1 })
    const fa = await admin.query(
      `select item_state from deedbox.funds_application where bill = $1`,
      [bill],
    )
    expect(fa.rows.map((x) => x.item_state)).toContain('awaiting_authorisation')

    await expect(applyHeldFundsToBills(P, { bills: [bill] })).rejects.toMatchObject({
      code: 'nothing_payable',
    })
  })

  it('the payments screen finishes a bridge transfer whole; the raw door refuses to half-do it', async () => {
    const m = await newMatter('Bridge-by-payment host')
    const entry = await newEntry(m, 5) // 200.00
    const g = await createDraftBillGroup(P, { matter: m, timeEntries: [entry] })
    const issued = await issueBillGroup(P, { group: g.group })
    const bill = issued.bills[0].id
    await recordMoneyReceipt(P, {
      matter: m,
      account: fx.account,
      amount: 500,
      method: 'electronic_transfer',
      payerDescription: 'held money for the bridge-by-payment test',
    })
    await applyHeldFundsToBills(P, { bills: [bill] })
    const fa = await admin.query(
      `select id, money_payment from deedbox.funds_application where bill = $1`,
      [bill],
    )
    const payment = fa.rows[0].money_payment as number
    const item = fa.rows[0].id as number

    // the self-heal refuses a transfer that has not actually moved
    await expect(completeExecutedHeldFundsItem(P, { item })).rejects.toMatchObject({
      code: 'payment_not_executed',
    })

    const approver = await addStaff(admin, fx, 'aud.brun')
    const A: Principal = { kind: 'staff', id: approver, firm: fx.firm }
    const first = await authoriseMoneyPayment(A, { payment })
    expect(first.authorised).toBe(true)

    // the raw execute door refuses — this payment pays a specific bill
    await expect(executeMoneyPayment(A, { payment })).rejects.toMatchObject({
      code: 'held_funds_item',
    })

    // the bridge route executes whole: money moved AND the bill paid
    const done = await executeHeldFundsPayment(A, { payment })
    expect(done.executed).toBe(true)
    expect(done.paymentNumber).toMatch(/^P-/)
    expect(done.receiptNumber).toMatch(/^OR-/)
    const out = await admin.query(`select deedbox.bill_outstanding($1) as o`, [bill])
    expect(Number(out.rows[0].o)).toBe(0)
    const after = await admin.query(
      `select item_state from deedbox.funds_application where id = $1`,
      [item],
    )
    expect(after.rows[0].item_state).toBe('completed')

    // and a completed item takes no second completion
    await expect(completeExecutedHeldFundsItem(A, { item })).rejects.toMatchObject({
      code: 'not_awaiting',
    })
  })
})

describe('statements', () => {
  let mOld: number
  let mNew: number
  let billOld: number
  let billNew: number

  beforeAll(async () => {
    mOld = await newMatter('Stmt old')
    const teO = await newEntry(mOld, 10) // 400.00
    const gO = await createDraftBillGroup(P, { matter: mOld, timeEntries: [teO] })
    billOld = (await issueBillGroup(P, { group: gO.group, issueDate: dateStr(75) })).bills[0].id
    // due 61 days ago → ageing 61-90; pay 160 so 240.00 remains
    await recordPayment(P, {
      receivedDate: dateStr(2),
      amount: 160,
      method: 'bank_transfer',
      allocations: [{ bill: billOld, amount: 160 }],
    })
    mNew = await newMatter('Stmt new')
    const teN = await newEntry(mNew, 5) // 200.00
    const gN = await createDraftBillGroup(P, { matter: mNew, timeEntries: [teN] })
    billNew = (await issueBillGroup(P, { group: gN.group, issueDate: dateStr(40) })).bills[0].id
    // due 26 days ago → ageing 1-30
  })

  it('snapshots the outstanding position with ageing, numbered and rendered', async () => {
    const s = await generateStatement(P, { scopeKind: 'matter', scope: mOld })
    expect(s.statementNumber).toMatch(/^S-/)
    expect(cents(s.totalOutstanding)).toBe(24000)
    expect(s.bills[0].ageing_bucket).toBe('61-90')
    const row = await admin.query(
      `select artefact, content_snapshot from deedbox.receivable_statement where id = $1`,
      [s.id],
    )
    expect(row.rows[0].artefact).toBeTruthy()
    expect(row.rows[0].content_snapshot.bills.length).toBe(1)
  })

  it('client scope spans the client\'s matters; a reference can be issued with it', async () => {
    const s = await generateStatement(P, {
      scopeKind: 'client',
      scope: fx.clientParty,
      withPaymentReference: true,
    })
    const billIds = s.bills.map((b) => b.bill)
    expect(billIds).toContain(billOld)
    expect(billIds).toContain(billNew)
    const ref = await admin.query(
      `select r.active, r.expected_amount from deedbox.payment_reference r
        where r.target_kind = 'statement' and r.target = $1`,
      [s.id],
    )
    expect(ref.rowCount).toBe(1)
    expect(ref.rows[0].active).toBe(true)
    expect(cents(ref.rows[0].expected_amount)).toBe(cents(s.totalOutstanding))
  })

  it('allocates one payment oldest-first across the statement', async () => {
    const s = await generateStatement(P, { scopeKind: 'client', scope: fx.clientParty })
    const pay = await recordPayment(P, {
      receivedDate: dateStr(1),
      amount: 300,
      method: 'bank_transfer',
    })
    const r = await allocateStatementPayment(P, { payment: pay.id, statement: s.id })
    expect(r.allocated).toEqual([
      { bill: billOld, amount: 240 },
      { bill: billNew, amount: 60 },
    ])
    const oOld = await admin.query(`select deedbox.bill_outstanding($1) as o`, [billOld])
    const oNew = await admin.query(`select deedbox.bill_outstanding($1) as o`, [billNew])
    expect(cents(oOld.rows[0].o)).toBe(0)
    expect(cents(oNew.rows[0].o)).toBe(14000)
  })

  it('skips disputed bills with the skip itemised; manual order is honoured and recorded', async () => {
    // fresh pair on one matter so ordering is observable
    const m = await newMatter('Stmt skip')
    const te1 = await newEntry(m, 10) // 400
    const g1 = await createDraftBillGroup(P, { matter: m, timeEntries: [te1] })
    const b1 = (await issueBillGroup(P, { group: g1.group, issueDate: dateStr(50) })).bills[0].id
    const te2 = await newEntry(m, 5) // 200
    const g2 = await createDraftBillGroup(P, { matter: m, timeEntries: [te2] })
    const b2 = (await issueBillGroup(P, { group: g2.group, issueDate: dateStr(30) })).bills[0].id

    await raiseDispute(P, { bill: b1, detail: 'quantum disputed' })
    const s = await generateStatement(P, { scopeKind: 'matter', scope: m })
    const pay = await recordPayment(P, {
      receivedDate: dateStr(1),
      amount: 100,
      method: 'bank_transfer',
    })
    const r = await allocateStatementPayment(P, { payment: pay.id, statement: s.id })
    expect(r.skips).toEqual([{ bill: b1, reason: 'open dispute' }])
    expect(r.allocated).toEqual([{ bill: b2, amount: 100 }])

    // manual order: remaining 100 aimed at b2 first is the same, so aim a
    // fresh payment with b2 before the (still disputed, still skipped) b1
    const pay2 = await recordPayment(P, {
      receivedDate: dateStr(1),
      amount: 50,
      method: 'bank_transfer',
    })
    const r2 = await allocateStatementPayment(P, {
      payment: pay2.id,
      statement: s.id,
      manualOrder: [b2, b1],
    })
    expect(r2.allocated).toEqual([{ bill: b2, amount: 50 }])
    const reg = await admin.query(
      `select detail from deedbox.register_entry
        where subject_type = 'receivable_statement' and subject = $1
          and event_kind = 'record.changed'
        order by id desc limit 1`,
      [s.id],
    )
    expect(reg.rows[0].detail.manual_order).toBe(true)
  })
})

describe('interest (proposals per 0021)', () => {
  let mInt: number
  let billInt: number
  let due: string

  beforeAll(async () => {
    // pack cap: 15% — declared on this suite's own pack, activated here
    const pv = await admin.query(
      `insert into deedbox.pack_version (pack, version)
       select id, '0.0.1' from deedbox.country_pack where code = 'xbru' returning id, pack`,
    )
    await admin.query(
      `insert into deedbox.pack_declaration (pack_version, rule_point, kind, body)
       values ($1, 'billing.interest_cap', 'threshold_rule', '{"max_annual_rate_pct": 15}')`,
      [pv.rows[0].id],
    )
    await admin.query(`update deedbox.country_pack set active_version = $1 where id = $2`, [
      pv.rows[0].id,
      pv.rows[0].pack,
    ])
  })

  it('policies save under the pack cap and supersede, never edit', async () => {
    await expect(
      saveInterestPolicy(P, { scope: 'firm', annualRatePct: 20, graceDays: 0 }),
    ).rejects.toMatchObject({ code: 'interest_over_cap' })
    await saveInterestPolicy(P, { scope: 'firm', annualRatePct: 10, graceDays: 0 })
    await saveInterestPolicy(P, { scope: 'firm', annualRatePct: 8, graceDays: 0 })
    const rows = await admin.query(
      `select annual_rate_pct, active from deedbox.interest_policy
        where scope = 'firm' order by id`,
    )
    const active = rows.rows.filter((r) => r.active)
    expect(active.length).toBe(1)
    expect(Number(active[0].annual_rate_pct)).toBe(8)
    // restore the 10% policy for the charge tests below
    await saveInterestPolicy(P, { scope: 'firm', annualRatePct: 10, graceDays: 0 })
  })

  it('issue fixes the interest statement into the bill; charges refuse without one', async () => {
    mInt = await newMatter('Interest host')
    const te = await newEntry(mInt, 250) // 10,000.00
    const g = await createDraftBillGroup(P, { matter: mInt, timeEntries: [te] })
    const issued = await issueBillGroup(P, {
      group: g.group,
      issueDate: dateStr(60),
      stateInterest: true,
    })
    billInt = issued.bills[0].id
    const b = await admin.query(
      `select interest_statement, due_date::text as due from deedbox.bill where id = $1`,
      [billInt],
    )
    expect(Number(b.rows[0].interest_statement.annual_rate_pct)).toBe(10)
    due = b.rows[0].due as string

    // a statement-less bill accrues nothing, ever
    const mNone = await newMatter('No interest')
    const teN = await newEntry(mNone, 5)
    const gN = await createDraftBillGroup(P, { matter: mNone, timeEntries: [teN] })
    const bN = (await issueBillGroup(P, { group: gN.group })).bills[0].id
    await expect(addInterestCharge(P, { bill: bN })).rejects.toMatchObject({
      code: 'no_interest_statement',
    })
  })

  it('computes simple daily interest on the day-by-day principal', async () => {
    // a 5,000.00 payment lands five days into the charge period
    const allocDate = new Date(Date.parse(due) + 5 * 86400000).toISOString().slice(0, 10)
    const pay = await recordPayment(P, {
      receivedDate: allocDate,
      amount: 5000,
      method: 'bank_transfer',
    })
    await admin.query(
      `insert into deedbox.bill_journal_entry
         (bill, entry_kind, signed_amount, source_type, source, effective_date, entered_by)
       values ($1, 'payment_allocation', -5000, 'receivable_payment', $2, $3::date, $4)`,
      [billInt, pay.id, allocDate, fx.staff],
    )

    const from = due // grace 0: accrual starts at the due date
    const periodTo = new Date(Date.parse(from) + 9 * 86400000).toISOString().slice(0, 10)
    const r = await addInterestCharge(P, { bill: billInt, periodFrom: from, periodTo })
    // five days on 10,000 then five on 5,000 at 10%: (5×1000 + 5×500)/365
    expect(cents(r.amount)).toBe(Math.round(((5 * 1000 + 5 * 500) / 365) * 100))
    const j = await admin.query(
      `select signed_amount from deedbox.bill_journal_entry
        where bill = $1 and entry_kind = 'interest_charge'`,
      [billInt],
    )
    expect(j.rowCount).toBe(1)
    expect(cents(j.rows[0].signed_amount)).toBe(cents(r.amount))
  })

  it('never compounds: the next period accrues on principal excluding interest', async () => {
    const from = new Date(Date.parse(due) + 10 * 86400000).toISOString().slice(0, 10)
    const to = new Date(Date.parse(due) + 19 * 86400000).toISOString().slice(0, 10)
    const r = await addInterestCharge(P, { bill: billInt, periodFrom: from, periodTo: to })
    // ten days on 5,000.00 at 10% — the first charge is excluded from the base
    expect(cents(r.amount)).toBe(Math.round(((10 * 500) / 365) * 100))
  })

  it('refuses overlapping periods and periods before due + grace', async () => {
    await expect(
      addInterestCharge(P, { bill: billInt, periodFrom: due, periodTo: due }),
    ).rejects.toMatchObject({ code: 'period_too_early' })
    const early = new Date(Date.parse(due) - 3 * 86400000).toISOString().slice(0, 10)
    await expect(
      addInterestCharge(P, { bill: billInt, periodFrom: early, periodTo: due }),
    ).rejects.toMatchObject({ code: 'period_too_early' })
  })

  it('previews without writing', async () => {
    const from = new Date(Date.parse(due) + 20 * 86400000).toISOString().slice(0, 10)
    const to = new Date(Date.parse(due) + 29 * 86400000).toISOString().slice(0, 10)
    const before = await admin.query(
      `select count(*)::int as n from deedbox.interest_charge where bill = $1`,
      [billInt],
    )
    const r = await previewInterestCharge(P, { bill: billInt, periodFrom: from, periodTo: to })
    expect(cents(r.amount)).toBe(Math.round(((10 * 500) / 365) * 100))
    const after = await admin.query(
      `select count(*)::int as n from deedbox.interest_charge where bill = $1`,
      [billInt],
    )
    expect(after.rows[0].n).toBe(before.rows[0].n)
  })

  it('parks system computations as proposals; approval recomputes and posts; dismissal records why', async () => {
    const mP = await newMatter('Proposal host')
    const teP = await newEntry(mP, 10) // 400.00
    const gP = await createDraftBillGroup(P, { matter: mP, timeEntries: [teP] })
    const billP = (
      await issueBillGroup(P, { group: gP.group, issueDate: dateStr(40), stateInterest: true })
    ).bills[0].id

    // the sweep parks proposals for BOTH statement-bearing bills with
    // accrual owing: billP (never charged) and billInt (accrual beyond its
    // two posted periods)
    const gen = await generateInterestProposals(P)
    const propP = gen.proposals.find((x) => x.bill === billP)
    const propInt = gen.proposals.find((x) => x.bill === billInt)
    expect(propP).toBeDefined()
    expect(propInt).toBeDefined()
    const parked = await admin.query(
      `select period_from::text as f, period_to::text as t, amount
         from deedbox.interest_charge_proposal where bill = $1 and state = 'pending'`,
      [billP],
    )
    expect(parked.rowCount).toBe(1)
    const days = diffDays(parked.rows[0].f as string, parked.rows[0].t as string) + 1
    expect(cents(parked.rows[0].amount)).toBe(Math.round(((days * 40) / 365) * 100))

    // a second sweep leaves pending proposals alone
    const gen2 = await generateInterestProposals(P)
    expect(gen2.proposals.find((x) => x.bill === billP)).toBeUndefined()
    expect(gen2.proposals.find((x) => x.bill === billInt)).toBeUndefined()

    // approval recomputes (nothing changed → equal) and posts
    const approved = await approveInterestProposal(P, { proposal: propP!.id })
    if (!approved.posted) throw new Error('expected the proposal to post')
    expect(cents(approved.amount)).toBe(cents(parked.rows[0].amount))
    const resolved = await admin.query(
      `select state, interest_charge from deedbox.interest_charge_proposal where id = $1`,
      [propP!.id],
    )
    expect(resolved.rows[0].state).toBe('approved')
    expect(resolved.rows[0].interest_charge).toBe(approved.chargeId)
    const j = await admin.query(
      `select 1 from deedbox.bill_journal_entry
        where bill = $1 and entry_kind = 'interest_charge' and source = $2`,
      [billP, approved.chargeId],
    )
    expect(j.rowCount).toBe(1)

    // dismissal records who and why, and the row is terminal evidence
    await dismissInterestProposal(P, {
      proposal: propInt!.id,
      reason: 'client relationship — waive this period',
    })
    const dismissed = await admin.query(
      `select state, reason from deedbox.interest_charge_proposal where id = $1`,
      [propInt!.id],
    )
    expect(dismissed.rows[0].state).toBe('dismissed')
    expect(dismissed.rows[0].reason).toContain('waive')
  })
})

describe('the bank file over a completed held-funds run (layer-2 batch)', () => {
  it('renders one 120-character-record credit for the completed transfers, refusing while nothing has executed', async () => {
    const m = await newMatter('ABA host')
    await newEntry(m, 5) // 200.00
    const run = await createBillingRun(P, { filters: { matters: [m] } })
    const issued = await issueBillingRun(P, { run: run.run })
    const bill = issued.issued[0].bills[0].id
    await recordMoneyReceipt(P, {
      matter: m,
      account: fx.account,
      amount: 250,
      method: 'electronic_transfer',
      payerDescription: 'aba host funding',
    })
    await applyHeldFundsToRunBills(P, { run: run.run, bills: [bill] })
    const fa = await admin.query(
      `select id, run from deedbox.funds_application where bill = $1 and item_state = 'awaiting_authorisation'`,
      [bill],
    )
    const appRun = fa.rows[0].run as number

    // the bank file exists only where the active pack declares BSB-shaped
    // accounts (0058-era gate) — declare them on the fixture firm's pack
    const packId = (
      await admin.query(`select country_pack as id from deedbox.firm where id = $1`, [fx.firm])
    ).rows[0].id as number
    const pv = await admin.query(
      `insert into deedbox.pack_version (pack, version) values ($1, 'aba-fixture-1') returning id`,
      [packId],
    )
    await admin.query(
      `insert into deedbox.pack_declaration (pack_version, rule_point, kind, body)
       values ($1, 'bank.account_identifiers', 'field_schema',
               '{"fields":[{"key":"bsb","label":"BSB"},{"key":"account_number","label":"Account number"}]}')`,
      [pv.rows[0].id],
    )
    await admin.query(`update deedbox.country_pack set active_version = $1 where id = $2`, [
      pv.rows[0].id,
      packId,
    ])

    // before anything executes, the file honestly refuses
    await expect(heldFundsRunAba(P, { run: appRun })).rejects.toMatchObject({
      code: 'nothing_completed',
    })

    // bank records on both sides: the governing payment details (credit) and
    // the client account's identifiers (trace) — keyed as the pack declares
    await savePaymentDetails(P, {
      accountHolderName: 'Aba Test Firm Pty Ltd',
      bankName: 'ANZ',
      identifierValues: { bsb: '012-345', account_number: '123456789' },
    })
    await admin.query(
      `update deedbox.client_account
          set bank_identifiers = '{"account_name":"Aba Trust","bank":"ANZ","bsb":"014-999","account_number":"987654321"}'::jsonb
        where id = $1`,
      [fx.account],
    )

    // a DIFFERENT person approves — the transfer executes
    const S: Principal = { kind: 'staff', id: await addStaff(admin, fx, 'aba.brun'), firm: fx.firm }
    const done = await authoriseHeldFundsItem(S, { item: fa.rows[0].id as number, decision: 'approve' })
    expect(done.executed).toBe(true)

    const f = await heldFundsRunAba(P, { run: appRun })
    const lines = f.content.split('\r\n').filter((l) => l.length > 0)
    expect(lines).toHaveLength(3)
    for (const l of lines) expect(l.length).toBe(120)
    expect(lines[0][0]).toBe('0')
    expect(lines[1][0]).toBe('1')
    expect(lines[2][0]).toBe('7')
    expect(lines[1]).toContain('012-345')      // credit lands on the firm account
    expect(lines[1]).toContain('014-999')      // traced from the client account
    expect(lines[1].slice(18, 20)).toBe('50')  // transaction code: credit
    expect(lines[1]).toContain('0000020000')   // $200.00 in cents
    expect(cents(f.total)).toBe(20000)
    expect(f.items).toBe(1)
  })
})
