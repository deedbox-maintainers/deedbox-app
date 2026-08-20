// The bulk machinery (dry-run/commit/reverse over the matters multi-select
// kinds) and the imports (mapping templates, the two-mode batch engine, money
// history and opening balances, all-or-nothing reversal, migration
// completion). Exercises invariants 22–30.
//
// Cross-suite contract: runs after billing-*, before interface-outbound and
// matters. Appends NO firm settings; consumes gapless matter/receipt
// numbers (shared counters — no other suite asserts absolute values).

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import type { Pool } from 'pg'
import { closePool } from '@/lib/db'
import type { Principal } from '@/lib/db'
import { createMatter } from '@/lib/ops/matters'
import { reopenMatter, holdMatter } from '@/lib/ops/matters/matterLifecycle'
import { renameParty } from '@/lib/ops/matters/partyNames'
import { recordMoneyReceipt } from '@/lib/ops/money'
import { dryRunBulk, commitBulk, reverseBulk } from '@/lib/ops/bulk'
import {
  saveMappingTemplate,
  startMigration,
  completeMigration,
  runImportBatch,
  reverseImportBatch,
} from '@/lib/ops/imports'
import { makeAdminPool, buildFixture, type Fixture } from './helpers'

let admin: Pool
let fx: Fixture
let P: Principal

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

async function matterStatus(id: number): Promise<string> {
  const r = await admin.query(`select status from deedbox.matter where id = $1`, [id])
  return r.rows[0].status as string
}

async function registerCount(kind: string, subjectType: string, subject: number): Promise<number> {
  const r = await admin.query(
    `select count(*)::int as n from deedbox.register_entry
      where event_kind = $1 and subject_type = $2 and subject = $3`,
    [kind, subjectType, subject],
  )
  return r.rows[0].n as number
}

beforeAll(async () => {
  admin = makeAdminPool()
  fx = await buildFixture(admin, 'bkim')
  P = { kind: 'staff', id: fx.staff, firm: fx.firm }
})

afterAll(async () => {
  await closePool()
  await admin.end()
})

