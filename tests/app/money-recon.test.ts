// Client money, second increment: bank lines + the reconciliation
// workspace, period close, dormancy, client statements, statutory registers,
// incidents, the cross-account transfer and the clearance display. Runs after
// money-core; the dormancy sweep runs LAST in this file because a zero-month
// pack period makes every funded ledger a candidate.

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import type { Pool } from 'pg'
import { closePool } from '@/lib/db'
import type { Principal } from '@/lib/db'
import { MoneyRefusal } from '@/lib/db'
import { createMatter } from '@/lib/ops/matters'
import { addStaffRate } from '@/lib/ops/billing'
import {
  recordMoneyReceipt,
  draftMoneyPayment,
  submitMoneyPayment,
  authoriseMoneyPayment,
  executeMoneyPayment,
  authoriseTransferIntent,
  crossAccountTransfer,
  ingestBankStatementLines,
  buildReconciliation,
  createMatchGroup,
  createReconException,
  resolveReconException,
  certifyReconciliation,
  openPeriodClose,
  certifyPeriodClose,
  runDormancyDetection,
  recordContactAttempt,
  resolveDormantCase,
  executeRemittance,
  generateClientMoneyStatement,
  issueClientMoneyStatement,
  appendStatutoryRegisterEntry,
  promoteRefusalToIncident,
  rectifyIncident,
  reportIncident,
  matterMoneyClearance,
  createClientAccount,
} from '@/lib/ops/money'
import { makeAdminPool, buildFixture, addStaff, type Fixture } from './helpers'

let admin: Pool
let fx: Fixture
let P: Principal
let S: Principal

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
  fx = await buildFixture(admin, 'mrec')
  P = { kind: 'staff', id: fx.staff, firm: fx.firm }
  S = { kind: 'staff', id: await addStaff(admin, fx, 'sam.mrec'), firm: fx.firm }
  await addStaffRate(P, { staff: fx.staff, rate: 400, effectiveFrom: '2020-01-01' })
  const pv = await admin.query(
    `insert into deedbox.pack_version (pack, version)
     select id, '0.0.1' from deedbox.country_pack where code = 'xmre' returning id, pack`,
  )
  await admin.query(
    `insert into deedbox.pack_declaration (pack_version, rule_point, kind, body)
     values ($1, 'money.dormancy', 'value',
             '{"dormant_after_months": 0, "minimum_contact_attempts": 1}')`,
    [pv.rows[0].id],
  )
  await admin.query(
    `insert into deedbox.pack_declaration (pack_version, rule_point, kind, discriminator, body)
     values ($1, 'registers.statutory', 'register_schema', 'trust_receipt_register',
             '{"name":"Trust receipt register","columns":[{"key":"received_from","required":true},{"key":"amount","required":true},{"key":"form","required":false}]}')`,
    [pv.rows[0].id],
  )
  await admin.query(`update deedbox.country_pack set active_version = $1 where id = $2`, [
    pv.rows[0].id,
    pv.rows[0].pack,
  ])
})

afterAll(async () => {
  await closePool()
  await admin.end()
})

