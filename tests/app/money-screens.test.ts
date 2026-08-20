// Client-money screens: the predicate-governed reads behind the client-money surfaces,
// proven against real money flows. The operations are the earlier money suites' — these
// tests prove the READS present the books honestly.
//
// Cross-suite contracts (localeCompare order: after money-recon, before plumbing): all
// fixture rows are tag-named (xmsc) on the fixture's OWN client account; no
// database-global setting is flipped; the period this suite locks ends 20 days in the
// past, so nothing any other suite posts today can collide with it.

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import type { Pool } from 'pg'
import { closePool, MoneyRefusal } from '@/lib/db'
import type { Principal } from '@/lib/db'
import {
  recordMoneyReceipt,
  draftMoneyPayment,
  submitMoneyPayment,
  authoriseMoneyPayment,
  executeMoneyPayment,
  placeEarmark,
  releaseEarmark,
  ingestBankStatementLines,
  buildReconciliation,
  createMatchGroup,
  certifyReconciliation,
  openPeriodClose,
  certifyPeriodClose,
  bankInstrument,
  generateClientMoneyStatement,
  issueClientMoneyStatement,
  promoteRefusalToIncident,
} from '@/lib/ops/money'
import {
  accountsOverview,
  matterMoneyTab,
  ledgerScreen,
  receiptFormData,
  paymentWorkspace,
  reconWorkspace,
  closeBoard,
  closePreview,
  instrumentRegister,
  refusalRegister,
  incidentRegister,
  dormantQueue,
  statutoryRegistersScreen,
  moneyStatementsScreen,
  moneyViewerFlags,
} from '@/lib/reads/money'
import { makeAdminPool, buildFixture, addStaff, type Fixture } from './helpers'

let admin: Pool
let fx: Fixture
let P: Principal
let sam: number
let S: Principal
let blockedPayment: number
let refusalId: number

const dateStr = (daysAgo: number) =>
  new Date(Date.now() - daysAgo * 86400000).toISOString().slice(0, 10)

beforeAll(async () => {
  admin = makeAdminPool()
  fx = await buildFixture(admin, 'xmsc')
  P = { kind: 'staff', id: fx.staff, firm: fx.firm }
  sam = await addStaff(admin, fx, 'sam.xmsc')
  S = { kind: 'staff', id: sam, firm: fx.firm }
})

afterAll(async () => {
  await closePool()
  await admin.end()
})

describe('receipts, the ledger and the matter tab', () => {
  it('a receipt lands on the tab, the ledger screen and the overview', async () => {
    const form = await receiptFormData(P)
    expect(form.accounts.some((a) => a.id === fx.account)).toBe(true)
    expect(form.methods.length).toBeGreaterThanOrEqual(3)

    await recordMoneyReceipt(P, {
      matter: fx.matter,
      account: fx.account,
      amount: 500,
      method: 'electronic_transfer',
      receivedDate: dateStr(30),
      payerDescription: 'xmsc client deposit',
    })
    const tab = await matterMoneyTab(P, fx.matter)
    expect(tab.ledgers.length).toBe(1)
    expect(tab.ledgers[0].balance).toBe(500)
    expect(tab.ledgers[0].available).toBe(500)
    expect(tab.recentLines.length).toBe(1)

    const screen = await ledgerScreen(P, tab.ledgers[0].id)
    expect(screen.lines.length).toBe(1)
    expect(Number(screen.lines[0].running_balance)).toBe(500)

    const overview = await accountsOverview(P)
    const acct = overview.find((a) => a.id === fx.account)!
    expect(Number(acct.book_total)).toBe(500)
    expect(acct.ledgers).toBe(1)
  })

  it('earmarks change available, never balance', async () => {
    const tab = await matterMoneyTab(P, fx.matter)
    const ledger = tab.ledgers[0].id
    const placed = await placeEarmark(P, { matterLedger: ledger, amount: 200, purpose: 'xmsc counsel fees' })
    const after = await matterMoneyTab(P, fx.matter)
    expect(after.ledgers[0].balance).toBe(500)
    expect(after.ledgers[0].earmarked).toBe(200)
    expect(after.ledgers[0].available).toBe(300)
    expect(after.earmarks.some((e) => e.id === placed.id && e.state === 'active')).toBe(true)
    await releaseEarmark(P, { earmark: placed.id, reason: 'xmsc fees paid another way' })
    const released = await matterMoneyTab(P, fx.matter)
    expect(released.ledgers[0].available).toBe(500)
  })
})

