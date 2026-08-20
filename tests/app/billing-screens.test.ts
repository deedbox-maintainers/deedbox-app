// Billing screens: the predicate-governed reads behind the eighteen
// billing surfaces plus the capture screen. The operations are proven by
// the earlier billing suites — these tests prove the READS return honest
// shapes end-to-end against real flows.
//
// Cross-suite contracts (localeCompare order: this file runs AFTER
// billing-runs, BEFORE billing-settle):
//   * bill.approval_required is flipped ON at minutesAgo=8 and restored OFF
//     at minutesAgo=4 in a finally — newer than every earlier suite's rows,
//     restored to the default before any later suite runs.
//   * The reminder sequence created here is NEVER the default
//     (default_for_new_bills=false) — later suites' issued bills must not
//     adopt it.
//   * A payment_details version created here becomes the firm's governing
//     details (global, versioned) — later suites that care create their own.
//   * The see_cost_rates grant is added to the administrator role ONLY when
//     absent, and removed again in a finally.
//   * All fixture rows are tag-named (xbsc).

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import type { Pool } from 'pg'
import { closePool } from '@/lib/db'
import type { Principal } from '@/lib/db'
import {
  addStaffRate,
  addStaffCostRate,
  createTimeEntry,
  createDisbursement,
  startTimer,
  discardTimer,
  ingestSignal,
  reviseEstimate,
  setBudget,
  placeBillingHold,
  releaseBillingHold,
  createDraftBillGroup,
  submitForApproval,
  sendBackToDraft,
  issueBillGroup,
  recordPayment,
  generateStatement,
  createArrangement,
  cancelArrangement,
  createReminderSequence,
  startChannelPayment,
  previewHeldFundsApplication,
  savePaymentDetails,
} from '@/lib/ops/billing'
import { setRoleCapability } from '@/lib/ops/security'
import {
  myTime,
  myTimers,
  suggestionQueue,
  matterWip,
  matterBills,
  heldFundsFirmScope,
  draftEditor,
  billApprovalQueue,
  billingRuns,
  billView,
  unpaidBills,
  paymentWorkbench,
  statementsScreen,
  arrangementsScreen,
  reminderConfig,
  channelPanel,
  topUpQueue,
  heldFundsRuns,
  heldFundsRunDetail,
  ratesAdmin,
  paymentDetailsScreen,
  billingViewerFlags,
} from '@/lib/reads/billing'
import { makeAdminPool, buildFixture, addStaff, setFirmSetting, type Fixture } from './helpers'

let admin: Pool
let fx: Fixture
let P: Principal
let sam: number
let S: Principal
const JOB: (firm: number) => Principal = (firm) => ({ kind: 'system_job', id: 1, firm })

let issuedBill: number

beforeAll(async () => {
  admin = makeAdminPool()
  fx = await buildFixture(admin, 'xbsc')
  P = { kind: 'staff', id: fx.staff, firm: fx.firm }
  sam = await addStaff(admin, fx, 'sam.xbsc')
  S = { kind: 'staff', id: sam, firm: fx.firm }
  await addStaffRate(P, { staff: fx.staff, rate: 400, effectiveFrom: '2020-01-01' })
  await addStaffRate(P, { staff: sam, rate: 300, effectiveFrom: '2020-01-01' })
})

afterAll(async () => {
  await closePool()
  await admin.end()
})

