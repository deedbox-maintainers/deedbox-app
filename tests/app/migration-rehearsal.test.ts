// The migration rehearsal: a firm's cutover route proven end to end on a
// scratch database, in the order a real cutover runs it — clients and
// matters first, then client money, then the first reconciliation.
//
// Two ledger shapes exist in any real practice, and they take different
// routes:
//
//   * a CLEAN ledger, which never went below zero, replays in full — every
//     historical receipt and payment posts natively, and the closing balance
//     must reproduce the source system's to the cent;
//   * a ledger that DID go below zero cannot be replayed at all. The engine
//     refuses the negative posting, and that refusal is the product, not an
//     obstacle to work around. Such a ledger arrives as an opening balance
//     at the boundary date, with its old history kept verbatim as a labelled
//     archive artefact reachable from the matter's own register.
//
// The boundary artefact is the arithmetic guard on that second route: a
// posted opening balance that disagrees with the source system's closing
// balance refuses the whole batch rather than landing a wrong figure.
//
// The first reconciliation certifying green from the imported position is
// the cutover's acceptance test — it is what proves the firm may start
// working on the new engine.
//
// Cross-suite contract: flips NO settings, owns its own client account and
// matters (fixture tag 'mgr'), and never reads another fixture's rows.

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import type { Pool } from 'pg'
import { closePool } from '@/lib/db'
import type { Principal } from '@/lib/db'
import { runImportBatch, startMigration } from '@/lib/ops/imports'
import {
  ingestBankStatementLines,
  buildReconciliation,
  createMatchGroup,
  certifyReconciliation,
} from '@/lib/ops/money'
import { makeAdminPool, buildFixture, type Fixture } from './helpers'

let admin: Pool
let fx: Fixture
let P: Principal
let staffLogin = ''
let officeCode = ''
let practiceArea = ''
let migration = 0

const SRC = 'mgr-old-system'
const cents = (v: unknown) => Math.round(Number(v) * 100)

beforeAll(async () => {
  admin = makeAdminPool()
  fx = await buildFixture(admin, 'mgr')
  P = { kind: 'staff', id: fx.staff, firm: fx.firm }
  const s = await admin.query(
    `select s.login, o.code, pa.name as pa
       from deedbox.staff_member s
       join deedbox.office o on o.id = $2
       join deedbox.practice_area pa on pa.id = $3
      where s.id = $1`,
    [fx.staff, fx.office, fx.practiceArea],
  )
  staffLogin = s.rows[0].login as string
  officeCode = s.rows[0].code as string
  practiceArea = s.rows[0].pa as string
  migration = (await startMigration(P, { sourceSystem: SRC })).id
})

afterAll(async () => {
  await closePool()
  await admin.end()
})

/** The ledger balance the engine itself computes, in cents. */
async function ledgerCents(matterSourceRef: string): Promise<number> {
  const r = await admin.query(
    `select deedbox.ledger_balance(l.id) as b
       from deedbox.matter_ledger l
       join deedbox.source_reference sr
         on sr.target = l.matter and sr.target_type = 'matter'
      where sr.source_system = $1 and sr.source_ref = $2 and l.account = $3`,
    [SRC, matterSourceRef, fx.account],
  )
  return cents(r.rows[0].b)
}

