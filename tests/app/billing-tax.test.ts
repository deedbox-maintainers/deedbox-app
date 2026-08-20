// Tax on bill lines (0049): the pack's billing.tax rule is evaluated at line
// creation, follows every amount change, is re-evaluated at submission, and
// the rule in force at issue governs — a group approved under one rule refuses
// to issue under another. Before a firm's pack declares any rate, every line
// carries zero tax (the neutral default) exactly as before.
//
// Cross-file contract: this file appends bill.approval_required rows effective
// 3 and 2 minutes ago (later than every earlier file's rows) and leaves it off.
// Its rate declarations sit on its OWN fixture pack; the key validity rule
// (0008) reads every active pack, and every key this file declares is one the
// other suites already use ('standard') or never touch ('gst_free').

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import type { Pool } from 'pg'
import { closePool } from '@/lib/db'
import type { Principal } from '@/lib/db'
import { createMatter } from '@/lib/ops/matters'
import {
  addStaffRate,
  createTimeEntry,
  createDisbursement,
  createDraftBillGroup,
  writeDownDraftItem,
  addManualDraftLine,
  submitForApproval,
  sendBackToDraft,
  issueBillGroup,
} from '@/lib/ops/billing'
import { makeAdminPool, buildFixture, setFirmSetting, type Fixture } from './helpers'

function cents(x: number | string): number {
  return Math.round(Number(x) * 100)
}

let admin: Pool
let fx: Fixture
let P: Principal
let pack: number

beforeAll(async () => {
  admin = makeAdminPool()
  fx = await buildFixture(admin, 'btx')
  P = { kind: 'staff', id: fx.staff, firm: fx.firm }
  await addStaffRate(P, { staff: fx.staff, rate: 400, effectiveFrom: '2020-01-01' })
  const cp = await admin.query(`select country_pack from deedbox.firm where id = $1`, [fx.firm])
  pack = cp.rows[0].country_pack as number
})

afterAll(async () => {
  await closePool()
  await admin.end()
})

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

async function hourOfWork(matter: number, narrative: string): Promise<number> {
  return (await createTimeEntry(P, { matter, workDate: '2026-08-01', units: 10, narrative })).id // 400.00
}

/** Declare a version of the fixture pack carrying these rates and activate it. */
async function declareRates(
  version: string,
  keys: { key: string; rate?: number; label?: string }[],
): Promise<void> {
  const pv = await admin.query(
    `insert into deedbox.pack_version (pack, version) values ($1, $2) returning id`,
    [pack, version],
  )
  for (const k of keys) {
    const body: Record<string, unknown> = { label: k.label ?? k.key }
    if (k.rate !== undefined) body.rate = k.rate
    await admin.query(
      `insert into deedbox.pack_declaration (pack_version, rule_point, kind, discriminator, body)
       values ($1, 'billing.tax', 'enumeration', $2, $3::jsonb)`,
      [pv.rows[0].id, k.key, JSON.stringify(body)],
    )
  }
  await admin.query(`update deedbox.country_pack set active_version = $1 where id = $2`, [
    pv.rows[0].id,
    pack,
  ])
}

async function linesOf(group: number): Promise<{ position: number; kind: string; amount: number; tax: number }[]> {
  const r = await admin.query(
    `select l.position, l.kind, l.amount, l.tax_amount
       from deedbox.bill_line l join deedbox.bill b on b.id = l.bill
      where b.bill_group = $1 order by l.position`,
    [group],
  )
  return r.rows.map((l) => ({
    position: l.position as number,
    kind: l.kind as string,
    amount: cents(l.amount),
    tax: cents(l.tax_amount),
  }))
}

