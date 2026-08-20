// The GL module (schema change 0037): dark until configured (capability
// first, then the typed not-enabled refusal; the bridge returns zero counts
// unconfigured); the enable ceremony seeds the purpose-tagged starter chart
// exactly once; manual journals post balanced-or-not-at-all with gapless
// numbers and reverse by mirror; a locked month refuses posting; supplier
// bills approve into a posted AP journal and pay in full or not at all; CSV
// imports dedupe on the source hash; every reconcile verb posts its
// journal, flips its line and writes its match evidence (tax split
// cents-exact); rules auto-post only when told; the practice bridge posts
// each bill-journal entry EXACTLY once with the receivable side always
// facing the entry's signed amount; opening balances plug to equity; the
// trial balance nets to zero; capability gating throughout.
//
// Cross-suite contract: flips only gl.* settings (no other suite reads
// them). Consumes the gl_journal number series (sole consumer — assertions
// are prefix/uniqueness, never absolute). Fixture tag 'glm' (first-three
// unique). The bridge sweep posts OTHER fixtures' practice entries too on
// the shared scratch — every bridge assertion is scoped to THIS fixture's
// entry ids (baseline-relative).

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import type { Pool } from 'pg'
import { closePool } from '@/lib/db'
import type { Principal } from '@/lib/db'
import {
  enableGl,
  lockGlMonth,
  createGlAccount,
  createGlTaxCode,
  createGlContact,
  createManualJournal,
  reverseGlJournal,
  postOpeningBalances,
  createGlBill,
  approveGlBill,
  voidGlBill,
  createGlBankAccount,
  importStatementRows,
  parseStatementCsv,
  createGlBankRule,
  reconcileReceive,
  reconcileSpend,
  reconcileMatchBill,
  reconcileIgnore,
  autoReconcile,
  runGlSync,
} from '@/lib/ops/gl'
import {
  glStatus,
  glChart,
  glJournalView,
  glTrialBalance,
  glBalanceSheet,
  glWorkbench,
} from '@/lib/reads/gl'
import { createTimeEntry, createDraftBillGroup, issueBillGroup, recordPayment, addStaffRate } from '@/lib/ops/billing'
import { makeAdminPool, buildFixture, type Fixture } from './helpers'

let admin: Pool
let fx: Fixture
let P: Principal
let P2: Principal // lawyer-role staff: no gl.manage
const today = new Date().toISOString().slice(0, 10)

async function accountByPurpose(purpose: string): Promise<number> {
  const r = await admin.query(
    `select id from deedbox.gl_account where firm = $1 and system_purpose = $2`,
    [fx.firm, purpose],
  )
  return r.rows[0].id as number
}

beforeAll(async () => {
  admin = makeAdminPool()
  fx = await buildFixture(admin, 'glm')
  P = { kind: 'staff', id: fx.staff, firm: fx.firm }
  const lawyerRole = await admin.query(`select id from deedbox.role where system_key = 'lawyer'`)
  const s2 = await admin.query(
    `insert into deedbox.staff_member (person_name, login, role, office, email)
     values ('{"given":"No","family":"Books"}','nobooks.glm', $1, $2, 'nobooks.glm@example.test')
     returning id`,
    [lawyerRole.rows[0].id, fx.office],
  )
  P2 = { kind: 'staff', id: s2.rows[0].id as number, firm: fx.firm }
  await addStaffRate(P, { staff: fx.staff, rate: 400, effectiveFrom: '2020-01-01' })
})

afterAll(async () => {
  await closePool()
  await admin.end()
})

