// Billing: reminders, arrangements and their instalment jobs, channel
// events (incl. the client-money settlement route), and the funds half of
// top-ups. Sorts after billing-issue.test.ts and before
// billing-runs.test.ts; touches no global setting. Scheduler assertions are
// bill-scoped (the working sets sweep the shared scratch database).

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import type { Pool } from 'pg'
import { closePool } from '@/lib/db'
import type { Principal } from '@/lib/db'
import { createMatter } from '@/lib/ops/matters'
import {
  addStaffRate,
  createTimeEntry,
  createDraftBillGroup,
  issueBillGroup,
  recordPayment,
  createReminderSequence,
  runReminderScheduler,
  holdReminder,
  releaseReminder,
  assignReminderSequence,
  createArrangement,
  reactivateArrangement,
  cancelArrangement,
  runInstalmentNotifications,
  runInstalmentCollections,
  runMissedInstalmentDetection,
  startChannelPayment,
  failChannelPayment,
  settleChannelPayment,
  generateStatement,
  setFundsPolicy,
  evaluateFundsPolicy,
  confirmTopUpRequest,
} from '@/lib/ops/billing'
import { makeAdminPool, buildFixture, type Fixture } from './helpers'

let admin: Pool
let fx: Fixture
let P: Principal
let CH: Principal // the channel's integration principal
let tplEmail: number
let tplText: number
let tplTask: number
let seqDefault: number
let seqTask: number

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

/** Issue one bill worth `units × 40.00`, back-dated so it is already due. */
async function issuedBill(units: number, issueDaysAgo = 30): Promise<{ bill: number; matter: number }> {
  const m = await newMatter(`bpost host ${units}-${issueDaysAgo}-${Math.random().toString(36).slice(2, 6)}`)
  const e = await createTimeEntry(P, {
    matter: m,
    workDate: dateStr(1),
    units,
    narrative: `bpost work ${units}`,
  })
  const g = await createDraftBillGroup(P, { matter: m, timeEntries: [e.id] })
  const issued = await issueBillGroup(P, { group: g.group, issueDate: dateStr(issueDaysAgo) })
  return { bill: issued.bills[0].id, matter: m }
}

beforeAll(async () => {
  admin = makeAdminPool()
  fx = await buildFixture(admin, 'bpost')
  P = { kind: 'staff', id: fx.staff, firm: fx.firm }
  CH = { kind: 'integration_key', id: 900901, firm: fx.firm }
  await addStaffRate(P, { staff: fx.staff, rate: 400, effectiveFrom: '2020-01-01' })
  await admin.query(
    `insert into deedbox.contact_point (party, kind, value, is_primary)
     values ($1, 'email', 'client.bpost@example.test', true),
            ($1, 'phone', '+61400000001', true)`,
    [fx.clientParty],
  )
  const t1 = await admin.query(
    `insert into deedbox.message_template (name, channel, purpose, subject, body, tokens_used)
     values ('First reminder bpost', 'email', 'bill_reminder',
             'Bill {{bill_number}}', 'Dear {{client_name}}, {{amount_outstanding}} remains on {{bill_number}}. Pay at {{payment_link}}.',
             '["bill_number","client_name","amount_outstanding","payment_link"]') returning id`,
  )
  tplEmail = t1.rows[0].id
  const t2 = await admin.query(
    `insert into deedbox.message_template (name, channel, purpose, subject, body, tokens_used)
     values ('Text reminder bpost', 'text_message', 'bill_reminder', null,
             '{{firm_name}}: {{amount_outstanding}} outstanding on {{bill_number}}.',
             '["firm_name","amount_outstanding","bill_number"]') returning id`,
  )
  tplText = t2.rows[0].id
  const t3 = await admin.query(
    `insert into deedbox.message_template (name, channel, purpose, subject, body, tokens_used)
     values ('Call about bill bpost', 'task', 'bill_reminder', null,
             'Telephone {{client_name}} about {{bill_number}}',
             '["client_name","bill_number"]') returning id`,
  )
  tplTask = t3.rows[0].id
  await admin.query(
    `insert into deedbox.message_template (name, channel, purpose, subject, body, tokens_used)
     values ('Instalment notice bpost', 'email', 'instalment_notice', 'Instalment due',
             'Your instalment of {{amount}} falls due on {{due_date}}.', '["amount","due_date"]')`,
  )
})