describe('reconciliation and the close', () => {
  it('the workspace shows the live equation and certifies at zero remainder', async () => {
    await ingestBankStatementLines(P, {
      account: fx.account,
      source: 'manual',
      lines: [{ lineDate: dateStr(29), amount: 500, description: 'xmsc deposit' }],
    })
    // the statement date must reach the later close's period end — the close
    // guard demands a certified reconciliation AT the period end
    await buildReconciliation(P, {
      account: fx.account,
      statementDate: dateStr(20),
      statementBalance: 500,
    })
    let w = await reconWorkspace(P, fx.account)
    expect(w.recon).not.toBeNull()
    expect(w.unmatchedLines.length).toBe(1)
    expect(w.unmatchedTxns.length).toBe(1)
    expect(w.equation!.remainder).toBe(0) // 500 statement = 500 book, no exceptions

    await createMatchGroup(P, {
      reconciliation: w.recon!.id as number,
      statementLines: [w.unmatchedLines[0].id as number],
      transactions: [w.unmatchedTxns[0].id as number],
    })
    await certifyReconciliation(P, { reconciliation: w.recon!.id as number })
    w = await reconWorkspace(P, fx.account)
    expect(w.recon).toBeNull() // nothing in progress
    expect(w.history.length).toBe(1)
    expect(w.unmatchedLines.length).toBe(0)

    const overview = await accountsOverview(P)
    expect(overview.find((a) => a.id === fx.account)!.last_certified).not.toBeNull()
  })

  it('the close board opens an on-demand close; the preview and the certified listing agree', async () => {
    const opened = await openPeriodClose(P, {
      account: fx.account,
      periodStart: dateStr(40),
      periodEnd: dateStr(20),
    })
    let board = await closeBoard(P)
    expect(board.closes.some((c) => c.id === opened.id && c.status === 'in_progress')).toBe(true)

    let preview = await closePreview(P, opened.id)
    expect(preview.liveTotal).toBe(500)

    await certifyPeriodClose(P, { close: opened.id })
    preview = await closePreview(P, opened.id)
    expect(preview.close.status).toBe('certified')
    expect(preview.close.late).toBe(false)
    expect(preview.certifiedListing.length).toBeGreaterThan(0)
    expect(
      preview.certifiedListing.reduce((n, l) => n + Number(l.balance), 0),
    ).toBe(500)
  })
})

describe('the payment ceremony on the workspace', () => {
  it('draft → pending (approvals counted) → authorised → executed, all readable', async () => {
    const tab = await matterMoneyTab(P, fx.matter)
    const ledger = tab.ledgers[0].id

    const draft = await draftMoneyPayment(P, {
      matterLedger: ledger,
      amount: 100,
      method: 'electronic_transfer',
      reason: 'xmsc refund to client',
      payeeDescription: 'the client',
    })
    let w = await paymentWorkspace(P)
    expect(w.drafts.some((r) => r.id === draft.id)).toBe(true)

    await submitMoneyPayment(P, { payment: draft.id })
    w = await paymentWorkspace(P)
    const pending = w.pending.find((r) => r.id === draft.id)!
    expect(pending).toBeDefined()
    expect(Number(pending.approvals)).toBe(0)

    await authoriseMoneyPayment(S, { payment: draft.id })
    w = await paymentWorkspace(P)
    expect(w.authorised.some((r) => r.id === draft.id)).toBe(true)

    await executeMoneyPayment(P, { payment: draft.id })
    w = await paymentWorkspace(P)
    expect(w.recentExecuted.some((r) => r.id === draft.id)).toBe(true)
    const after = await matterMoneyTab(P, fx.matter)
    expect(after.ledgers[0].balance).toBe(400)
  })

  it('a guard refusal blocks the payment, and the refusal register carries the typed reason', async () => {
    const tab = await matterMoneyTab(P, fx.matter)
    const ledger = tab.ledgers[0].id
    // the draft-time stop refuses an overdraw at entry, so the wall is
    // staged honestly: draft the full balance, drain half, then execute
    const big = await draftMoneyPayment(P, {
      matterLedger: ledger,
      amount: 400,
      method: 'electronic_transfer',
      reason: 'xmsc would overdraw',
      payeeDescription: 'nobody',
    })
    blockedPayment = big.id
    await submitMoneyPayment(P, { payment: big.id })
    await authoriseMoneyPayment(S, { payment: big.id })
    const drain = await draftMoneyPayment(P, {
      matterLedger: ledger,
      amount: 200,
      method: 'electronic_transfer',
      reason: 'xmsc drain before the walled execution',
      payeeDescription: 'drain payee',
    })
    await submitMoneyPayment(P, { payment: drain.id })
    await authoriseMoneyPayment(S, { payment: drain.id })
    await executeMoneyPayment(P, { payment: drain.id })
    await expect(executeMoneyPayment(P, { payment: big.id })).rejects.toThrow(MoneyRefusal)

    const w = await paymentWorkspace(P)
    expect(w.blocked.some((r) => r.id === blockedPayment)).toBe(true)

    const refusals = await refusalRegister(P)
    const row = refusals.find(
      (r) => r.refusal_reason === 'would_go_below_zero' && String(r.ledger_number) !== '',
    )
    expect(row).toBeDefined()
    refusalId = row!.id as number
    // balance untouched by the refused attempt (200 after the drain)
    const mid = await matterMoneyTab(P, fx.matter)
    expect(mid.ledgers[0].balance).toBe(200)
    // restore the suite's running balance for everything downstream
    await recordMoneyReceipt(P, {
      matter: fx.matter,
      account: fx.account,
      amount: 200,
      method: 'electronic_transfer',
      payerDescription: 'xmsc restore staging funds',
    })
    const after = await matterMoneyTab(P, fx.matter)
    expect(after.ledgers[0].balance).toBe(400)
  })
})