describe('tax on bill lines', () => {
  let preRuleGroup: number // drafted before the pack declares any rate

  it('with no rate declared, every line carries zero tax (the neutral default)', async () => {
    const m = await newMatter('tax matter: before the rule')
    const te = await hourOfWork(m, 'work before any rate is declared')
    const g = await createDraftBillGroup(P, {
      matter: m,
      timeEntries: [te],
      manualLines: [{ description: 'search fee', amount: 25 }],
    })
    preRuleGroup = g.group
    const lines = await linesOf(g.group)
    expect(lines.map((l) => l.tax)).toEqual([0, 0])
    expect(lines.map((l) => l.amount)).toEqual([40000, 2500])
  })

  it('once the pack declares rates, new lines carry tax at creation, per treatment', async () => {
    await declareRates('2026.1', [
      { key: 'standard', rate: 0.1, label: 'GST' },
      { key: 'gst_free', label: 'GST-free' },
    ])
    const m = await newMatter('tax matter: under the rule')
    const te = await hourOfWork(m, 'taxable work')
    const d = await createDisbursement(P, {
      matter: m,
      incurredDate: '2026-08-01',
      description: 'court filing fee',
      amount: 90.91,
      taxTreatment: 'gst_free',
    })
    const g = await createDraftBillGroup(P, {
      matter: m,
      timeEntries: [te],
      disbursements: [d.id],
      manualLines: [{ description: 'agent fee', amount: 100 }],
    })
    const lines = await linesOf(g.group)
    expect(lines.map((l) => [l.kind, l.amount, l.tax])).toEqual([
      ['time', 40000, 4000],
      ['disbursement', 9091, 0],
      ['manual', 10000, 1000],
    ])

    // the tax follows a write-down, to the cent, and a later manual line evaluates on arrival
    await writeDownDraftItem(P, { group: g.group, position: 1, writtenDownTo: 300, reason: 'courtesy' })
    await addManualDraftLine(P, { group: g.group, description: 'photocopying', amount: 55.55 })
    const after = await linesOf(g.group)
    expect(after.map((l) => [l.amount, l.tax])).toEqual([
      [30000, 3000],
      [9091, 0],
      [10000, 1000],
      [5555, 556], // 5.555 rounds half-up to the cent
    ])

    // issue: total = Σ(amount + tax); the one issue_total entry says the same
    const r = await issueBillGroup(P, { group: g.group })
    expect(cents(r.bills[0].total)).toBe(30000 + 3000 + 9091 + 10000 + 1000 + 5555 + 556)
    const j = await admin.query(
      `select signed_amount from deedbox.bill_journal_entry where bill = $1 and entry_kind = 'issue_total'`,
      [r.bills[0].id],
    )
    expect(cents(j.rows[0].signed_amount)).toBe(59202)
  })

  it('a draft drafted before the rule issues with the rule in force: its lines heal at issue', async () => {
    const r = await issueBillGroup(P, { group: preRuleGroup })
    const lines = await linesOf(preRuleGroup)
    expect(lines.map((l) => l.tax)).toEqual([4000, 250])
    expect(cents(r.bills[0].total)).toBe(40000 + 4000 + 2500 + 250)
  })

  it('a group approved under one rule refuses to issue under another, and issues once resubmitted', async () => {
    await setFirmSetting(admin, 'bill.approval_required', true, 3)
    try {
      const m = await newMatter('tax matter: approval then a rule change')
      const te = await hourOfWork(m, 'approved work')
      const g = await createDraftBillGroup(P, { matter: m, timeEntries: [te] })
      await submitForApproval(P, { group: g.group })
      expect((await linesOf(g.group)).map((l) => l.tax)).toEqual([4000]) // evaluated at submission

      await declareRates('2026.2', [{ key: 'standard', rate: 0.2, label: 'GST' }, { key: 'gst_free' }])
      await expect(issueBillGroup(P, { group: g.group })).rejects.toMatchObject({ code: 'tax_changed' })
      // nothing issued, nothing moved: the approved tax still stands on the lines
      expect((await linesOf(g.group)).map((l) => l.tax)).toEqual([4000])

      await sendBackToDraft(P, { group: g.group, note: 'tax rule changed' })
      await submitForApproval(P, { group: g.group })
      expect((await linesOf(g.group)).map((l) => l.tax)).toEqual([8000]) // re-evaluated at resubmission
      const r = await issueBillGroup(P, { group: g.group })
      expect(cents(r.bills[0].total)).toBe(48000)
    } finally {
      await setFirmSetting(admin, 'bill.approval_required', false, 2)
    }
  })
})