describe('bank lines and the reconciliation workspace', () => {
  let matter: number
  let ledger: number
  let receiptTxn: number
  let chequePayTxn: number
  let reconId: number

  beforeAll(async () => {
    matter = await newMatter('Recon host mrec')
    const r1 = await recordMoneyReceipt(P, {
      matter,
      account: fx.account,
      amount: 900,
      method: 'electronic_transfer',
      payerDescription: 'client deposit',
      receivedDate: dateStr(10),
    })
    ledger = r1.ledger
    receiptTxn = r1.transaction
    // a cheque payment out, still unpresented at the statement date
    const d = await draftMoneyPayment(P, {
      matterLedger: ledger,
      amount: 200,
      method: 'cheque',
      reason: 'counsel fee by cheque',
      payeeDescription: 'Counsel chambers',
    })
    await submitMoneyPayment(P, { payment: d.id })
    await authoriseMoneyPayment(S, { payment: d.id })
    const ex = await executeMoneyPayment(P, { payment: d.id })
    chequePayTxn = ex.transaction
  })

  it('feed lines ingest idempotently', async () => {
    const first = await ingestBankStatementLines(P, {
      account: fx.account,
      source: 'bank_feed',
      lines: [
        { lineDate: dateStr(10), amount: 900, description: 'DEPOSIT CLIENT', feedRef: 'feed-mrec-1' },
      ],
    })
    expect(first.inserted.length).toBe(1)
    const replay = await ingestBankStatementLines(P, {
      account: fx.account,
      source: 'bank_feed',
      lines: [
        { lineDate: dateStr(10), amount: 900, description: 'DEPOSIT CLIENT', feedRef: 'feed-mrec-1' },
      ],
    })
    expect(replay.inserted.length).toBe(0)
    expect(replay.replayed).toBe(1)
  })

  it('the build is one per account and generates the unpresented-cheque exception', async () => {
    // the cheque payment posted with today's date: the statement date must
    // cover it for the exception population and the equation's book side
    const b = await buildReconciliation(P, {
      account: fx.account,
      statementDate: dateStr(0),
      statementBalance: 900, // the cheque has not hit the bank
    })
    reconId = b.id
    expect(b.instrumentExceptions).toBe(1)
    await expect(
      buildReconciliation(P, { account: fx.account, statementDate: dateStr(-1), statementBalance: 1 }),
    ).rejects.toMatchObject({ code: 'build_exists' })
    const exc = await admin.query(
      `select exception_type, linked_type, amount from deedbox.recon_exception
        where reconciliation = $1`,
      [reconId],
    )
    expect(exc.rows[0].exception_type).toBe('unpresented_payment')
    expect(exc.rows[0].linked_type).toBe('instrument')
    expect(cents(exc.rows[0].amount)).toBe(20000)
  })

  it('certification refuses while a statement line is uncovered, then passes and transitions nothing early', async () => {
    await expect(certifyReconciliation(P, { reconciliation: reconId })).rejects.toThrow(
      /neither matched nor excepted/,
    )
    const line = await admin.query(
      `select id from deedbox.bank_statement_line where account = $1 and feed_ref = 'feed-mrec-1'`,
      [fx.account],
    )
    await createMatchGroup(P, {
      reconciliation: reconId,
      statementLines: [line.rows[0].id],
      transactions: [receiptTxn],
    })
    const c = await certifyReconciliation(P, { reconciliation: reconId })
    const snap = c.equationSnapshot as {
      statement_balance: number
      unpresented_payments: number
      ledger_total: number
    }
    expect(cents(snap.statement_balance)).toBe(90000)
    expect(cents(snap.unpresented_payments)).toBe(20000)
    expect(cents(snap.ledger_total)).toBe(70000)
    // the cheque stays unpresented (its transaction was not in a match group)
    const inst = await admin.query(
      `select state from deedbox.instrument where transaction = $1`,
      [chequePayTxn],
    )
    expect(inst.rows[0].state).toBe('created')
  })

  it('the next build carries the open exception forward with lineage; a match presents the cheque', async () => {
    await ingestBankStatementLines(P, {
      account: fx.account,
      source: 'bank_feed',
      lines: [
        { lineDate: dateStr(0), amount: -200, description: 'CHEQUE 001', feedRef: 'feed-mrec-2' },
      ],
    })
    const b2 = await buildReconciliation(P, {
      account: fx.account,
      statementDate: dateStr(-1),
      statementBalance: 700,
    })
    // the prior open instrument exception CARRIES (lineage, original arising
    // date) — never a fresh duplicate that would strand the prior
    expect(b2.instrumentExceptions).toBe(0)
    expect(b2.carriedForward).toBe(1)
    const line2 = await admin.query(
      `select id from deedbox.bank_statement_line where account = $1 and feed_ref = 'feed-mrec-2'`,
      [fx.account],
    )
    const successor = await admin.query(
      `select id, arising_date::text as arising, first_reconciliation
         from deedbox.recon_exception where reconciliation = $1 and state = 'open'`,
      [b2.id],
    )
    expect(successor.rowCount).toBe(1)
    expect(successor.rows[0].first_reconciliation).toBe(reconId) // lineage
    await createMatchGroup(P, {
      reconciliation: b2.id,
      statementLines: [line2.rows[0].id],
      transactions: [chequePayTxn],
    })
    await resolveReconException(P, {
      reconciliation: b2.id,
      exception: successor.rows[0].id,
      resolutionNote: 'cheque presented on this statement',
    })
    await certifyReconciliation(P, { reconciliation: b2.id })
    const inst = await admin.query(
      `select state from deedbox.instrument where transaction = $1`,
      [chequePayTxn],
    )
    expect(inst.rows[0].state).toBe('presented')
    // the prior certified build's exception shows the carry, lineage intact
    const prior = await admin.query(
      `select state, carried_to from deedbox.recon_exception where reconciliation = $1`,
      [reconId],
    )
    expect(prior.rows[0].state).toBe('carried_forward')
    expect(prior.rows[0].carried_to).toBe(successor.rows[0].id)
  })

  it('the period close certifies against the schema-written listing and locks the period', async () => {
    const close = await openPeriodClose(P, {
      account: fx.account,
      periodStart: dateStr(40),
      periodEnd: dateStr(20),
    })
    const c = await certifyPeriodClose(P, { close: close.id })
    expect(c.late).toBe(false)
    const listing = await admin.query(
      `select count(*)::int as n, coalesce(sum(balance), 0) as total
         from deedbox.balance_listing_line where close = $1`,
      [close.id],
    )
    expect(listing.rows[0].n).toBeGreaterThan(0)
    // a back-dated posting into the certified period is refused and captured
    await expect(
      recordMoneyReceipt(P, {
        matter: (await admin.query(`select matter from deedbox.matter_ledger where id = $1`, [ledger])).rows[0].matter,
        account: fx.account,
        amount: 10,
        method: 'electronic_transfer',
        payerDescription: 'late arrival',
        receivedDate: dateStr(30),
      }),
    ).rejects.toThrow(MoneyRefusal)
    const k11 = await admin.query(
      `select 1 from deedbox.refused_operation
        where account = $1 and refusal_reason = 'period_locked'`,
      [fx.account],
    )
    expect(k11.rowCount).toBeGreaterThan(0)
  })

  it('the clearance display reports the position with warnings only', async () => {
    const r = await matterMoneyClearance(P, { matter })
    expect(r.ledgers.length).toBe(1)
    expect(cents(r.ledgers[0].balance)).toBe(70000)
    expect(r.ledgers[0].dormantWarning).toBe(false)
  })
})