describe('the GL module', () => {
  it('is dark until configured — capability first, then the typed refusal; the bridge stays quiet', async () => {
    await expect(
      createGlAccount(P2, { code: '9990', name: 'Nope', accountType: 'expense' }),
    ).rejects.toMatchObject({ code: 'capability_missing' })
    await expect(
      createGlAccount(P, { code: '9990', name: 'Probe', accountType: 'expense' }),
    ).rejects.toMatchObject({ code: 'gl_not_enabled' })
    const status = await glStatus(P)
    expect(status.enabled).toBe(false)
    const sync = await runGlSync(P)
    expect(sync).toMatchObject({ configured: false, posted: 0 })
  })

  it('the enable ceremony seeds the purpose-tagged starter chart exactly once', async () => {
    const first = await enableGl(P, { conversionDate: today })
    expect(first.seededAccounts).toBe(19)
    const again = await enableGl(P, { conversionDate: today })
    expect(again.seededAccounts).toBe(0)
    const status = await glStatus(P)
    expect(status.enabled).toBe(true)
    expect(status.conversionDate).toBe(today)
    const { accounts } = await glChart(P)
    const purposes = (accounts as Record<string, unknown>[])
      .map((a) => a.system_purpose)
      .filter(Boolean)
    for (const need of ['operating_bank', 'accounts_receivable', 'accounts_payable', 'tax_collected', 'tax_paid', 'revenue_default', 'bad_debts', 'opening_balance_equity']) {
      expect(purposes).toContain(need)
    }
  })

  it('manual journals: balanced or refused; gapless numbers; reversal mirrors and freezes', async () => {
    await expect(
      createManualJournal(P, {
        journalDate: today,
        description: 'Unbalanced',
        lines: [
          { account: await accountByPurpose('operating_bank'), debitCents: 10000 },
          { account: await accountByPurpose('revenue_default'), creditCents: 9000 },
        ],
      }),
    ).rejects.toMatchObject({ code: 'unbalanced' })

    const bank = await accountByPurpose('operating_bank')
    const revenue = await accountByPurpose('revenue_default')
    const j = await createManualJournal(P, {
      journalDate: today,
      description: 'GLM manual one',
      lines: [
        { account: bank, debitCents: 12345 },
        { account: revenue, creditCents: 12345 },
      ],
    })
    expect(j.journalNo.startsWith('GJ-')).toBe(true)

    const r = await reverseGlJournal(P, { id: j.id })
    expect(r.reversalNo.startsWith('GJ-')).toBe(true)
    expect(r.reversalNo).not.toBe(j.journalNo)
    const view = await glJournalView(P, j.id)
    expect((view!.journal as Record<string, unknown>).status).toBe('reversed')
    const mirror = await glJournalView(P, r.reversalId)
    const mirrorLines = mirror!.lines as Record<string, unknown>[]
    expect(Number(mirrorLines.find((l) => l.account === bank)!.credit)).toBe(123.45)
    // a reversed journal never moves again
    await expect(reverseGlJournal(P, { id: j.id })).rejects.toMatchObject({ code: 'not_posted' })
  })

  it('a locked month refuses posting into it, forever', async () => {
    await lockGlMonth(P, { monthStart: '2031-05-01' })
    await expect(
      createManualJournal(P, {
        journalDate: '2031-05-10',
        description: 'Into the locked month',
        lines: [
          { account: await accountByPurpose('operating_bank'), debitCents: 100 },
          { account: await accountByPurpose('revenue_default'), creditCents: 100 },
        ],
      }),
    ).rejects.toThrow(/locked/)
    await expect(lockGlMonth(P, { monthStart: '2031-05-01' })).rejects.toMatchObject({
      code: 'already_locked',
    })
  })

  it('supplier bills: approval posts the payable journal; paid means in full; drafts void', async () => {
    const contact = await createGlContact(P, { name: 'GLM Stationery Co' })
    const expense = await createGlAccount(P, { code: '6950', name: 'GLM stationery', accountType: 'expense' })
    const bill = await createGlBill(P, {
      contact,
      billNumber: 'INV-GLM-1',
      billDate: today,
      lines: [{ account: expense, netCents: 10000, taxCents: 1000 }],
    })
    await approveGlBill(P, { id: bill })
    const row = await admin.query(`select * from deedbox.gl_bill where id = $1`, [bill])
    expect(row.rows[0].status).toBe('approved')
    const jv = await glJournalView(P, row.rows[0].journal as number)
    const lines = jv!.lines as Record<string, unknown>[]
    const ap = await accountByPurpose('accounts_payable')
    const taxPaid = await accountByPurpose('tax_paid')
    expect(Number(lines.find((l) => l.account === ap)!.credit)).toBe(110)
    expect(Number(lines.find((l) => l.account === taxPaid)!.debit)).toBe(10)
    expect(Number(lines.find((l) => l.account === expense)!.debit)).toBe(100)
    await expect(voidGlBill(P, { id: bill })).rejects.toMatchObject({ code: 'not_voidable' })

    const draft = await createGlBill(P, {
      contact,
      billDate: today,
      lines: [{ account: expense, netCents: 500, taxCents: 0 }],
    })
    await voidGlBill(P, { id: draft })
    const voided = await admin.query(`select status from deedbox.gl_bill where id = $1`, [draft])
    expect(voided.rows[0].status).toBe('void')
  })

  it('CSV import parses, dedupes on the source hash, and re-imports insert nothing', async () => {
    const ba = await createGlBankAccount(P, { name: 'GLM Operating', code: '1001' })
    const csv = [
      'Date,Amount,Description',
      `${today},330.00,GLM CLIENT DEPOSIT`,
      `${today},-110.00,GLM STATIONERY DD`,
      `${today},-45.50,GLM POSTAGE`,
    ].join('\n')
    const rows = parseStatementCsv(csv, { date: 0, amount: 1, description: 2 })
    expect(rows.length).toBe(3)
    const first = await importStatementRows(P, { bankAccount: ba, filename: 'glm.csv', rows })
    expect(first.inserted).toBe(3)
    expect(first.duplicates).toBe(0)
    const second = await importStatementRows(P, { bankAccount: ba, filename: 'glm.csv', rows })
    expect(second.inserted).toBe(0)
    expect(second.duplicates).toBe(3)
  })

  it('the reconcile verbs post their journals, flip their lines, write their evidence — tax to the cent', async () => {
    const tax = await createGlTaxCode(P, { code: 'GLMTAX', name: 'Ten percent', ratePercent: 10 })
    const ba = (
      await admin.query(
        `select id, account from deedbox.gl_bank_account where firm = $1 and name = 'GLM Operating'`,
        [fx.firm],
      )
    ).rows[0] as { id: number; account: number }
    const lineIds = await admin.query(
      `select id, amount from deedbox.gl_statement_line
        where firm = $1 and bank_account = $2 order by id`,
      [fx.firm, ba.id],
    )
    const inLine = (lineIds.rows as { id: number; amount: string }[]).find((l) => Number(l.amount) === 330)!
    const billLine = (lineIds.rows as { id: number; amount: string }[]).find((l) => Number(l.amount) === -110)!
    const spendLine = (lineIds.rows as { id: number; amount: string }[]).find((l) => Number(l.amount) === -45.5)!

    const income = await createGlAccount(P, { code: '4950', name: 'GLM sundry income', accountType: 'income' })
    const recv = await reconcileReceive(P, { lineId: inLine.id, account: income, taxCode: tax })
    expect(recv.journalNo.startsWith('GJ-')).toBe(true)
    const posted = await admin.query(
      `select l.account, l.debit, l.credit from deedbox.gl_journal_line l
         join deedbox.gl_journal j on j.id = l.journal
        where j.firm = $1 and j.source_ref = $2`,
      [fx.firm, `stmt:${inLine.id}`],
    )
    const taxCollected = await accountByPurpose('tax_collected')
    const pl = posted.rows as { account: number; debit: string; credit: string }[]
    expect(Number(pl.find((l) => l.account === ba.account)!.debit)).toBe(330)
    expect(Number(pl.find((l) => l.account === income)!.credit)).toBe(300)
    expect(Number(pl.find((l) => l.account === taxCollected)!.credit)).toBe(30)

    // settle-once: the same line refuses a second verb
    await expect(
      reconcileReceive(P, { lineId: inLine.id, account: income }),
    ).rejects.toMatchObject({ code: 'line_settled' })

    // pay the approved bill in full from the -110 line
    const bill = (
      await admin.query(
        `select id from deedbox.gl_bill where firm = $1 and bill_number = 'INV-GLM-1'`,
        [fx.firm],
      )
    ).rows[0].id as number
    await reconcileMatchBill(P, { lineId: billLine.id, billId: bill })
    const paid = await admin.query(`select status, amount_paid from deedbox.gl_bill where id = $1`, [bill])
    expect(paid.rows[0].status).toBe('paid')
    expect(Number(paid.rows[0].amount_paid)).toBe(110)

    // plain spend, no tax
    const expense = (
      await admin.query(`select id from deedbox.gl_account where firm = $1 and code = '6900'`, [fx.firm])
    ).rows[0].id as number
    await reconcileSpend(P, { lineId: spendLine.id, account: expense })

    // evidence rows exist for all three
    const matches = await admin.query(
      `select match_type from deedbox.gl_match where firm = $1 order by id`,
      [fx.firm],
    )
    expect(matches.rows.map((r: { match_type: string }) => r.match_type)).toEqual(
      expect.arrayContaining(['receive', 'bill', 'spend']),
    )
  })

  it('rules suggest on the workbench and auto-post only when told', async () => {
    const ba = (
      await admin.query(
        `select id from deedbox.gl_bank_account where firm = $1 and name = 'GLM Operating'`,
        [fx.firm],
      )
    ).rows[0].id as number
    const income = (
      await admin.query(`select id from deedbox.gl_account where firm = $1 and code = '4950'`, [fx.firm])
    ).rows[0].id as number
    await createGlBankRule(P, {
      name: 'GLM payout rule',
      matchDescOp: 'contains',
      matchDesc: 'GLM PAYOUT',
      direction: 'in',
      action: 'receive_money',
      account: income,
      autoPost: true,
    })
    await importStatementRows(P, {
      bankAccount: ba,
      rows: [
        { date: today, amountCents: 7500, description: 'GLM PAYOUT WEEKLY' },
        { date: today, amountCents: 6100, description: 'GLM MYSTERY CREDIT' },
      ],
    })
    const bench = await glWorkbench(P, ba)
    const payoutLine = bench.lines.find((l) => l.description === 'GLM PAYOUT WEEKLY')!
    expect(payoutLine.ruleSuggestion?.rule).toBe('GLM payout rule')
    const auto = await autoReconcile(P, { bankAccount: ba })
    expect(auto.posted).toBe(1)
    expect(auto.leftForReview).toBe(1)
    const after = await admin.query(
      `select status, matched_journal from deedbox.gl_statement_line where id = $1`,
      [payoutLine.id],
    )
    expect(after.rows[0].status).toBe('matched')
    expect(after.rows[0].matched_journal).not.toBeNull()
    // the mystery credit is untouched, then deliberately set aside
    const mystery = bench.lines.find((l) => l.description === 'GLM MYSTERY CREDIT')!
    await reconcileIgnore(P, { lineId: mystery.id })
  })

  // the first sweep bridges EVERY practice entry the earlier suites left on
  // the shared scratch (unbounded by design) — give it room; the later runs
  // are cheap
  it('the practice bridge posts each bill-journal entry exactly once, receivables always facing the entry', { timeout: 300_000 }, async () => {
    const te = await createTimeEntry(P, {
      matter: fx.matter,
      workDate: today,
      units: 10, // 400.00 at the fixture rate
      narrative: 'glm bridge work',
    })
    const g = await createDraftBillGroup(P, { matter: fx.matter, timeEntries: [te.id] })
    await issueBillGroup(P, { group: g.group })
    const practiceBill = (
      await admin.query(`select id from deedbox.bill where bill_group = $1`, [g.group])
    ).rows[0].id as number

    const sync1 = await runGlSync(P)
    expect(sync1.configured).toBe(true)
    const myEntries = await admin.query(
      `select id, entry_kind, signed_amount from deedbox.bill_journal_entry where bill = $1 order by id`,
      [practiceBill],
    )
    expect(myEntries.rowCount).toBeGreaterThanOrEqual(1)
    const ar = await accountByPurpose('accounts_receivable')
    for (const e of myEntries.rows as { id: number; signed_amount: string }[]) {
      const jr = await admin.query(
        `select l.debit, l.credit from deedbox.gl_journal j
           join deedbox.gl_journal_line l on l.journal = j.id and l.account = $3
          where j.firm = $1 and j.source_ref = $2 and j.status = 'posted'`,
        [fx.firm, `bje:${e.id}`, ar],
      )
      expect(jr.rowCount).toBe(1)
      const signed = Number(e.signed_amount)
      const arMove = Number(jr.rows[0].debit) - Number(jr.rows[0].credit)
      expect(arMove).toBeCloseTo(signed, 2)
    }

    // a payment lands a new negative entry; only THAT posts on the next run
    await recordPayment(P, {
      receivedDate: today,
      amount: 100,
      method: 'bank_transfer',
      allocations: [{ bill: practiceBill, amount: 100 }],
    })
    await runGlSync(P)
    const afterPayment = await admin.query(
      `select count(*)::int as n from deedbox.gl_journal j
        where j.firm = $1 and j.source_ref in (
          select 'bje:' || id from deedbox.bill_journal_entry where bill = $2)`,
      [fx.firm, practiceBill],
    )
    const entryCount = (
      await admin.query(`select count(*)::int as n from deedbox.bill_journal_entry where bill = $1`, [practiceBill])
    ).rows[0].n as number
    expect(afterPayment.rows[0].n).toBe(entryCount)

    // idempotent: a third run adds nothing for this bill
    await runGlSync(P)
    const again = await admin.query(
      `select count(*)::int as n from deedbox.gl_journal j
        where j.firm = $1 and j.source_ref in (
          select 'bje:' || id from deedbox.bill_journal_entry where bill = $2)`,
      [fx.firm, practiceBill],
    )
    expect(again.rows[0].n).toBe(entryCount)
  })

  it('opening balances plug to equity; the trial balance nets to zero; the balance sheet closes', async () => {
    const bank = await accountByPurpose('operating_bank')
    const ob = await postOpeningBalances(P, {
      asOf: today,
      lines: [{ account: bank, debitCents: 500000 }],
    })
    expect(ob.journalNo.startsWith('GJ-')).toBe(true)
    await expect(
      postOpeningBalances(P, { asOf: today, lines: [{ account: bank, debitCents: 1 }] }),
    ).rejects.toMatchObject({ code: 'opening_exists' })

    const tb = (await glTrialBalance(P, '2099-12-31')) as Record<string, unknown>[]
    const net = tb.reduce((s, r) => s + Number(r.balance), 0)
    expect(Math.abs(net)).toBeLessThan(0.005)

    const bs = await glBalanceSheet(P, '2099-12-31')
    const signed = (bs.rows as Record<string, unknown>[]).reduce((s, r) => s + Number(r.signed), 0)
    // assets − liabilities − equity = current earnings
    expect(signed).toBeCloseTo(Number(bs.currentEarnings), 2)
  })

  it('gates every door on gl.manage', async () => {
    const status = await glStatus(P2)
    expect(status.mayManage).toBe(false)
    await expect(createGlContact(P2, { name: 'Nope' })).rejects.toMatchObject({
      code: 'capability_missing',
    })
    await expect(glChart(P2)).rejects.toMatchObject({ code: 'capability_missing' })
    await expect(runGlSync(P2)).rejects.toMatchObject({ code: 'capability_missing' })
  })
})