afterAll(async () => {
  await closePool()
  await admin.end()
})

describe('reminder configuration and scheduling', () => {
  it('validates step channels against templates; a new default demotes the old', async () => {
    await expect(
      createReminderSequence(P, {
        name: 'Mismatched bpost',
        steps: [{ stepNo: 1, daysAfterPrevious: 0, channel: 'text_message', template: tplEmail }],
      }),
    ).rejects.toMatchObject({ code: 'channel_mismatch' })

    const a = await createReminderSequence(P, {
      name: 'Throwaway default bpost',
      defaultForNewBills: true,
      steps: [{ stepNo: 1, daysAfterPrevious: 0, channel: 'email', template: tplEmail }],
    })
    const b = await createReminderSequence(P, {
      name: 'Working default bpost',
      defaultForNewBills: true,
      steps: [
        { stepNo: 1, daysAfterPrevious: 0, channel: 'email', template: tplEmail },
        { stepNo: 2, daysAfterPrevious: 5, channel: 'text_message', template: tplText },
      ],
    })
    seqDefault = b.id
    const flags = await admin.query(
      `select id, default_for_new_bills from deedbox.reminder_sequence where id = any($1)`,
      [[a.id, b.id]],
    )
    const byId = new Map(flags.rows.map((r) => [r.id, r.default_for_new_bills]))
    expect(byId.get(a.id)).toBe(false)
    expect(byId.get(b.id)).toBe(true)

    const t = await createReminderSequence(P, {
      name: 'Task chase bpost',
      steps: [{ stepNo: 1, daysAfterPrevious: 0, channel: 'task', template: tplTask }],
    })
    seqTask = t.id
  })

  it('a bill born under the default sequence runs from its due date', async () => {
    const { bill } = await issuedBill(10, 20) // due 6 days ago
    const st = await admin.query(
      `select sequence, status, current_step_no, next_step_at from deedbox.bill_reminder_state where bill = $1`,
      [bill],
    )
    expect(st.rowCount).toBe(1)
    expect(st.rows[0].sequence).toBe(seqDefault)
    expect(st.rows[0].status).toBe('running')
    expect(st.rows[0].current_step_no).toBe(0)
    expect(st.rows[0].next_step_at).not.toBeNull()
  })

  it('the scheduler sends step one exactly once, renders tokens, and registers the contact', async () => {
    const { bill, matter } = await issuedBill(10, 25)
    const r1 = await runReminderScheduler(P)
    const mine = r1.advanced.find((x) => x.bill === bill)
    expect(mine).toMatchObject({ stepNo: 1, channel: 'email' })

    const contact = await admin.query(
      `select c.step_no, c.channel, om.recipient, om.rendered_artefact
         from deedbox.reminder_contact c
         join deedbox.outbound_message om on om.id = c.outbound_message
        where c.bill = $1`,
      [bill],
    )
    expect(contact.rowCount).toBe(1)
    expect(contact.rows[0].recipient).toBe('client.bpost@example.test')
    const artefact = await admin.query(
      `select content_ref from deedbox.stored_artefact where id = $1::bigint`,
      [contact.rows[0].rendered_artefact],
    )
    const rendered = JSON.parse(artefact.rows[0].content_ref as string)
    expect(rendered.body).toContain('400.00 remains')
    expect(rendered.body).toContain('Pay at pay/')

    const reg = await admin.query(
      `select 1 from deedbox.register_entry
        where event_kind = 'reminder.contact_made' and subject_type = 'bill' and subject = $1 and matter = $2`,
      [bill, matter],
    )
    expect(reg.rowCount).toBe(1)

    // an immediate second run sends nothing more for this bill
    const r2 = await runReminderScheduler(P)
    expect(r2.advanced.find((x) => x.bill === bill)).toBeUndefined()
    const count = await admin.query(
      `select count(*)::int as n from deedbox.reminder_contact where bill = $1`,
      [bill],
    )
    expect(count.rows[0].n).toBe(1)
  })

  it('manual hold keeps the scheduler away; release resumes without skipping', async () => {
    const { bill } = await issuedBill(10, 25)
    await holdReminder(P, { bill, reason: 'client conversation underway' })
    const r = await runReminderScheduler(P)
    expect(r.advanced.find((x) => x.bill === bill)).toBeUndefined()
    await releaseReminder(P, { bill })
    const st = await admin.query(
      `select status, current_step_no from deedbox.bill_reminder_state where bill = $1`,
      [bill],
    )
    expect(st.rows[0].status).toBe('running')
    expect(st.rows[0].current_step_no).toBe(0) // nothing skipped
  })

  it('the scheduler re-verifies inside the sending transaction: a paid bill stops instead', async () => {
    const { bill } = await issuedBill(5, 25) // 200.00
    await recordPayment(P, {
      receivedDate: dateStr(1),
      amount: 200,
      method: 'bank_transfer',
      allocations: [{ bill, amount: 200 }],
    })
    // paying already stopped it; force it back into the working set to prove
    // the in-transaction re-verification catches a stale row
    await admin.query(
      `update deedbox.bill_reminder_state set status = 'running', next_step_at = now() - interval '1 minute'
        where bill = $1`,
      [bill],
    )
    const r = await runReminderScheduler(P)
    expect(r.stopped.find((x) => x.bill === bill)).toMatchObject({ to: 'stopped_paid' })
    const contacts = await admin.query(
      `select count(*)::int as n from deedbox.reminder_contact where bill = $1`,
      [bill],
    )
    expect(contacts.rows[0].n).toBe(0)
  })

  it('task steps create the task and the sequence exhausts after its last step', async () => {
    const { bill, matter } = await issuedBill(10, 25)
    await assignReminderSequence(P, { bill, sequence: seqTask })
    const r = await runReminderScheduler(P)
    expect(r.advanced.find((x) => x.bill === bill)).toMatchObject({ stepNo: 1, channel: 'task' })
    const task = await admin.query(
      `select t.title, t.owner, t.origin from deedbox.task t
        join deedbox.reminder_contact c on c.task = t.id
       where c.bill = $1`,
      [bill],
    )
    expect(task.rowCount).toBe(1)
    expect(task.rows[0].origin).toBe('reminder_step')
    expect(task.rows[0].owner).toBe(fx.staff)
    expect(task.rows[0].title).toContain('Telephone')
    const st = await admin.query(
      `select status from deedbox.bill_reminder_state where bill = $1`,
      [bill],
    )
    expect(st.rows[0].status).toBe('exhausted')
    void matter

    // assigning a fresh sequence restarts the count
    await assignReminderSequence(P, { bill, sequence: seqDefault })
    const st2 = await admin.query(
      `select status, current_step_no, sequence from deedbox.bill_reminder_state where bill = $1`,
      [bill],
    )
    expect(st2.rows[0].status).toBe('running')
    expect(st2.rows[0].current_step_no).toBe(0)
    expect(st2.rows[0].sequence).toBe(seqDefault)
  })
})