describe('bulk machinery', () => {
  it('dry-run lists a money-holding matter as will-skip and includes clean ones', async () => {
    const m2 = await newMatter('Bulk money holder bkim')
    const m3 = await newMatter('Bulk clean one bkim')
    await recordMoneyReceipt(P, {
      matter: m2,
      account: fx.account,
      amount: 50,
      method: 'electronic_transfer',
      payerDescription: 'bulk test payer',
    })
    const dry = await dryRunBulk(P, { kind: 'matter_close', matters: [m2, m3] })
    expect(dry.included).toBe(1)
    expect(dry.skipped).toBe(1)
    const skipped = dry.items.find((i) => i.matter === m2)!
    expect(skipped.willSkip).toMatch(/holds 50/)
    const included = dry.items.find((i) => i.matter === m3)!
    expect(included.before).toEqual({ status: 'open' })
    expect(included.after).toEqual({ status: 'closed' })

    // the commit closes the clean matter, leaves the skipped one, and
    // registers ONE bulk.committed carrying the manifest
    const run = await commitBulk(P, { dryRun: dry })
    expect(run.executed).toBe(1)
    expect(await matterStatus(m3)).toBe('closed')
    expect(await matterStatus(m2)).toBe('open')
    expect(await registerCount('bulk.committed', 'bulk_operation', run.bulkOperation)).toBe(1)
    const items = await admin.query(
      `select entity from deedbox.bulk_operation_item where operation = $1`,
      [run.bulkOperation],
    )
    expect(items.rows.map((r) => r.entity)).toEqual([m3])
  })

  it('commit refuses when an item changed since the dry run', async () => {
    const m4 = await newMatter('Bulk fidelity bkim')
    const dry = await dryRunBulk(P, { kind: 'matter_close', matters: [m4] })
    await holdMatter(P, { matter: m4 })
    await expect(commitBulk(P, { dryRun: dry })).rejects.toMatchObject({ code: 're_prepare' })
    expect(await matterStatus(m4)).toBe('on_hold')
  })

  it('a hard failure at commit rolls back the whole run (all-or-nothing)', async () => {
    const m5 = await newMatter('Bulk atomic a bkim')
    const m6 = await newMatter('Bulk atomic b bkim')
    const dry = await dryRunBulk(P, { kind: 'matter_close', matters: [m5, m6] })
    expect(dry.included).toBe(2)
    // money arrives on m6 AFTER the dry run: its status is unchanged, so the
    // fidelity check passes, and the close guard itself refuses at commit
    await recordMoneyReceipt(P, {
      matter: m6,
      account: fx.account,
      amount: 25,
      method: 'electronic_transfer',
      payerDescription: 'race payer',
    })
    const before = await admin.query(
      `select count(*)::int as n from deedbox.bulk_operation where operation_kind = 'matter_close'`,
    )
    await expect(commitBulk(P, { dryRun: dry })).rejects.toMatchObject({ code: 'close_refused' })
    expect(await matterStatus(m5)).toBe('open')
    expect(await matterStatus(m6)).toBe('open')
    const after = await admin.query(
      `select count(*)::int as n from deedbox.bulk_operation where operation_kind = 'matter_close'`,
    )
    expect(after.rows[0].n).toBe(before.rows[0].n)
  })

  it('reverses a run within the window; touched items block individually', async () => {
    const m7 = await newMatter('Bulk undo a bkim')
    const m8 = await newMatter('Bulk undo b bkim')
    const dry = await dryRunBulk(P, { kind: 'matter_close', matters: [m7, m8] })
    const run = await commitBulk(P, { dryRun: dry })
    expect(await matterStatus(m7)).toBe('closed')
    // m7 is manually reopened after the run: its item must block; m8 reverses
    await reopenMatter(P, { matter: m7, reason: 'manual reopen before undo bkim' })
    const rev = await reverseBulk(P, { bulkOperation: run.bulkOperation, reason: 'testing undo' })
    expect(rev.reversed).toBe(1)
    expect(rev.blocked).toBe(1)
    expect(await matterStatus(m8)).toBe('open')
    expect(await registerCount('bulk.reversed', 'bulk_operation', run.bulkOperation)).toBe(1)
    // the undo of a close replays a reopen with an auto-reason naming the run
    const reason = await admin.query(
      `select reason from deedbox.register_entry
        where event_kind = 'matter.status_changed' and subject = $1 and reason is not null
        order by id desc limit 1`,
      [m8],
    )
    expect(reason.rows[0].reason).toMatch(new RegExp(`bulk reversal of run ${run.bulkOperation}`))
    const outcomes = await admin.query(
      `select entity, reversal_outcome from deedbox.bulk_operation_item where operation = $1 order by entity`,
      [run.bulkOperation],
    )
    expect(outcomes.rows.find((r) => r.entity === m7)!.reversal_outcome).toBe('blocked')
    expect(outcomes.rows.find((r) => r.entity === m8)!.reversal_outcome).toBe('reversed')
    // a run reverses once
    await expect(
      reverseBulk(P, { bulkOperation: run.bulkOperation, reason: 'again' }),
    ).rejects.toMatchObject({ code: 'already_reversed' })
  })

  it('hold runs reverse to open; the window refuses when closed', async () => {
    const m9 = await newMatter('Bulk hold a bkim')
    const dry = await dryRunBulk(P, { kind: 'matter_hold', matters: [m9] })
    const run = await commitBulk(P, { dryRun: dry })
    expect(await matterStatus(m9)).toBe('on_hold')
    await reverseBulk(P, { bulkOperation: run.bulkOperation, reason: 'undo hold' })
    expect(await matterStatus(m9)).toBe('open')

    // a run whose window has passed refuses (row planted with a spent window)
    const stale = await admin.query(
      `insert into deedbox.bulk_operation
         (operation_kind, dry_run_summary, committed_at, committed_by, reversible_until)
       values ('matter_hold', '{}', now() - interval '8 days', $1, now() - interval '1 day')
       returning id`,
      [fx.staff],
    )
    await expect(
      reverseBulk(P, { bulkOperation: stale.rows[0].id as number, reason: 'too late' }),
    ).rejects.toMatchObject({ code: 'window_closed' })
  })
})