describe('instruments, incidents, statements, registers', () => {
  it('an instrument-backed receipt reaches the register and banks', async () => {
    const r = await recordMoneyReceipt(P, {
      matter: fx.matter,
      account: fx.account,
      amount: 50,
      method: 'cheque',
      payerDescription: 'xmsc cheque payer',
      instrumentNumber: 'XMSC-0001',
    })
    expect(r.receiptNumber).toBeTruthy()
    let reg = await instrumentRegister(P, { direction: 'inbound' })
    const inst = reg.find((i) => i.number === 'XMSC-0001')!
    expect(inst).toBeDefined()
    expect(inst.state).toBe('received')
    await bankInstrument(P, { instrument: inst.id as number })
    reg = await instrumentRegister(P, { direction: 'inbound', state: 'banked' })
    expect(reg.some((i) => i.number === 'XMSC-0001')).toBe(true)
    // it appears on the matter tab as outstanding until cleared
    const tab = await matterMoneyTab(P, fx.matter)
    expect(tab.instruments.some((i) => i.number === 'XMSC-0001')).toBe(true)
  })

  it('a promoted refusal appears on the incident register', async () => {
    await promoteRefusalToIncident(P, { refusal: refusalId, narrative: 'xmsc reviewed and recorded' })
    const incidents = await incidentRegister(P)
    expect(incidents.some((i) => i.origin === 'promoted_refusal' && i.state === 'open')).toBe(true)
    const refusals = await refusalRegister(P)
    expect(refusals.find((r) => r.id === refusalId)!.promoted_incident).not.toBeNull()
  })

  it('client statements generate and issue exactly once; empty registers read honestly', async () => {
    const tab = await matterMoneyTab(P, fx.matter)
    const st = await generateClientMoneyStatement(P, {
      matterLedger: tab.ledgers[0].id,
      periodStart: dateStr(40),
      periodEnd: dateStr(0),
      triggerKind: 'on_request',
    })
    let list = await moneyStatementsScreen(P)
    expect(list.some((s) => s.statement_number === st.statementNumber && s.issued_at === null)).toBe(true)
    await issueClientMoneyStatement(P, { statement: st.id, channel: 'email', recipient: 'client@example.test' })
    list = await moneyStatementsScreen(P)
    expect(list.find((s) => s.statement_number === st.statementNumber)!.issued_at).not.toBeNull()

    const registers = await statutoryRegistersScreen(P)
    expect(registers.registers.length).toBe(0) // the neutral fixture pack declares none

    const dormant = await dormantQueue(P)
    expect(Array.isArray(dormant.cases)).toBe(true) // detection is pack-gated, inert here

    const flags = await moneyViewerFlags(P)
    expect(flags.receive).toBe(true)
    expect(flags.authorise).toBe(true)
  })
})