describe('statements, statutory registers, incidents, cross-account', () => {
  it('a client money statement generates from lines and issues exactly once', async () => {
    const m = await newMatter('Statement host mrec')
    const r = await recordMoneyReceipt(P, {
      matter: m,
      account: fx.account,
      amount: 300,
      method: 'electronic_transfer',
      payerDescription: 'deposit',
    })
    const s = await generateClientMoneyStatement(P, {
      matterLedger: r.ledger,
      periodStart: dateStr(30),
      periodEnd: dateStr(0),
    })
    expect(s.statementNumber).toMatch(/^S-/)
    await issueClientMoneyStatement(P, {
      statement: s.id,
      channel: 'email',
      recipient: 'client.mrec@example.test',
    })
    await expect(
      issueClientMoneyStatement(P, { statement: s.id, channel: 'print' }),
    ).rejects.toMatchObject({ code: 'issued' })
    const row = await admin.query(
      `select issued_at, issue_channel, outbound_message from deedbox.client_money_statement where id = $1`,
      [s.id],
    )
    expect(row.rows[0].issue_channel).toBe('email')
    expect(row.rows[0].outbound_message).not.toBeNull()
  })

  it('statutory register entries validate against the pack schema and number densely', async () => {
    await expect(
      appendStatutoryRegisterEntry(P, {
        registerKey: 'trust_receipt_register',
        values: { received_from: 'Client A' }, // amount missing
      }),
    ).rejects.toMatchObject({ code: 'incomplete' })
    const e1 = await appendStatutoryRegisterEntry(P, {
      registerKey: 'trust_receipt_register',
      values: { received_from: 'Client A', amount: '300.00' },
    })
    const e2 = await appendStatutoryRegisterEntry(P, {
      registerKey: 'trust_receipt_register',
      values: { received_from: 'Client B', amount: '120.00', form: 'cheque' },
    })
    expect(e1.entryNo).toBe(1)
    expect(e2.entryNo).toBe(2)
    await expect(
      appendStatutoryRegisterEntry(P, {
        registerKey: 'no_such_register',
        values: {},
      }),
    ).rejects.toMatchObject({ code: 'register_undeclared' })
  })

  it('a captured refusal promotes to an incident exactly once, rectifies, and reports', async () => {
    const m = await newMatter('Incident host mrec')
    const r = await recordMoneyReceipt(P, {
      matter: m,
      account: fx.account,
      amount: 50,
      method: 'electronic_transfer',
      payerDescription: 'small deposit',
    })
    // stage the walled execution honestly (the draft-time stop refuses an
    // overdraw at entry): top up to draft, then drain before executing
    await recordMoneyReceipt(P, {
      matter: m,
      account: fx.account,
      amount: 40,
      method: 'electronic_transfer',
      payerDescription: 'staging funds',
    })
    const d = await draftMoneyPayment(P, {
      matterLedger: r.ledger,
      amount: 90,
      method: 'electronic_transfer',
      reason: 'overreach for the incident test',
      payeeDescription: 'Nobody',
    })
    await submitMoneyPayment(P, { payment: d.id })
    await authoriseMoneyPayment(S, { payment: d.id })
    const drain = await draftMoneyPayment(P, {
      matterLedger: r.ledger,
      amount: 40,
      method: 'electronic_transfer',
      reason: 'drain before the walled execution',
      payeeDescription: 'Drain payee',
    })
    await submitMoneyPayment(P, { payment: drain.id })
    await authoriseMoneyPayment(S, { payment: drain.id })
    await executeMoneyPayment(P, { payment: drain.id })
    // the ledger holds 50.00 again — the drafted 90.00 now exceeds it
    await expect(executeMoneyPayment(P, { payment: d.id })).rejects.toThrow(MoneyRefusal)
    const refusal = await admin.query(
      `select id from deedbox.refused_operation
        where matter_ledger = $1 and refusal_reason = 'would_go_below_zero'
        order by id desc limit 1`,
      [r.ledger],
    )
    const inc = await promoteRefusalToIncident(P, {
      refusal: refusal.rows[0].id,
      narrative: 'attempted payment beyond the held balance; reviewing supervision',
    })
    await expect(
      promoteRefusalToIncident(P, { refusal: refusal.rows[0].id, narrative: 'again' }),
    ).rejects.toMatchObject({ code: 'promoted' })
    await rectifyIncident(P, {
      incident: inc.incident,
      correctingTransactions: [r.transaction],
      note: 'payment cancelled; no money moved',
    })
    const reported = await reportIncident(P, { incident: inc.incident })
    expect(reported.artefact).toBeGreaterThan(0)
    const row = await admin.query(
      `select state, notification_artefact from deedbox.deficiency_incident where id = $1`,
      [inc.incident],
    )
    expect(row.rows[0].state).toBe('reported')
    expect(row.rows[0].notification_artefact).toBe(String(reported.artefact))
  })

  it('a cross-account transfer pairs the payment and receipt in one transaction under one intent', async () => {
    const m = await newMatter('Cross-account host mrec')
    const src = await recordMoneyReceipt(P, {
      matter: m,
      account: fx.account,
      amount: 400,
      method: 'electronic_transfer',
      payerDescription: 'source funding',
    })
    const controlled = await createClientAccount(P, {
      name: 'Controlled account mrec',
      accountKind: 'separate_per_matter',
      linkedMatter: m,
    })
    const destLedger = await admin.query(
      `insert into deedbox.matter_ledger (account, matter) values ($1, $2) returning id`,
      [controlled.id, m],
    )
    const intent = await authoriseTransferIntent(S, {
      fromLedger: src.ledger,
      toLedger: destLedger.rows[0].id,
      amount: 250,
      reason: 'moving to the controlled account per instructions',
    })
    const t = await crossAccountTransfer(P, {
      fromLedger: src.ledger,
      toLedger: destLedger.rows[0].id,
      amount: 250,
      reason: 'moving to the controlled account per instructions',
      authorisation: intent.authorisation,
    })
    expect(t.transferNumber).toMatch(/^T-/)
    const srcBal = await admin.query(`select deedbox.ledger_balance($1) as b`, [src.ledger])
    const dstBal = await admin.query(`select deedbox.ledger_balance($1) as b`, [
      destLedger.rows[0].id,
    ])
    expect(cents(srcBal.rows[0].b)).toBe(15000)
    expect(cents(dstBal.rows[0].b)).toBe(25000)
    const k7a = await admin.query(
      `select payment, receipt from deedbox.cross_account_transfer where transfer_number = $1`,
      [t.transferNumber],
    )
    expect(k7a.rows[0].payment).toBe(t.payment)
    expect(k7a.rows[0].receipt).toBe(t.receipt)
  })
})