describe('imports (invariants 24–27)', () => {
  const file = (suffix = '') => [
    { source_ref: 'u1', data: { kind: 'person', full_name: `Ursula Import${suffix}`, phone: '0400777001' } },
    { source_ref: 'u2', data: { kind: 'person', full_name: 'Umberto Import', email: 'umberto@example.test' } },
    { source_ref: 'u3', data: { kind: 'person', full_name: '' } },
  ]
  let validateDispositions: string[]
  let clientsBatch: number
  let u2Party: number

  it('saves a firm mapping template', async () => {
    const t = await saveMappingTemplate(P, {
      sourceFormatKey: 'legacy-csv-bkim',
      recordType: 'clients',
      name: 'Legacy clients bkim',
      fieldMap: { name: 'A', phone: 'B' },
    })
    expect(await registerCount('record.created', 'mapping_template', t.id)).toBe(1)
  })

  it('validate-only runs the identical pipeline and persists nothing', async () => {
    const before = await admin.query(
      `select count(*)::int as n from deedbox.party where display_name like '%Import%'`,
    )
    const r = await runImportBatch(
      P,
      { recordDomain: 'clients', sourceSystem: 'LegacySys', records: file() },
      { mode: 'validate_only' },
    )
    expect(r.state).toBe('completed')
    validateDispositions = r.outcomes.map((o) => o.disposition)
    expect(validateDispositions).toEqual(['accepted', 'accepted', 'refused'])
    const after = await admin.query(
      `select count(*)::int as n from deedbox.party where display_name like '%Import%'`,
    )
    expect(after.rows[0].n).toBe(before.rows[0].n) // zero business residue
    const batch = await admin.query(
      `select mode, state, report_artefact from deedbox.import_batch where id = $1`,
      [r.batch],
    )
    expect(batch.rows[0].mode).toBe('validate_only')
    expect(batch.rows[0].report_artefact).not.toBeNull()
    const m4 = await admin.query(
      `select count(*)::int as n from deedbox.import_record where batch = $1`,
      [r.batch],
    )
    expect(m4.rows[0].n).toBe(3)
  })

  it('the real run matches validate-only disposition for disposition', async () => {
    const r = await runImportBatch(
      P,
      { recordDomain: 'clients', sourceSystem: 'LegacySys', records: file() },
      { mode: 'real' },
    )
    clientsBatch = r.batch
    expect(r.state).toBe('completed')
    expect(r.outcomes.map((o) => o.disposition)).toEqual(validateDispositions)
    const m5 = await admin.query(
      `select source_ref, target from deedbox.source_reference
        where source_system = 'LegacySys' and target_type = 'party' order by source_ref`,
    )
    expect(m5.rows.map((x) => x.source_ref)).toEqual(['u1', 'u2'])
    u2Party = m5.rows[1].target as number
    expect(await registerCount('import.batch_applied', 'import_batch', r.batch)).toBe(1)
  })

  it('re-runs are repeat-safe; touched targets are skipped, never overwritten', async () => {
    // a plain re-run: zero duplicates, both hits itemised
    const rerun = await runImportBatch(
      P,
      { recordDomain: 'clients', sourceSystem: 'LegacySys', records: file() },
      { mode: 'real' },
    )
    expect(rerun.outcomes.map((o) => o.disposition)).toEqual([
      'accepted_with_warning',
      'accepted_with_warning',
      'refused',
    ])
    const count = await admin.query(
      `select count(*)::int as n from deedbox.party where display_name = 'Umberto Import'`,
    )
    expect(count.rows[0].n).toBe(1)

    // a changed source line lands via the source-reference hit as an update
    const upd = await runImportBatch(
      P,
      {
        recordDomain: 'clients',
        sourceSystem: 'LegacySys',
        records: [file('-Chang')[0]],
      },
      { mode: 'real' },
    )
    expect(upd.outcomes[0].disposition).toBe('updated')
    const renamed = await admin.query(
      `select display_name from deedbox.party
        where id = (select target from deedbox.source_reference
                     where source_system = 'LegacySys' and source_ref = 'u1' and target_type = 'party')`,
    )
    expect(renamed.rows[0].display_name).toBe('Ursula Import-Chang')

    // a staff member touches u2's party: the next import run must not update it
    await renameParty(P, { party: u2Party, fullName: 'Umberto Touched-By-Staff' })
    const touched = await runImportBatch(
      P,
      {
        recordDomain: 'clients',
        sourceSystem: 'LegacySys',
        records: [{ source_ref: 'u2', data: { kind: 'person', full_name: 'Umberto From-File' } }],
      },
      { mode: 'real' },
    )
    expect(touched.outcomes[0].disposition).toBe('accepted_with_warning')
    expect(touched.outcomes[0].message).toMatch(/changed since import/)
    const kept = await admin.query(`select display_name from deedbox.party where id = $1`, [u2Party])
    expect(kept.rows[0].display_name).toBe('Umberto Touched-By-Staff')
  })

  it('imports matters through the domain path, closed ones closing directly', async () => {
    const r = await runImportBatch(
      P,
      {
        recordDomain: 'matters',
        sourceSystem: 'LegacySys',
        records: [
          {
            source_ref: 'm1',
            data: {
              title: 'Imported open matter bkim',
              client_source_ref: 'u1',
              responsible_lawyer_login: 'pat.bkim',
              office_code: 'BKIM',
              practice_area_name: 'General bkim',
            },
          },
          {
            source_ref: 'm2',
            data: {
              title: 'Imported closed matter bkim',
              client_source_ref: 'u1',
              responsible_lawyer_login: 'pat.bkim',
              office_code: 'BKIM',
              practice_area_name: 'General bkim',
              status: 'closed',
            },
          },
        ],
      },
      { mode: 'real' },
    )
    expect(r.outcomes.map((o) => o.disposition)).toEqual(['accepted', 'accepted'])
    const m = await admin.query(
      `select m.status, m.origin_note from deedbox.matter m
        join deedbox.source_reference sr on sr.target = m.id and sr.target_type = 'matter'
       where sr.source_system = 'LegacySys' and sr.source_ref in ('m1','m2')
       order by sr.source_ref`,
    )
    expect(m.rows[0].status).toBe('open')
    expect(m.rows[0].origin_note).toMatch(/imported from LegacySys/)
    expect(m.rows[1].status).toBe('closed')
  })

  it('a batch that created only untouched clients reverses whole; a touched one reverses nothing', async () => {
    // the touched batch: u2 carries a staff rename → NOTHING reverses
    const blockedAttempt = await reverseImportBatch(P, {
      batch: clientsBatch,
      reason: 'testing all-or-nothing',
    })
    expect(blockedAttempt.state).toBe('partially_blocked')
    expect(blockedAttempt.blockers.some((b) => b.sourceRef === 'u2')).toBe(true)
    const u1Alive = await admin.query(
      `select deleted_at from deedbox.party
        where id = (select target from deedbox.source_reference
                     where source_system = 'LegacySys' and source_ref = 'u1' and target_type = 'party')`,
    )
    expect(u1Alive.rows[0].deleted_at).toBeNull() // nothing was reversed
    expect(await registerCount('import.batch_reversed', 'import_batch', clientsBatch)).toBe(0)

    // a fresh batch of untouched clients reverses whole
    const fresh = await runImportBatch(
      P,
      {
        recordDomain: 'clients',
        sourceSystem: 'LegacySys',
        records: [
          { source_ref: 'w1', data: { kind: 'person', full_name: 'Wanda Reversible' } },
          { source_ref: 'w2', data: { kind: 'person', full_name: 'Walter Reversible' } },
        ],
      },
      { mode: 'real' },
    )
    const reversed = await reverseImportBatch(P, { batch: fresh.batch, reason: 'undo the import' })
    expect(reversed.state).toBe('reversed')
    const gone = await admin.query(
      `select count(*)::int as n from deedbox.party
        where display_name like '% Reversible' and deleted_at is not null`,
    )
    expect(gone.rows[0].n).toBe(2)
    expect(await registerCount('import.batch_reversed', 'import_batch', fresh.batch)).toBe(1)
    const evt = await admin.query(
      `select bulk_operation from deedbox.register_entry
        where event_kind = 'import.batch_reversed' and subject = $1`,
      [fresh.batch],
    )
    expect(evt.rows[0].bulk_operation).not.toBeNull()
    // source-reference rows are retained as history
    const m5 = await admin.query(
      `select count(*)::int as n from deedbox.source_reference
        where source_system = 'LegacySys' and source_ref in ('w1','w2')`,
    )
    expect(m5.rows[0].n).toBe(2)
  })
})

