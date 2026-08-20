// The workbook appliers: time, issued bills with their journal
// history, and unbilled disbursements — the domains recorded as
// migration-workbook content, now real. Proven through the REAL batch
// engine: validate-only and real runs agree record-for-record (invariant
// 25), validate-only leaves nothing, re-runs never duplicate history, an
// imported bill KEEPS its old number and reproduces its outstanding to
// the cent, and every hard problem refuses typed and itemised.
//
// Cross-suite contract: flips NO settings; imports land on this fixture's
// own matters only. Fixture tag 'imw' (first-three unique).

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import type { Pool } from 'pg'
import { closePool } from '@/lib/db'
import type { Principal } from '@/lib/db'
import { runImportBatch } from '@/lib/ops/imports'
import { makeAdminPool, buildFixture, type Fixture } from './helpers'

let admin: Pool
let fx: Fixture
let P: Principal
let staffLogin = ''
let officeCode = ''
let practiceArea = ''

const SRC = 'imw-old-system'

beforeAll(async () => {
  admin = makeAdminPool()
  fx = await buildFixture(admin, 'imw')
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
})

afterAll(async () => {
  await closePool()
  await admin.end()
})

describe('the workbook appliers', () => {
  it('time: validate-only and real agree; values reproduce; re-runs never duplicate', async () => {
    const records = [
      {
        source_ref: 'imw-t1',
        data: {
          matter: fx.matter,
          staff_login: staffLogin,
          work_date: '2026-05-04',
          units: 5,
          manual_rate: 350,
          narrative: 'Imported attendance imwtok1',
        },
      },
      {
        source_ref: 'imw-t2',
        data: {
          matter: fx.matter,
          staff_login: staffLogin,
          work_date: '2026-05-06',
          kind: 'fixed_fee',
          fixed_amount: 990,
          narrative: 'Imported fixed advice imwtok2',
        },
      },
      {
        source_ref: 'imw-t3',
        data: {
          matter: fx.matter,
          staff_login: 'nobody.imw',
          work_date: '2026-05-07',
          units: 2,
          manual_rate: 100,
          narrative: 'Unknown owner',
        },
      },
    ]

    const dry = await runImportBatch(
      P,
      { recordDomain: 'time', sourceSystem: SRC, records },
      { mode: 'validate_only' },
    )
    const none = await admin.query(
      `select count(*)::int as n from deedbox.time_entry where narrative like 'Imported %imwtok%'`,
    )
    expect(none.rows[0].n).toBe(0)

    const real = await runImportBatch(
      P,
      { recordDomain: 'time', sourceSystem: SRC, records },
      { mode: 'real' },
    )
    // same file, same state, same dispositions record-for-record
    expect(real.outcomes.map((o) => o.disposition)).toEqual(dry.outcomes.map((o) => o.disposition))
    expect(real.counts.accepted).toBe(2)
    expect(real.counts.refused).toBe(1)
    const refusal = real.outcomes.find((o) => o.sourceRef === 'imw-t3')
    expect(refusal?.message).toMatch(/staff_unresolved|no staff member/)

    const rows = await admin.query(
      `select value::numeric as value, origin, staff from deedbox.time_entry
        where matter = $1 and narrative like 'Imported %' order by work_date`,
      [fx.matter],
    )
    expect(rows.rowCount).toBe(2)
    expect(Number(rows.rows[0].value)).toBe(175) // 5 units at 350/hour
    expect(Number(rows.rows[1].value)).toBe(990)
    expect(rows.rows.every((r) => r.origin === 'import' && r.staff === fx.staff)).toBe(true)

    const rerun = await runImportBatch(
      P,
      { recordDomain: 'time', sourceSystem: SRC, records: records.slice(0, 2) },
      { mode: 'real' },
    )
    expect(rerun.counts.accepted_with_warning).toBe(2)
    const still = await admin.query(
      `select count(*)::int as n from deedbox.time_entry where matter = $1 and narrative like 'Imported %'`,
      [fx.matter],
    )
    expect(still.rows[0].n).toBe(2)
  })

  it('bills: the old number survives, the journal reproduces outstanding to the cent, refusals are typed', async () => {
    const good = {
      source_ref: 'imw-b1',
      data: {
        matter: fx.matter,
        bill_number: 'OLD-INV-0077',
        issue_date: '2025-11-03',
        terms_days: 14,
        lines: [
          { description: 'Professional costs', net: 1000, tax: 100 },
          { description: 'Filing fee', net: 90.91, tax: 9.09 },
        ],
        journal: [
          { kind: 'issue_total', amount: 1200, date: '2025-11-03' },
          { kind: 'payment_allocation', amount: -400, date: '2025-12-01' },
          { kind: 'write_off', amount: -100, date: '2026-02-01', reason: 'bad debt written off in the source system' },
        ],
        legacy_detail: { old_id: 'inv-77', consultant: 'someone historical' },
      },
    }
    const disagree = {
      source_ref: 'imw-b2',
      data: { ...good.data, bill_number: 'OLD-INV-0078', lines: [{ description: 'x', net: 1, tax: 0 }] },
    }
    const overpaid = {
      source_ref: 'imw-b3',
      data: {
        ...good.data,
        bill_number: 'OLD-INV-0079',
        journal: [
          { kind: 'issue_total', amount: 1200, date: '2025-11-03' },
          { kind: 'payment_allocation', amount: -1300, date: '2025-12-01' },
        ],
      },
    }
    const records = [good, disagree, overpaid]

    const dry = await runImportBatch(
      P,
      { recordDomain: 'bills', sourceSystem: SRC, records },
      { mode: 'validate_only' },
    )
    const real = await runImportBatch(
      P,
      { recordDomain: 'bills', sourceSystem: SRC, records },
      { mode: 'real' },
    )
    expect(real.outcomes.map((o) => o.disposition)).toEqual(dry.outcomes.map((o) => o.disposition))
    // the good record compared WHOLE (toEqual) so any refusal prints its
    // exact message in the diff — and the expectation still pins the
    // accepted outcome's honest outstanding message
    expect({ d: real.outcomes[0].disposition, m: real.outcomes[0].message }).toEqual({
      d: 'accepted',
      m: 'outstanding 700.00',
    })
    expect(real.counts.accepted).toBe(1)
    expect(real.counts.refused).toBe(2)
    expect(real.outcomes.find((o) => o.sourceRef === 'imw-b2')?.message).toMatch(/totals_disagree|to the cent/)
    expect(real.outcomes.find((o) => o.sourceRef === 'imw-b3')?.message).toMatch(/history_not_replayable|below zero/)

    const bill = await admin.query(
      `select b.id, b.state, b.bill_number, b.terms_days_applied, b.due_date::text as due,
              (select coalesce(sum(j.signed_amount), 0) from deedbox.bill_journal_entry j where j.bill = b.id) as outstanding,
              (select coalesce(sum(j.signed_amount), 0) from deedbox.bill_journal_entry j where j.bill = b.id and j.entry_kind = 'issue_total') as issued,
              (select count(*)::int from deedbox.bill_line l where l.bill = b.id) as lines
         from deedbox.bill b where b.bill_number = 'OLD-INV-0077'`,
    )
    expect(bill.rowCount).toBe(1)
    const b = bill.rows[0]
    expect(b.state).toBe('issued')
    expect(Number(b.issued)).toBe(1200)
    expect(Number(b.outstanding)).toBe(700)
    expect(b.lines).toBe(2)
    expect(b.due).toBe('2025-11-17')

    // the legacy rendering artefact preserves the whole old record
    const art = await admin.query(
      `select sa.content_ref from deedbox.stored_artefact sa
        join deedbox.bill bb on bb.rendered_artefact = sa.id::text
       where bb.bill_number = 'OLD-INV-0077' and sa.kind = 'legacy_bill_rendering'`,
    )
    expect(art.rowCount).toBe(1)
    const stored = JSON.parse(art.rows[0].content_ref as string)
    expect(stored.legacy_detail.old_id).toBe('inv-77')

    // the write-off's justification carried across (the schema demands it)
    const wo = await admin.query(
      `select reason from deedbox.bill_journal_entry where bill = $1 and entry_kind = 'write_off'`,
      [b.id],
    )
    expect(wo.rows[0].reason).toBe('bad debt written off in the source system')

    // the register carries the import marker (the touched-rule contract)
    const reg = await admin.query(
      `select count(*)::int as n from deedbox.register_entry
        where subject_type = 'bill' and subject = $1 and detail->>'import_batch' is not null`,
      [b.id],
    )
    expect(reg.rows[0].n).toBe(1)

    // no reminder schedule exists for an imported bill — chasing is a
    // deliberate later act
    const rem = await admin.query(
      `select count(*)::int as n from deedbox.bill_reminder_state where bill = $1`,
      [b.id],
    )
    expect(rem.rows[0].n).toBe(0)

    // the journal stays append-only history (the schema's own guard)
    await expect(
      admin.query(`update deedbox.bill_journal_entry set signed_amount = 0 where bill = $1`, [b.id]),
    ).rejects.toThrow(/append-only/)

    // a duplicate old number refuses typed; a re-run of the good record warns
    const again = await runImportBatch(
      P,
      {
        recordDomain: 'bills',
        sourceSystem: SRC,
        records: [
          good,
          { source_ref: 'imw-b4', data: { ...good.data } },
        ],
      },
      { mode: 'real' },
    )
    expect(again.outcomes.find((o) => o.sourceRef === 'imw-b1')?.disposition).toBe('accepted_with_warning')
    expect(again.outcomes.find((o) => o.sourceRef === 'imw-b4')?.message).toMatch(/bill_number_taken|already exists/)
    const one = await admin.query(
      `select count(*)::int as n from deedbox.bill where bill_number = 'OLD-INV-0077'`,
    )
    expect(one.rows[0].n).toBe(1)
  })

  it('matters: a prior-system reference lands on the matter and never moves again', async () => {
    const r = await runImportBatch(
      P,
      {
        recordDomain: 'matters',
        sourceSystem: SRC,
        records: [
          {
            source_ref: 'imw-m-prior',
            data: {
              title: 'Imported matter with a prior number imw',
              client_party: fx.clientParty,
              responsible_lawyer_login: staffLogin,
              office_code: officeCode,
              practice_area_name: practiceArea,
              prior_reference: '11363',
            },
          },
        ],
      },
      { mode: 'real' },
    )
    expect(r.counts.accepted).toBe(1)
    const m = await admin.query(
      `select id, prior_reference from deedbox.matter
        where title = 'Imported matter with a prior number imw'`,
    )
    expect(m.rowCount).toBe(1)
    expect(m.rows[0].prior_reference).toBe('11363')
    await expect(
      admin.query(`update deedbox.matter set prior_reference = 'moved' where id = $1`, [
        m.rows[0].id,
      ]),
    ).rejects.toThrow(/immutable once set/)
  })

  it('other: unbilled disbursements land on open matters; closed matters refuse typed', async () => {
    // a matter imported CLOSED (through the matters applier's direct-close
    // path) is the refusal target
    const closedMatter = await runImportBatch(
      P,
      {
        recordDomain: 'matters',
        sourceSystem: SRC,
        records: [
          {
            source_ref: 'imw-m-closed',
            data: {
              title: 'Imported closed matter imw',
              client_party: fx.clientParty,
              responsible_lawyer_login: staffLogin,
              office_code: officeCode,
              practice_area_name: practiceArea,
              status: 'closed',
              close_note: 'closed in the source system',
            },
          },
        ],
      },
      { mode: 'real' },
    )
    expect(closedMatter.counts.accepted).toBe(1)

    const records = [
      {
        source_ref: 'imw-d1',
        data: {
          record_kind: 'disbursement',
          matter: fx.matter,
          incurred_date: '2026-06-01',
          description: 'Imported search fee imwtok3',
          amount: 42.5,
        },
      },
      {
        source_ref: 'imw-d2',
        data: {
          record_kind: 'disbursement',
          matter_source_ref: 'imw-m-closed',
          incurred_date: '2026-06-02',
          description: 'Cost on a closed matter',
          amount: 10,
        },
      },
    ]
    const real = await runImportBatch(
      P,
      { recordDomain: 'other', sourceSystem: SRC, records },
      { mode: 'real' },
    )
    expect(real.counts.accepted).toBe(1)
    expect(real.counts.refused).toBe(1)
    expect(real.outcomes.find((o) => o.sourceRef === 'imw-d2')?.message).toMatch(/matter_closed|OPEN matters/)

    const row = await admin.query(
      `select amount::numeric as amount, billable from deedbox.disbursement
        where matter = $1 and description like 'Imported search fee%'`,
      [fx.matter],
    )
    expect(row.rowCount).toBe(1)
    expect(Number(row.rows[0].amount)).toBe(42.5)
  })
})