describe('arrangements and instalment jobs', () => {
  let b1: number
  let b2: number
  let arr1: number

  it('creates an arrangement: reminders stop, a second cover is refused', async () => {
    const x1 = await issuedBill(10, 30) // 400.00
    const x2 = await issuedBill(5, 30) // 200.00
    b1 = x1.bill
    b2 = x2.bill
    const a = await createArrangement(P, {
      clientParty: fx.clientParty,
      instalmentAmount: 150,
      frequency: 'weekly',
      instalmentCount: 4,
      firstDueDate: dateStr(-2),
      bills: [b1, b2],
    })
    arr1 = a.id
    expect(a.instalments.length).toBe(4)
    const st = await admin.query(
      `select bill, status from deedbox.bill_reminder_state where bill = any($1)`,
      [[b1, b2]],
    )
    for (const r of st.rows) expect(r.status).toBe('stopped_arrangement')
    await expect(
      createArrangement(P, {
        clientParty: fx.clientParty,
        instalmentAmount: 100,
        frequency: 'monthly',
        instalmentCount: 2,
        firstDueDate: dateStr(-2),
        bills: [b1],
      }),
    ).rejects.toMatchObject({ code: 'already_covered' })
  })

  it('cumulative coverage flips instalments inside the allocating transaction', async () => {
    await recordPayment(P, {
      receivedDate: dateStr(1),
      amount: 500,
      method: 'bank_transfer',
      allocations: [
        { bill: b1, amount: 400 },
        { bill: b2, amount: 100 },
      ],
    })
    const inst = await admin.query(
      `select sequence_no, state from deedbox.instalment where arrangement = $1 order by sequence_no`,
      [arr1],
    )
    expect(inst.rows.map((r) => r.state)).toEqual(['paid', 'paid', 'paid', 'scheduled'])
  })

  it('missed detection breaks the arrangement and resumes reminders', async () => {
    const x3 = await issuedBill(10, 40)
    const a = await createArrangement(P, {
      clientParty: fx.clientParty,
      instalmentAmount: 100,
      frequency: 'weekly',
      instalmentCount: 2,
      firstDueDate: dateStr(10),
      bills: [x3.bill],
    })
    const r = await runMissedInstalmentDetection(P)
    expect(r.broken).toContain(a.id)
    const inst = await admin.query(
      `select state from deedbox.instalment where arrangement = $1 order by sequence_no`,
      [a.id],
    )
    expect(inst.rows.map((x) => x.state)).toEqual(['missed', 'missed'])
    const st = await admin.query(
      `select status from deedbox.bill_reminder_state where bill = $1`,
      [x3.bill],
    )
    expect(st.rows[0].status).toBe('running')

    // reactivation appends replacement slots on the new ladder
    await reactivateArrangement(P, { arrangement: a.id, newFirstDueDate: dateStr(-7) })
    const after = await admin.query(
      `select sequence_no, state, due_date::text as due from deedbox.instalment
        where arrangement = $1 order by sequence_no`,
      [a.id],
    )
    expect(after.rowCount).toBe(4)
    expect(after.rows.map((x) => x.state)).toEqual(['missed', 'missed', 'scheduled', 'scheduled'])
    expect(after.rows[2].due).toBe(dateStr(-7))
    const st2 = await admin.query(
      `select status from deedbox.bill_reminder_state where bill = $1`,
      [x3.bill],
    )
    expect(st2.rows[0].status).toBe('stopped_arrangement')

    // cancellation resumes the reminders and is terminal
    await cancelArrangement(P, { arrangement: a.id, reason: 'client asked to pay in full' })
    const st3 = await admin.query(
      `select status from deedbox.bill_reminder_state where bill = $1`,
      [x3.bill],
    )
    expect(st3.rows[0].status).toBe('running')
    const arr = await admin.query(
      `select state from deedbox.payment_arrangement where id = $1`,
      [a.id],
    )
    expect(arr.rows[0].state).toBe('cancelled')
  })

  it('notification and collection jobs walk the instalment machine; settlement pays and allocates', async () => {
    const x4 = await issuedBill(10, 35) // 400.00 outstanding
    const a = await createArrangement(P, {
      clientParty: fx.clientParty,
      instalmentAmount: 120,
      frequency: 'weekly',
      instalmentCount: 2,
      firstDueDate: dateStr(0), // due now → inside the notice window AND collectable
      storedMethodRef: 'tok_bpost_1',
      bills: [x4.bill],
    })
    const n1 = await runInstalmentNotifications(P)
    const instRow = await admin.query(
      `select id, state, notified_at from deedbox.instalment
        where arrangement = $1 and sequence_no = 1`,
      [a.id],
    )
    expect(n1.notified).toContain(instRow.rows[0].id)
    expect(instRow.rows[0].state).toBe('notified')
    const notice = await admin.query(
      `select 1 from deedbox.outbound_message where purpose = 'instalment_notice' and related = $1`,
      [instRow.rows[0].id],
    )
    expect(notice.rowCount).toBe(1)
    const n2 = await runInstalmentNotifications(P)
    expect(n2.notified).not.toContain(instRow.rows[0].id)

    const c = await runInstalmentCollections(P)
    expect(c.collecting).toContain(instRow.rows[0].id)
    const collecting = await admin.query(
      `select i.state, i.channel_payment, cp.channel_event_ref
         from deedbox.instalment i join deedbox.channel_payment cp on cp.id = i.channel_payment
        where i.id = $1`,
      [instRow.rows[0].id],
    )
    expect(collecting.rows[0].state).toBe('collecting')

    const settled = await settleChannelPayment(CH, {
      channel: 'stored_method',
      channelEventRef: collecting.rows[0].channel_event_ref as string,
    })
    expect(settled.receiptType).toBe('receivable_payment')
    const paid = await admin.query(`select state from deedbox.instalment where id = $1`, [
      instRow.rows[0].id,
    ])
    expect(paid.rows[0].state).toBe('paid')
    // the 120.00 landed on the covered bill oldest-first
    const o = await admin.query(`select deedbox.bill_outstanding($1) as o`, [x4.bill])
    expect(cents(o.rows[0].o)).toBe(40000 - 12000)
  })
})