describe('total-first disbursement entry (layer-2 batch)', () => {
  beforeAll(async () => {
    // an earlier test deliberately leaves a 20% rule governing — this
    // suite's arithmetic is pinned to the 10% world it states
    await declareRates('2026.3', [{ key: 'standard', rate: 0.1, label: 'GST' }, { key: 'gst_free' }])
  })

  it('derives the exclusive amount so billing lands the typed total to the cent', async () => {
    const m = await newMatter('total-first host')
    const d = await createDisbursement(P, {
      matter: m,
      incurredDate: '2026-08-01',
      description: 'filing fee off the receipt',
      inclusiveTotal: 92.7,
    })
    const row = await admin.query(
      `select amount, tax_treatment from deedbox.disbursement where id = $1`,
      [d.id],
    )
    expect(cents(row.rows[0].amount)).toBe(8427)
    expect(row.rows[0].tax_treatment).toBe('standard')
    const g = await createDraftBillGroup(P, { matter: m, disbursements: [d.id] })
    const lines = await linesOf(g.group)
    expect(lines[0].amount + lines[0].tax).toBe(9270) // the typed total, exactly
  })

  it('GST-free totals store verbatim; an unlandable total refuses honestly; both-inputs refuses', async () => {
    const m = await newMatter('total-first refusals host')
    const free = await createDisbursement(P, {
      matter: m,
      incurredDate: '2026-08-01',
      description: 'court fee, GST-free',
      inclusiveTotal: 11153.5,
      taxTreatment: 'gst_free',
    })
    const row = await admin.query(
      `select amount, tax_treatment from deedbox.disbursement where id = $1`,
      [free.id],
    )
    expect(cents(row.rows[0].amount)).toBe(1115350)
    expect(row.rows[0].tax_treatment).toBe('gst_free')

    // 11,153.50 under 10% add-on rounding: no exclusive amount lands it
    await expect(
      createDisbursement(P, {
        matter: m,
        incurredDate: '2026-08-01',
        description: 'unlandable total',
        inclusiveTotal: 11153.5,
      }),
    ).rejects.toMatchObject({ code: 'tax_cents' })

    await expect(
      createDisbursement(P, {
        matter: m,
        incurredDate: '2026-08-01',
        description: 'both inputs',
        amount: 100,
        inclusiveTotal: 110,
      }),
    ).rejects.toMatchObject({ code: 'bad_amount' })
  })
})

describe('the standing bill notice embeds at issue (0056)', () => {
  it('a set notice lands in the issued rendering; blank settings embed nothing', async () => {
    await setFirmSetting(admin, 'billing.bill_notice_heading', 'Funding options', 0)
    await setFirmSetting(admin, 'billing.bill_notice', 'Ask us about funding arrangements.', 0)
    const m1 = await newMatter('notice host on')
    const te1 = await hourOfWork(m1, 'noticed work')
    const g1 = await createDraftBillGroup(P, { matter: m1, timeEntries: [te1] })
    const issued = await issueBillGroup(P, { group: g1.group })
    const art = await admin.query(
      `select sa.content_ref from deedbox.bill b
         join deedbox.stored_artefact sa on sa.id = b.rendered_artefact::bigint
        where b.id = $1`,
      [issued.bills[0].id],
    )
    const rendering = JSON.parse(art.rows[0].content_ref as string)
    expect(rendering.notice).toEqual({ heading: 'Funding options', text: 'Ask us about funding arrangements.' })

    await setFirmSetting(admin, 'billing.bill_notice', '', 0)
    const m2 = await newMatter('notice host off')
    const te2 = await hourOfWork(m2, 'unnoticed work')
    const g2 = await createDraftBillGroup(P, { matter: m2, timeEntries: [te2] })
    const issued2 = await issueBillGroup(P, { group: g2.group })
    const art2 = await admin.query(
      `select sa.content_ref from deedbox.bill b
         join deedbox.stored_artefact sa on sa.id = b.rendered_artefact::bigint
        where b.id = $1`,
      [issued2.bills[0].id],
    )
    expect(JSON.parse(art2.rows[0].content_ref as string).notice).toBeNull()
  })
})