describe('the cutover imports its clients and matters first', () => {
  it('validate-only reports what would land and persists nothing, then the real run lands it', async () => {
    const clients = {
      recordDomain: 'clients' as const,
      sourceSystem: SRC,
      migration,
      records: [
        { source_ref: 'mgr-c1', data: { kind: 'person' as const, full_name: 'Rosalind Carrow mgr' } },
        { source_ref: 'mgr-c2', data: { kind: 'person' as const, full_name: 'Ambrose Quill mgr' } },
      ],
    }
    const dry = await runImportBatch(P, clients, { mode: 'validate_only' })
    expect(dry.state, JSON.stringify(dry.outcomes)).toBe('completed')
    const after = await admin.query(
      `select count(*)::int as n from deedbox.source_reference
        where source_system = $1 and source_ref in ('mgr-c1','mgr-c2')`,
      [SRC],
    )
    expect(after.rows[0].n).toBe(0)

    const real = await runImportBatch(P, clients, { mode: 'real' })
    expect(real.state, JSON.stringify(real.outcomes)).toBe('completed')
    expect(real.outcomes.map((o) => o.disposition)).toEqual(dry.outcomes.map((o) => o.disposition))

    const matters = await runImportBatch(
      P,
      {
        recordDomain: 'matters',
        sourceSystem: SRC,
        migration,
        records: [
          {
            source_ref: 'mgr-m-clean',
            data: {
              title: 'Carrow purchase mgr',
              client_source_ref: 'mgr-c1',
              responsible_lawyer_login: staffLogin,
              office_code: officeCode,
              practice_area_name: practiceArea,
              opened_date: '2023-02-01',
            },
          },
          {
            source_ref: 'mgr-m-overdrawn',
            data: {
              title: 'Quill estate mgr',
              client_source_ref: 'mgr-c2',
              responsible_lawyer_login: staffLogin,
              office_code: officeCode,
              practice_area_name: practiceArea,
              opened_date: '2023-03-01',
            },
          },
        ],
      },
      { mode: 'real' },
    )
    expect(matters.state, JSON.stringify(matters.outcomes)).toBe('completed')
  })
})

describe('a clean ledger replays in full', () => {
  it('reproduces the old closing balance to the cent, with its own gapless receipts', async () => {
    const r = await runImportBatch(
      P,
      {
        recordDomain: 'client_money_full_history',
        sourceSystem: SRC,
        migration,
        fullHistory: {
          account: fx.account,
          movements: [
            {
              source_ref: 'mgr-mv1',
              kind: 'receipt',
              matter_source_ref: 'mgr-m-clean',
              amount: 4000,
              effective_date: '2023-04-03',
              entered_at: '2023-04-03T09:15:00Z',
              payer_description: 'Carrow deposit',
            },
            {
              source_ref: 'mgr-mv2',
              kind: 'payment_out',
              matter_source_ref: 'mgr-m-clean',
              amount: 1250.55,
              effective_date: '2023-05-19',
              entered_at: '2023-05-19T14:02:00Z',
              payee: 'Land registry mgr',
            },
            {
              source_ref: 'mgr-mv3',
              kind: 'receipt',
              matter_source_ref: 'mgr-m-clean',
              amount: 600.55,
              effective_date: '2023-06-01',
              entered_at: '2023-06-01T11:00:00Z',
              payer_description: 'Carrow top-up',
            },
          ],
        },
      },
      { mode: 'real' },
    )
    expect(r.state, JSON.stringify(r.outcomes)).toBe('completed')
    // 4000.00 − 1250.55 + 600.55 = 3350.00, the source system's closing figure
    expect(await ledgerCents('mgr-m-clean')).toBe(335000)

    const receipts = await admin.query(
      `select r.receipt_number from deedbox.money_receipt r
         join deedbox.matter_ledger l on l.id = r.matter_ledger
         join deedbox.source_reference sr
           on sr.target = l.matter and sr.target_type = 'matter'
        where sr.source_ref = 'mgr-m-clean' and l.account = $1
        order by r.id`,
      [fx.account],
    )
    expect(receipts.rowCount).toBe(2)
    expect(receipts.rows.every((x) => /^R-\d+$/.test(x.receipt_number as string))).toBe(true)

    // re-running the same file changes nothing: history is not duplicated
    const again = await runImportBatch(
      P,
      {
        recordDomain: 'client_money_full_history',
        sourceSystem: SRC,
        migration,
        fullHistory: {
          account: fx.account,
          movements: [
            {
              source_ref: 'mgr-mv1',
              kind: 'receipt',
              matter_source_ref: 'mgr-m-clean',
              amount: 4000,
              effective_date: '2023-04-03',
              entered_at: '2023-04-03T09:15:00Z',
            },
          ],
        },
      },
      { mode: 'real' },
    )
    expect(again.outcomes[0].disposition).toBe('accepted_with_warning')
    expect(await ledgerCents('mgr-m-clean')).toBe(335000)
  })
})