describe('channel events and settlement, top-ups', () => {
  it('started rows demand an active reference, record mismatches, and replay idempotently', async () => {
    await expect(
      startChannelPayment(CH, {
        channel: 'web_pay',
        channelEventRef: 'evt-none-1',
        referenceCode: 'no-such-code',
        method: 'card',
        amount: 50,
      }),
    ).rejects.toMatchObject({ code: 'reference_unknown' })

    const { bill } = await issuedBill(5, 15) // 200.00
    await admin.query(
      `insert into deedbox.payment_reference (code, target_kind, target, expected_amount)
       values ('bpost-bill-ref-1', 'bill', $1, deedbox.bill_outstanding($1))`,
      [bill],
    )
    const s1 = await startChannelPayment(CH, {
      channel: 'web_pay',
      channelEventRef: 'evt-start-1',
      referenceCode: 'bpost-bill-ref-1',
      method: 'card',
      amount: 250, // more than expected: recorded verbatim, not refused
    })
    expect(s1.replay).toBe(false)
    const s2 = await startChannelPayment(CH, {
      channel: 'web_pay',
      channelEventRef: 'evt-start-1',
      referenceCode: 'bpost-bill-ref-1',
      method: 'card',
      amount: 250,
    })
    expect(s2).toEqual({ id: s1.id, replay: true })
    const hist = await admin.query(
      `select state_history -> 0 ->> 'expected_amount' as exp from deedbox.channel_payment where id = $1`,
      [s1.id],
    )
    expect(Number(hist.rows[0].exp)).toBe(200)

    // settlement: office route (no pack declaration, shipped setting) —
    // allocation up to outstanding, the surplus stays on the payment
    const settled = await settleChannelPayment(CH, {
      channel: 'web_pay',
      channelEventRef: 'evt-start-1',
    })
    expect(settled.receiptType).toBe('receivable_payment')
    const o = await admin.query(`select deedbox.bill_outstanding($1) as o`, [bill])
    expect(cents(o.rows[0].o)).toBe(0)
    const pay = await admin.query(
      `select amount, source, channel_payment from deedbox.receivable_payment where id = $1`,
      [settled.receipt],
    )
    expect(pay.rows[0].source).toBe('channel')
    expect(cents(pay.rows[0].amount)).toBe(25000)
    const remainder = await admin.query(
      `select p.amount + coalesce(sum(j.signed_amount), 0) as rem
         from deedbox.receivable_payment p
         left join deedbox.bill_journal_entry j
           on j.source_type = 'receivable_payment' and j.source = p.id
          and j.entry_kind in ('payment_allocation','reversal')
        where p.id = $1 group by p.id, p.amount`,
      [settled.receipt],
    )
    expect(cents(remainder.rows[0].rem)).toBe(5000)
    const ref = await admin.query(
      `select active from deedbox.payment_reference where code = 'bpost-bill-ref-1'`,
    )
    expect(ref.rows[0].active).toBe(false)

    // replay of the settlement returns the stored outcome
    const again = await settleChannelPayment(CH, {
      channel: 'web_pay',
      channelEventRef: 'evt-start-1',
    })
    expect(again.replay).toBe(true)
    expect(again.receipt).toBe(settled.receipt)
  })

  it('failure is terminal and exclusive with settlement', async () => {
    const { bill } = await issuedBill(5, 15)
    await admin.query(
      `insert into deedbox.payment_reference (code, target_kind, target)
       values ('bpost-bill-ref-2', 'bill', $1)`,
      [bill],
    )
    await startChannelPayment(CH, {
      channel: 'web_pay',
      channelEventRef: 'evt-start-2',
      referenceCode: 'bpost-bill-ref-2',
      method: 'card',
      amount: 100,
    })
    await failChannelPayment(CH, { channel: 'web_pay', channelEventRef: 'evt-start-2' })
    await expect(
      settleChannelPayment(CH, { channel: 'web_pay', channelEventRef: 'evt-start-2' }),
    ).rejects.toMatchObject({ code: 'already_failed' })
    await expect(
      failChannelPayment(CH, { channel: 'web_pay', channelEventRef: 'evt-start-1' }),
    ).rejects.toMatchObject({ code: 'already_settled' })
    // a failed row contributes to no figure: its bill still owes everything
    const o = await admin.query(`select deedbox.bill_outstanding($1) as o`, [bill])
    expect(cents(o.rows[0].o)).toBe(20000)
  })

  it('the surcharge rule computes as channel evidence and never enters the receipt', async () => {
    const pv = await admin.query(
      `insert into deedbox.pack_version (pack, version)
       select id, '0.0.1' from deedbox.country_pack where code = 'xbpo' returning id, pack`,
    )
    await admin.query(
      `insert into deedbox.pack_declaration (pack_version, rule_point, kind, discriminator, body)
       values ($1, 'billing.surcharge', 'expression_formula', 'card', '{"method":"card","pct":1.5}')`,
      [pv.rows[0].id],
    )
    await admin.query(`update deedbox.country_pack set active_version = $1 where id = $2`, [
      pv.rows[0].id,
      pv.rows[0].pack,
    ])
    const { bill } = await issuedBill(5, 15)
    await admin.query(
      `insert into deedbox.payment_reference (code, target_kind, target)
       values ('bpost-bill-ref-3', 'bill', $1)`,
      [bill],
    )
    await startChannelPayment(CH, {
      channel: 'web_pay',
      channelEventRef: 'evt-start-3',
      referenceCode: 'bpost-bill-ref-3',
      method: 'card',
      amount: 100,
    })
    const settled = await settleChannelPayment(CH, {
      channel: 'web_pay',
      channelEventRef: 'evt-start-3',
    })
    expect(cents(settled.surcharge)).toBe(150)
    const row = await admin.query(
      `select surcharge_amount from deedbox.channel_payment where id = $1`,
      [settled.channelPayment],
    )
    expect(cents(row.rows[0].surcharge_amount)).toBe(150)
    const pay = await admin.query(
      `select amount from deedbox.receivable_payment where id = $1`,
      [settled.receipt],
    )
    expect(cents(pay.rows[0].amount)).toBe(10000) // the surcharge never enters
  })

  it('a statement reference settles across its bills oldest-first', async () => {
    const m = await newMatter('bpost statement settle')
    const e1 = await createTimeEntry(P, { matter: m, workDate: dateStr(1), units: 5, narrative: 'stmt old work' })
    const g1 = await createDraftBillGroup(P, { matter: m, timeEntries: [e1.id] })
    const bOld = (await issueBillGroup(P, { group: g1.group, issueDate: dateStr(50) })).bills[0].id
    const e2 = await createTimeEntry(P, { matter: m, workDate: dateStr(1), units: 5, narrative: 'stmt new work' })
    const g2 = await createDraftBillGroup(P, { matter: m, timeEntries: [e2.id] })
    const bNew = (await issueBillGroup(P, { group: g2.group, issueDate: dateStr(20) })).bills[0].id

    const s = await generateStatement(P, { scopeKind: 'matter', scope: m, withPaymentReference: true })
    const ref = await admin.query(
      `select code from deedbox.payment_reference where target_kind = 'statement' and target = $1`,
      [s.id],
    )
    await startChannelPayment(CH, {
      channel: 'web_pay',
      channelEventRef: 'evt-stmt-1',
      referenceCode: ref.rows[0].code as string,
      method: 'card',
      amount: 300,
    })
    const settled = await settleChannelPayment(CH, { channel: 'web_pay', channelEventRef: 'evt-stmt-1' })
    expect(settled.receiptType).toBe('receivable_payment')
    const oOld = await admin.query(`select deedbox.bill_outstanding($1) as o`, [bOld])
    const oNew = await admin.query(`select deedbox.bill_outstanding($1) as o`, [bNew])
    expect(cents(oOld.rows[0].o)).toBe(0) // oldest first, fully
    expect(cents(oNew.rows[0].o)).toBe(10000) // then 100.00 of the newer
    // 300 paid of the statement's 400 expectation: the reference lives on
    const still = await admin.query(
      `select active from deedbox.payment_reference where target_kind = 'statement' and target = $1`,
      [s.id],
    )
    expect(still.rows[0].active).toBe(true)
  })

  it('a funds shortfall raises one request and one alert atomically; settlement lands in client money and re-arms', async () => {
    const m = await newMatter('bpost funds matter')
    const ledger = await admin.query(
      `insert into deedbox.matter_ledger (account, matter) values ($1, $2) returning id`,
      [fx.account, m],
    )
    await setFundsPolicy(P, { matter: m, minimumThreshold: 500, targetAmount: 1000 })

    const g1 = await evaluateFundsPolicy(P, { matter: m })
    expect(g1.generated).not.toBeNull()
    const g2 = await evaluateFundsPolicy(P, { matter: m })
    expect(g2.generated).toBeNull() // one open request + once per arming, structurally

    const req = await admin.query(
      `select t.id, t.state, t.request_number, t.amount_requested, t.funds_policy
         from deedbox.top_up_request t where t.id = $1`,
      [g1.generated],
    )
    expect(req.rows[0].state).toBe('pending_confirmation')
    expect(req.rows[0].request_number).toMatch(/^TU-/)
    expect(cents(req.rows[0].amount_requested)).toBe(100000) // target 1000 − available 0
    const alert = await admin.query(
      `select 1 from deedbox.threshold_alert
        where subject_type = 'funds_policy' and subject = $1 and threshold_pct = 100 and arming_version = 1`,
      [req.rows[0].funds_policy],
    )
    expect(alert.rowCount).toBe(1)

    await confirmTopUpRequest(P, { request: g1.generated! })
    const ref = await admin.query(
      `select r.code from deedbox.payment_reference r
        join deedbox.top_up_request t on t.payment_reference = r.id
       where t.id = $1`,
      [g1.generated],
    )
    await startChannelPayment(CH, {
      channel: 'web_pay',
      channelEventRef: 'evt-topup-1',
      referenceCode: ref.rows[0].code as string,
      method: 'card',
      amount: 700,
    })
    const settled = await settleChannelPayment(CH, {
      channel: 'web_pay',
      channelEventRef: 'evt-topup-1',
    })
    expect(settled.receiptType).toBe('money_receipt')

    const receipt = await admin.query(
      `select mr.amount, mr.top_up_request, mr.matter_ledger, mr.receipt_number
         from deedbox.money_receipt mr where mr.id = $1`,
      [settled.receipt],
    )
    expect(cents(receipt.rows[0].amount)).toBe(70000)
    expect(receipt.rows[0].top_up_request).toBe(g1.generated)
    expect(receipt.rows[0].receipt_number).toMatch(/^R-/)
    const balance = await admin.query(`select deedbox.ledger_balance($1) as b`, [
      ledger.rows[0].id,
    ])
    expect(cents(balance.rows[0].b)).toBe(70000)

    const after = await admin.query(
      `select t.state, fp.arming_version from deedbox.top_up_request t
        join deedbox.matter_funds_policy fp on fp.id = t.funds_policy
       where t.id = $1`,
      [g1.generated],
    )
    expect(after.rows[0].state).toBe('satisfied')
    expect(after.rows[0].arming_version).toBe(2) // 700 ≥ 500: re-armed
  })

  it('issue auto-adds new bills to a covers-future arrangement, reminder born stopped', async () => {
    await createArrangement(P, {
      clientParty: fx.clientParty,
      coversFutureBills: true,
      instalmentAmount: 100,
      frequency: 'monthly',
      instalmentCount: 2,
      firstDueDate: dateStr(-3),
      bills: [],
    })
    const { bill } = await issuedBill(5, 1)
    const cover = await admin.query(
      `select a.covers_future_bills from deedbox.arrangement_bill ab
        join deedbox.payment_arrangement a on a.id = ab.arrangement
       where ab.bill = $1`,
      [bill],
    )
    expect(cover.rowCount).toBe(1)
    expect(cover.rows[0].covers_future_bills).toBe(true)
    const st = await admin.query(
      `select status from deedbox.bill_reminder_state where bill = $1`,
      [bill],
    )
    expect(st.rows[0].status).toBe('stopped_arrangement')
  })
})