describe('capture surfaces', () => {
  it('my time carries entries and category totals; timers appear and discard', async () => {
    await createTimeEntry(P, {
      matter: fx.matter,
      workDate: '2025-01-15',
      units: 3,
      narrative: 'xbsc reviewing the file',
    })
    const t = await myTime(P, { from: '2025-01-01', to: '2025-01-31' })
    expect(t.entries.some((e) => String(e.narrative).includes('xbsc reviewing'))).toBe(true)
    expect(t.totals.length).toBeGreaterThanOrEqual(1)
    expect(t.categories.length).toBeGreaterThanOrEqual(1)

    const started = await startTimer(P, { narrativeDraft: 'xbsc quick call' })
    const timers = await myTimers(P)
    expect(timers.some((x) => x.id === started.id && x.state === 'running')).toBe(true)
    await discardTimer(P, { timer: started.id })
    const after = await myTimers(P)
    expect(after.some((x) => x.id === started.id)).toBe(false)
  })

  it('the suggestion queue shows pending and held rows for their owner only', async () => {
    const withMatter = await ingestSignal(JOB(fx.firm), {
      sourceModule: 'xbsc-mail',
      signalKind: 'email_sent',
      sourceRef: 'xbsc-1',
      occurredAt: '2025-01-16T03:00:00Z',
      staff: fx.staff,
      matterHint: fx.matter,
      durationMinutes: 12,
    })
    const withoutMatter = await ingestSignal(JOB(fx.firm), {
      sourceModule: 'xbsc-mail',
      signalKind: 'email_sent',
      sourceRef: 'xbsc-2',
      occurredAt: '2025-01-16T04:00:00Z',
      staff: fx.staff,
      durationMinutes: 6,
    })
    expect(withMatter.suggestion).not.toBeNull()
    expect(withoutMatter.suggestion).not.toBeNull()

    const mine = await suggestionQueue(P)
    expect(mine.some((s) => s.id === withMatter.suggestion && s.state === 'pending')).toBe(true)
    expect(mine.some((s) => s.id === withoutMatter.suggestion && s.state === 'held_unmatched')).toBe(true)
    const theirs = await suggestionQueue(S)
    expect(theirs.some((s) => s.id === withMatter.suggestion)).toBe(false)
  })
})

describe('matter WIP, drafts and approvals', () => {
  it('the WIP tab: unbilled work, estimate with revisions, budget, hold banner', async () => {
    await createDisbursement(P, {
      matter: fx.matter,
      incurredDate: '2025-01-10',
      description: 'xbsc filing fee',
      amount: 50,
      taxTreatment: 'standard',
    })
    await reviseEstimate(P, { matter: fx.matter, amount: 5000, reason: 'xbsc initial scope' })
    await setBudget(P, { matter: fx.matter, amount: 4000 })
    const hold = await placeBillingHold(P, { matter: fx.matter, reason: 'xbsc await instructions' })

    const wip = await matterWip(P, fx.matter)
    expect(wip.time.length).toBeGreaterThanOrEqual(1)
    expect(wip.disbursements.some((d) => String(d.description).includes('xbsc filing'))).toBe(true)
    expect(Number(wip.estimate!.current_amount)).toBe(5000)
    expect((wip.estimate!.revisions as unknown[]).length).toBeGreaterThanOrEqual(1)
    expect(wip.budgets.length).toBe(1)
    expect(wip.openHold).not.toBeNull()
    expect(wip.consumption.unbilled).toBeGreaterThan(0)

    await releaseBillingHold(P, { hold: hold.id })
    const after = await matterWip(P, fx.matter)
    expect(after.openHold).toBeNull()
  })

  it('draft editor and the approval queue (flip restored in finally)', async () => {
    // A draft names its items explicitly — the WIP screen posts the ticked
    // ids; the operation refuses an empty selection.
    const wip = await matterWip(P, fx.matter)
    const draft = await createDraftBillGroup(P, {
      matter: fx.matter,
      timeEntries: wip.time.map((t) => t.id as number),
      disbursements: wip.disbursements.map((d) => d.id as number),
    })
    const ed = await draftEditor(P, draft.group)
    expect(ed.bills.length).toBe(1) // single payer — the client
    expect(ed.lines.length).toBeGreaterThanOrEqual(2) // time + disbursement
    expect(ed.approvalRequired).toBe(false)

    await setFirmSetting(admin, 'bill.approval_required', true, 8)
    try {
      await submitForApproval(P, { group: draft.group })
      const queue = await billApprovalQueue(P)
      const row = queue.find((r) => r.group_id === draft.group)
      expect(row).toBeDefined()
      expect(Number(row!.matter_total)).toBeGreaterThan(0)
      await sendBackToDraft(S, { group: draft.group, note: 'xbsc check the narrative' })
      const emptied = await billApprovalQueue(P)
      expect(emptied.some((r) => r.group_id === draft.group)).toBe(false)
    } finally {
      await setFirmSetting(admin, 'bill.approval_required', false, 4)
    }

    // the runs read renders (earlier suites' runs may populate it)
    const runs = await billingRuns(P)
    expect(Array.isArray(runs)).toBe(true)
  })
})