describe('a ledger that ever went below zero cannot be replayed', () => {
  it('the engine refuses the negative posting and leaves not one money row behind', async () => {
    const r = await runImportBatch(
      P,
      {
        recordDomain: 'client_money_full_history',
        sourceSystem: SRC,
        migration,
        fullHistory: {
          account: fx.account,
          movements: [
            {
              source_ref: 'mgr-od1',
              kind: 'receipt',
              matter_source_ref: 'mgr-m-overdrawn',
              amount: 500,
              effective_date: '2023-04-10',
              entered_at: '2023-04-10T10:00:00Z',
            },
            {
              // the source system permitted this; this engine does not
              source_ref: 'mgr-od2',
              kind: 'payment_out',
              matter_source_ref: 'mgr-m-overdrawn',
              amount: 900,
              effective_date: '2023-04-20',
              entered_at: '2023-04-20T10:00:00Z',
              payee: 'Overdrawing payee mgr',
            },
          ],
        },
      },
      { mode: 'real' },
    )
    expect(r.state).toBe('refused')
    const rows = await admin.query(
      `select count(*)::int as n from deedbox.source_reference
        where source_system = $1 and source_ref in ('mgr-od1','mgr-od2')`,
      [SRC],
    )
    expect(rows.rows[0].n).toBe(0)
    // the refusal itself is recorded, even though its transaction rolled back
    const refusal = await admin.query(
      `select refusal_reason from deedbox.refused_operation
        where account = $1 order by id desc limit 1`,
      [fx.account],
    )
    expect(refusal.rows[0].refusal_reason).toBe('would_go_below_zero')
  })

  it('it arrives instead as an opening balance carrying its old history as a labelled archive', async () => {
    const legacy = {
      lines: [
        { date: '2023-04-10', kind: 'receipt', amount: 500 },
        { date: '2023-04-20', kind: 'payment', amount: 900 },
        { date: '2023-05-02', kind: 'receipt', amount: 1300 },
      ],
      note: 'ledger went below zero on 2023-04-20 in the source system',
    }
    const r = await runImportBatch(
      P,
      {
        recordDomain: 'client_money_opening_balances',
        sourceSystem: SRC,
        migration,
        openingBalances: {
          account: fx.account,
          balances: [
            {
              source_ref: 'mgr-ob1',
              matter_source_ref: 'mgr-m-overdrawn',
              amount: 900,
              as_at_date: '2023-06-30',
              source_closing_balance: 900,
              legacy_ledger: legacy,
            },
          ],
        },
      },
      { mode: 'real' },
    )
    expect(r.state, JSON.stringify(r.outcomes)).toBe('completed')
    expect(await ledgerCents('mgr-m-overdrawn')).toBe(90000)

    const txn = await admin.query(
      `select t.id, t.txn_kind from deedbox.money_transaction t
         join deedbox.source_reference sr
           on sr.target = t.id and sr.target_type = 'money_transaction'
        where sr.source_system = $1 and sr.source_ref = 'mgr-ob1'`,
      [SRC],
    )
    expect(txn.rows[0].txn_kind).toBe('opening_balance')

    // the old history is kept verbatim, hashed, and reachable from the
    // matter's own register entry — not merely from the batch report
    const entry = await admin.query(
      `select (detail ->> 'legacy_ledger_artefact')::bigint as artefact
         from deedbox.register_entry
        where subject_type = 'money_transaction' and subject = $1
          and event_kind = 'money.transaction_posted'`,
      [txn.rows[0].id],
    )
    const artefactId = entry.rows[0].artefact as number
    expect(artefactId).toBeTruthy()

    const artefact = await admin.query(
      `select kind, content_ref, content_hash from deedbox.stored_artefact where id = $1`,
      [artefactId],
    )
    expect(artefact.rows[0].kind).toBe('legacy_ledger_rendering')
    const stored = JSON.parse(artefact.rows[0].content_ref as string)
    expect(stored.document).toBe('legacy_ledger')
    expect(stored.closing_balance).toBe(900)
    expect(stored.history).toEqual(legacy)
    const { createHash } = await import('node:crypto')
    expect(createHash('sha256').update(artefact.rows[0].content_ref as string).digest('hex')).toBe(
      artefact.rows[0].content_hash,
    )
  })

  it('an opening balance disagreeing with the source closing balance refuses the whole batch', async () => {
    const before = await ledgerCents('mgr-m-clean')
    const bad = await runImportBatch(
      P,
      {
        recordDomain: 'client_money_opening_balances',
        sourceSystem: SRC,
        migration,
        openingBalances: {
          account: fx.account,
          balances: [
            {
              source_ref: 'mgr-ob-bad',
              matter_source_ref: 'mgr-m-clean',
              amount: 100,
              as_at_date: '2023-06-30',
              source_closing_balance: 250,
            },
          ],
        },
      },
      { mode: 'real' },
    )
    expect(bad.state).toBe('refused')
    expect(await ledgerCents('mgr-m-clean')).toBe(before)
    const landed = await admin.query(
      `select count(*)::int as n from deedbox.source_reference
        where source_system = $1 and source_ref = 'mgr-ob-bad'`,
      [SRC],
    )
    expect(landed.rows[0].n).toBe(0)
  })
})