describe('money import (invariants 28–29) and migration completion', () => {
  let migration: number
  let historyBatch: number
  let historyMatter: number

  it('replays full history chronologically and reproduces the source balances', async () => {
    migration = (await startMigration(P, { sourceSystem: 'LegacySys' })).id
    historyMatter = await newMatter('Money history host bkim')
    const r = await runImportBatch(
      P,
      {
        recordDomain: 'client_money_full_history',
        sourceSystem: 'LegacySys',
        migration,
        fullHistory: {
          account: fx.account,
          movements: [
            {
              source_ref: 'mv1',
              kind: 'receipt',
              matter: historyMatter,
              amount: 500,
              effective_date: '2020-01-05',
              entered_at: '2020-01-05T10:00:00Z',
            },
            {
              source_ref: 'mv2',
              kind: 'receipt',
              matter: historyMatter,
              amount: 300,
              effective_date: '2020-02-05',
              entered_at: '2020-02-05T10:00:00Z',
            },
            {
              source_ref: 'mv3',
              kind: 'payment_out',
              matter: historyMatter,
              amount: 200,
              effective_date: '2020-03-05',
              entered_at: '2020-03-05T10:00:00Z',
              payee: 'Historical Payee',
            },
          ],
        },
      },
      { mode: 'real' },
    )
    historyBatch = r.batch
    expect(r.state, JSON.stringify(r.outcomes)).toBe('completed')
    expect(r.outcomes.every((o) => o.disposition === 'accepted')).toBe(true)
    const ledger = await admin.query(
      `select id, deedbox.ledger_balance(id) as b from deedbox.matter_ledger
        where matter = $1 and account = $2`,
      [historyMatter, fx.account],
    )
    expect(Math.round(Number(ledger.rows[0].b) * 100)).toBe(60000)
    const receipts = await admin.query(
      `select receipt_number from deedbox.money_receipt where matter_ledger = $1 order by id`,
      [ledger.rows[0].id],
    )
    expect(receipts.rowCount).toBe(2)
    const entered = await admin.query(
      `select count(*)::int as n from deedbox.money_transaction t
        join deedbox.source_reference sr on sr.target = t.id and sr.target_type = 'money_transaction'
       where sr.source_ref in ('mv1','mv2','mv3') and t.source_entered_at is not null`,
    )
    expect(entered.rows[0].n).toBe(3) // every movement carries the historically true entry moment
  })

  it('a failing movement refuses the whole batch with zero money rows', async () => {
    const mg = await newMatter('Money refusal host bkim')
    const r = await runImportBatch(
      P,
      {
        recordDomain: 'client_money_full_history',
        sourceSystem: 'LegacySys',
        fullHistory: {
          account: fx.account,
          movements: [
            {
              source_ref: 'bad1',
              kind: 'payment_out',
              matter: mg,
              amount: 100,
              effective_date: '2020-01-10',
              entered_at: '2020-01-10T10:00:00Z',
            },
          ],
        },
      },
      { mode: 'real' },
    )
    expect(r.state).toBe('refused')
    // the staging posture discarded everything: not even the ledger survives
    const ledgers = await admin.query(
      `select count(*)::int as n from deedbox.matter_ledger where matter = $1`,
      [mg],
    )
    expect(ledgers.rows[0].n).toBe(0)
    const m5 = await admin.query(
      `select count(*)::int as n from deedbox.source_reference where source_ref = 'bad1'`,
    )
    expect(m5.rows[0].n).toBe(0)
    const batch = await admin.query(`select state from deedbox.import_batch where id = $1`, [r.batch])
    expect(batch.rows[0].state).toBe('refused')
    // the refusal is ALSO in the permanent refused-operation register
    const k11 = await admin.query(
      `select refusal_reason from deedbox.refused_operation
        where account = $1 order by id desc limit 1`,
      [fx.account],
    )
    expect(k11.rows[0].refusal_reason).toBe('would_go_below_zero')
  })

  it('opening balances post labelled transactions with the boundary artefact', async () => {
    const mh = await newMatter('Opening balance host bkim')
    const ok = await runImportBatch(
      P,
      {
        recordDomain: 'client_money_opening_balances',
        sourceSystem: 'LegacySys',
        migration,
        openingBalances: {
          account: fx.account,
          balances: [
            {
              source_ref: 'ob1',
              matter: mh,
              amount: 250,
              as_at_date: '2024-06-30',
              source_closing_balance: 250,
            },
          ],
        },
      },
      { mode: 'real' },
    )
    expect(ok.state, JSON.stringify(ok.outcomes)).toBe('completed')
    const txn = await admin.query(
      `select t.txn_kind from deedbox.money_transaction t
        join deedbox.source_reference sr on sr.target = t.id and sr.target_type = 'money_transaction'
       where sr.source_ref = 'ob1'`,
    )
    expect(txn.rows[0].txn_kind).toBe('opening_balance')
    const report = await admin.query(
      `select a.content_ref from deedbox.stored_artefact a
        join deedbox.import_batch b on b.report_artefact = a.id::text
       where b.id = $1`,
      [ok.batch],
    )
    expect(report.rows[0].content_ref).toMatch(/boundary_reconciliation/)

    // a mismatch against the source closing balance refuses the whole batch
    const mi = await newMatter('Opening mismatch host bkim')
    const bad = await runImportBatch(
      P,
      {
        recordDomain: 'client_money_opening_balances',
        sourceSystem: 'LegacySys',
        openingBalances: {
          account: fx.account,
          balances: [
            {
              source_ref: 'ob2',
              matter: mi,
              amount: 300,
              as_at_date: '2024-06-30',
              source_closing_balance: 250,
            },
          ],
        },
      },
      { mode: 'real' },
    )
    expect(bad.state).toBe('refused')
    const none = await admin.query(
      `select count(*)::int as n from deedbox.matter_ledger where matter = $1`,
      [mi],
    )
    expect(none.rows[0].n).toBe(0)
  })

  it('reverses money history by proper reversal transactions; documents keep their numbers', async () => {
    const r = await reverseImportBatch(P, { batch: historyBatch, reason: 'unwind the history import' })
    expect(r.state).toBe('reversed')
    const ledger = await admin.query(
      `select id, deedbox.ledger_balance(id) as b from deedbox.matter_ledger
        where matter = $1 and account = $2`,
      [historyMatter, fx.account],
    )
    expect(Math.round(Number(ledger.rows[0].b) * 100)).toBe(0)
    // never row deletion: the originals stand, mirrored by reversals
    const reversals = await admin.query(
      `select count(*)::int as n from deedbox.money_transaction t
        where t.txn_kind = 'reversal' and t.reverses in (
          select sr.target from deedbox.source_reference sr
           where sr.source_system = 'LegacySys' and sr.source_ref in ('mv1','mv2','mv3'))`,
    )
    expect(reversals.rows[0].n).toBe(3)
    const receipts = await admin.query(
      `select count(*)::int as n from deedbox.money_receipt where matter_ledger = $1`,
      [ledger.rows[0].id],
    )
    expect(receipts.rows[0].n).toBe(2) // the receipt documents keep their numbers
    expect(await registerCount('import.batch_reversed', 'import_batch', historyBatch)).toBe(1)
  })

  it('completes the migration with the permanent summary artefact', async () => {
    const done = await completeMigration(P, { migration })
    const m = await admin.query(
      `select completed_at, summary, summary_artefact from deedbox.migration where id = $1`,
      [migration],
    )
    expect(m.rows[0].completed_at).not.toBeNull()
    expect(String(m.rows[0].summary_artefact)).toBe(String(done.summaryArtefact))
    const summary = m.rows[0].summary as { batches: unknown[] }
    expect(summary.batches.length).toBeGreaterThanOrEqual(2)
    await expect(completeMigration(P, { migration })).rejects.toMatchObject({
      code: 'already_completed',
    })
  })
})