describe('issued bills, payments, statements, arrangements', () => {
  it('bill view, unpaid register and the payment workbench tell one story', async () => {
    const drafts = await matterWip(P, fx.matter)
    const group = drafts.drafts[0].id as number
    const issued = await issueBillGroup(P, { group })
    issuedBill = issued.bills[0].id
    const total = issued.bills[0].total

    let v = await billView(P, issuedBill)
    expect(v.bill.bill_number).toBeTruthy()
    expect(Number(v.bill.outstanding)).toBe(total)
    expect(v.journal.some((j) => j.entry_kind === 'issue_total')).toBe(true)
    // the shared scratch carries a default reminder sequence (an earlier
    // suite's deterministic cross-file contract) — the bill is born running
    expect(v.reminder).not.toBeNull()
    expect(v.reminder!.status).toBe('running')

    // the matter's own issued-bills list (the finding side of the billing tab)
    const onMatter = await matterBills(P, fx.matter)
    const mbRow = onMatter.find((r) => r.id === issuedBill)
    expect(mbRow).toBeDefined()
    expect(mbRow!.issueTotal).toBe(total)
    expect(mbRow!.outstanding).toBe(total)

    const unpaid = await unpaidBills(P, { matter: fx.matter })
    const upRow = unpaid.find((r) => r.id === issuedBill)
    expect(upRow).toBeDefined()
    expect(upRow!.age_days).toBe(0) // terms put the due date in the future

    // partial payment allocated in the same act
    await recordPayment(P, {
      payerParty: fx.clientParty,
      receivedDate: '2025-02-01',
      amount: 100,
      method: 'electronic_transfer',
      allocations: [{ bill: issuedBill, amount: 100 }],
    })
    v = await billView(P, issuedBill)
    expect(Number(v.bill.outstanding)).toBe(Number((total - 100).toFixed(2)))
    expect(v.journal.some((j) => j.entry_kind === 'payment_allocation')).toBe(true)

    // an unallocated receipt surfaces on the workbench with its remainder
    await recordPayment(P, {
      payerParty: fx.clientParty,
      receivedDate: '2025-02-02',
      amount: 40,
      method: 'electronic_transfer',
    })
    const wb = await paymentWorkbench(P, { payer: fx.clientParty })
    expect(wb.openBills.some((b) => b.id === issuedBill)).toBe(true)
    expect(wb.unallocated.some((r) => Number(r.remainder) === 40)).toBe(true)
  })

  it('statements and arrangements read back their machinery', async () => {
    const st = await generateStatement(P, { scopeKind: 'client', scope: fx.clientParty })
    const list = await statementsScreen(P)
    expect(list.some((s) => s.statement_number === st.statementNumber)).toBe(true)

    const arr = await createArrangement(P, {
      clientParty: fx.clientParty,
      instalmentAmount: 50,
      frequency: 'monthly',
      instalmentCount: 3,
      firstDueDate: '2030-01-01',
      bills: [issuedBill],
    })
    const screen = await arrangementsScreen(P)
    const row = screen.arrangements.find((a) => a.id === arr.id)
    expect(row).toBeDefined()
    expect(row!.state).toBe('active')
    expect(screen.instalments.filter((i) => i.arrangement === arr.id).length).toBe(3)

    // the bill view shows the coverage line while the plan holds
    const v = await billView(P, issuedBill)
    expect(v.arrangement).not.toBeNull()

    await cancelArrangement(P, { arrangement: arr.id, reason: 'xbsc client paid another way' })
    const after = await arrangementsScreen(P)
    expect(after.arrangements.find((a) => a.id === arr.id)!.state).toBe('cancelled')
  })
})