describe('the cutover acceptance test: the first reconciliation certifies', () => {
  it('certifies green from the imported position, the equation balancing to the cent', async () => {
    // the account now holds the replayed clean ledger and the imported
    // opening balance; the bank really holds that money at the boundary
    const book = await admin.query(
      `select coalesce(sum(l.signed_amount), 0) as total
         from deedbox.ledger_line l
        where l.side = 'cash_book' and l.account = $1`,
      [fx.account],
    )
    const bookCents = cents(book.rows[0].total)
    expect(bookCents).toBe(335000 + 90000)

    const recon = await buildReconciliation(P, {
      account: fx.account,
      statementDate: '2023-06-30',
      statementBalance: bookCents / 100,
    })

    // Certification demands that EVERY statement line AND every cash-book
    // transaction on or before the statement date is matched or excepted,
    // and that each match group balances — its statement lines must sum to
    // its transactions' cash-book amounts. At a cutover boundary all of this
    // money has genuinely cleared the bank, so the bank's view carries one
    // line per movement, including the opening position.
    const bank: { ref: string; date: string; amount: number; description: string }[] = [
      { ref: 'mgr-mv1', date: '2023-04-03', amount: 4000, description: 'CARROW DEPOSIT' },
      { ref: 'mgr-mv2', date: '2023-05-19', amount: -1250.55, description: 'LAND REGISTRY' },
      { ref: 'mgr-mv3', date: '2023-06-01', amount: 600.55, description: 'CARROW TOP UP' },
      { ref: 'mgr-ob1', date: '2023-06-30', amount: 900, description: 'QUILL OPENING POSITION' },
    ]
    expect(cents(bank.reduce((t, b) => t + b.amount, 0))).toBe(bookCents)

    for (const b of bank) {
      const line = await ingestBankStatementLines(P, {
        account: fx.account,
        source: 'import',
        lines: [
          { lineDate: b.date, amount: b.amount, description: b.description, feedRef: `bank-${b.ref}` },
        ],
      })
      expect(line.inserted.length).toBe(1)
      const txn = await admin.query(
        `select t.id from deedbox.money_transaction t
           join deedbox.source_reference sr
             on sr.target = t.id and sr.target_type = 'money_transaction'
          where sr.source_system = $1 and sr.source_ref = $2`,
        [SRC, b.ref],
      )
      await createMatchGroup(P, {
        reconciliation: recon.id,
        statementLines: line.inserted,
        transactions: [txn.rows[0].id as number],
      })
    }

    const certified = await certifyReconciliation(P, { reconciliation: recon.id })
    const snap = certified.equationSnapshot as { ledger_total: number }
    expect(cents(snap.ledger_total)).toBe(bookCents)

    const state = await admin.query(
      `select status from deedbox.reconciliation where id = $1`,
      [recon.id],
    )
    expect(state.rows[0].status).toBe('certified')
  })
})