describe('dormancy — runs last: a zero-month period sweeps broadly', () => {
  it('detects, evidences contact, and remits through the ceremony with the register surviving', async () => {
    const m = await newMatter('Dormant host mrec')
    const r = await recordMoneyReceipt(P, {
      matter: m,
      account: fx.account,
      amount: 130,
      method: 'electronic_transfer',
      payerDescription: 'untraceable client',
    })
    const detected = await runDormancyDetection(P)
    const mine = detected.opened.find((x) => x.ledger === r.ledger)
    expect(mine).toBeDefined()

    // the remittance refuses until the pack's minimum attempts are met
    const d = await draftMoneyPayment(P, {
      matterLedger: r.ledger,
      amount: 130,
      method: 'electronic_transfer',
      reason: 'remittance of unclaimed money',
      payeeDescription: 'The public trustee',
      purpose: 'remittance',
      dormantCase: mine!.case,
    })
    await submitMoneyPayment(P, { payment: d.id })
    await authoriseMoneyPayment(S, { payment: d.id })
    await expect(
      executeRemittance(P, {
        payment: d.id,
        authority: 'Public Trustee',
        documentation: 'remittance schedule 2026-08-14',
      }),
    ).rejects.toMatchObject({ code: 'attempts_missing' })

    await recordContactAttempt(P, {
      case: mine!.case,
      channel: 'letter',
      evidence: 'letter to last known address, returned unclaimed',
    })
    const done = await executeRemittance(P, {
      payment: d.id,
      authority: 'Public Trustee',
      documentation: 'remittance schedule 2026-08-14',
    })
    expect(done.paymentNumber).toMatch(/^P-/)
    const balance = await admin.query(`select deedbox.ledger_balance($1) as b`, [r.ledger])
    expect(cents(balance.rows[0].b)).toBe(0)
    const k18b = await admin.query(
      `select authority, amount from deedbox.remittance_register where id = $1`,
      [done.register],
    )
    expect(k18b.rows[0].authority).toBe('Public Trustee')
    expect(cents(k18b.rows[0].amount)).toBe(13000)
    const dc = await admin.query(`select state from deedbox.dormant_case where id = $1`, [
      mine!.case,
    ])
    expect(dc.rows[0].state).toBe('remitted')
  })

  it('a live case resolves without remitting when the client is found', async () => {
    const m = await newMatter('Found client mrec')
    const r = await recordMoneyReceipt(P, {
      matter: m,
      account: fx.account,
      amount: 40,
      method: 'electronic_transfer',
      payerDescription: 'client deposit',
    })
    const detected = await runDormancyDetection(P)
    const mine = detected.opened.find((x) => x.ledger === r.ledger)
    expect(mine).toBeDefined()
    await resolveDormantCase(P, { case: mine!.case, reason: 'client responded to the second letter' })
    const dc = await admin.query(`select state, resolved_reason from deedbox.dormant_case where id = $1`, [
      mine!.case,
    ])
    expect(dc.rows[0].state).toBe('resolved')
  })
})