describe('config-adjacent surfaces', () => {
  it('reminder configuration lists sequences with steps and read-only templates', async () => {
    const tpl = await admin.query(
      `insert into deedbox.message_template (name, channel, purpose, body, tokens_used)
       values ('xbsc first nudge', 'email', 'reminder', 'Please pay {{bill_number}}', '["bill_number"]'::jsonb)
       returning id`,
    )
    await createReminderSequence(P, {
      name: 'xbsc gentle',
      defaultForNewBills: false, // NEVER the default — cross-suite contract
      steps: [{ stepNo: 1, daysAfterPrevious: 7, channel: 'email', template: tpl.rows[0].id }],
    })
    const cfg = await reminderConfig(P)
    const seq = cfg.sequences.find((s) => s.name === 'xbsc gentle')
    expect(seq).toBeDefined()
    expect(seq!.default_for_new_bills).toBe(false)
    expect(cfg.steps.filter((s) => s.sequence === seq!.id).length).toBe(1)
    expect(cfg.templates.some((t) => t.name === 'xbsc first nudge')).toBe(true)
  })

  it('the channel panel shows in-flight events; the top-up queue reads', async () => {
    const st = await generateStatement(P, {
      scopeKind: 'client',
      scope: fx.clientParty,
      withPaymentReference: true,
    })
    const ref = await admin.query(
      `select code from deedbox.payment_reference where target_kind = 'statement' and target = $1`,
      [st.id],
    )
    await startChannelPayment(JOB(fx.firm), {
      channel: 'xbsc-pay',
      channelEventRef: 'xbsc-evt-1',
      referenceCode: ref.rows[0].code as string,
      method: 'card',
      amount: 25,
    })
    const panel = await channelPanel(P)
    const row = panel.find((r) => r.channel === 'xbsc-pay' && r.channel_event_ref === 'xbsc-evt-1')
    expect(row).toBeDefined()
    expect(row!.state).toBe('started')

    const topUps = await topUpQueue(P)
    expect(Array.isArray(topUps)).toBe(true) // no funds policy shortfall in this world
  })

  it('held-funds preview refuses honestly with nothing to apply; the runs read renders', async () => {
    // No entitlement to held money exists in this world: the preview refuses
    // typed rather than manufacturing an empty run. The full
    // preview→commit→authorise round-trip is the billing-runs suite's.
    await expect(previewHeldFundsApplication(P, { matter: fx.matter })).rejects.toMatchObject({
      code: 'nothing_to_apply',
    })
    // the firm-wide scope resolver: THIS world's matter holds no
    // entitlement, so it never appears in the blank-preview scope (the
    // shared scratch hosts other worlds' rows — assert our own, never
    // world totals)
    expect(await heldFundsFirmScope(P)).not.toContain(fx.matter)
    const runs = await heldFundsRuns(P)
    expect(Array.isArray(runs)).toBe(true)
    if (runs.length > 0) {
      const detail = await heldFundsRunDetail(P, runs[0].id as number)
      expect(detail.items).toBeDefined()
    }
  })

  it('rates admin: charge rates listed; cost rates only under the capability', async () => {
    const flagsBefore = await billingViewerFlags(P)
    const grantedHere = !flagsBefore.seesCostRates
    if (grantedHere) {
      await setRoleCapability(P, {
        role: fx.adminRole,
        capability: 'see_cost_rates',
        scope: 'firm_wide',
      })
    }
    try {
      await addStaffCostRate(P, { staff: fx.staff, rate: 150, effectiveFrom: '2020-01-01' })
      const data = await ratesAdmin(P)
      expect(data.seesCostRates).toBe(true)
      expect(data.staffRates.some((r) => r.staff === fx.staff)).toBe(true)
      expect(data.costRates.some((r) => r.staff === fx.staff && Number(r.rate) === 150)).toBe(true)
      expect(data.costTypes.length).toBeGreaterThanOrEqual(0)
    } finally {
      if (grantedHere) {
        await setRoleCapability(P, { role: fx.adminRole, capability: 'see_cost_rates', scope: 'none' })
      }
    }
  })

  it('payment details: a saved version governs and the screen says so', async () => {
    await savePaymentDetails(P, {
      accountHolderName: 'xbsc Trading Trust',
      bankName: 'Test Bank xbsc',
      identifierValues: { bsb: '000-000', account_number: '12345678' },
    })
    const screen = await paymentDetailsScreen(P)
    expect(screen.governing).not.toBeNull()
    expect(screen.governing!.account_holder_name).toBe('xbsc Trading Trust')
    expect(screen.requireApproval).toBe(false) // shipped default
    expect(screen.versions.length).toBeGreaterThanOrEqual(1)
  })
})
