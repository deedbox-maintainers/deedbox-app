// The reporting catalogue engine with role visibility and the own-figures
// scope, privileged exports carrying the artefact and the restricted
// count, saved reports and per-recipient schedules, targets, search over
// the synchronous index, recents/pins, and the position cache with its
// verifier. Runs between plumbing and workflow under the pinned order;
// fixtures fully tagged.

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import type { Pool } from 'pg'
import { closePool } from '@/lib/db'
import type { Principal } from '@/lib/db'
import { createMatter } from '@/lib/ops/matters'
import { addStaffRate, createTimeEntry, createDisbursement, createDraftBillGroup, issueBillGroup } from '@/lib/ops/billing'
import { recordMoneyReceipt } from '@/lib/ops/money'
import { createTask } from '@/lib/ops/workflow'
import {
  runReport,
  exportReport,
  saveReport,
  runSavedReport,
  replaceTargets,
  listTargets,
  createReportSchedule,
  setSchedulePaused,
  runDueSchedules,
  suggest,
  search,
  recordView,
  pinItem,
  unpinItem,
  recomputePositionCache,
  verifyPositionCache,
} from '@/lib/ops/reports'
import { makeAdminPool, buildFixture, type Fixture } from './helpers'

let admin: Pool
let fx: Fixture
let P: Principal
let L: Principal // a lawyer-role principal
let matter: number
let bill: number

function dateStr(daysAgo: number): string {
  return new Date(Date.now() - daysAgo * 86400000).toISOString().slice(0, 10)
}
function cents(x: unknown): number {
  return Math.round(Number(x) * 100)
}

beforeAll(async () => {
  admin = makeAdminPool()
  fx = await buildFixture(admin, 'rept')
  P = { kind: 'staff', id: fx.staff, firm: fx.firm }
  const lawyerRole = await admin.query(`select id from deedbox.role where system_key = 'lawyer'`)
  const lawyer = await admin.query(
    `insert into deedbox.staff_member (person_name, login, role, office, email)
     values ('{"display":"Lex Lawyer"}','lex.rept', $1, $2, 'lex.rept@example.test') returning id`,
    [lawyerRole.rows[0].id, fx.office],
  )
  L = { kind: 'staff', id: lawyer.rows[0].id as number, firm: fx.firm }
  await addStaffRate(P, { staff: fx.staff, rate: 400, effectiveFrom: '2020-01-01' })

  const m = await createMatter(P, {
    title: 'Reportable matter zephyrqux',
    clientParty: fx.clientParty,
    responsibleLawyer: fx.staff,
    office: fx.office,
    practiceArea: fx.practiceArea,
  })
  matter = m.id
  const te = await createTimeEntry(P, {
    matter,
    workDate: dateStr(1),
    units: 10,
    narrative: 'distinctive narrative quuxword for search',
  })
  const extra = await createTimeEntry(P, {
    matter,
    workDate: dateStr(1),
    units: 5,
    narrative: 'second entry stays unbilled',
  })
  void extra
  const g = await createDraftBillGroup(P, { matter, timeEntries: [te.id] })
  bill = (await issueBillGroup(P, { group: g.group, issueDate: dateStr(40) })).bills[0].id
  await recordMoneyReceipt(P, {
    matter,
    account: fx.account,
    amount: 350,
    method: 'electronic_transfer',
    payerDescription: 'trust deposit',
  })
})

afterAll(async () => {
  await closePool()
  await admin.end()
})

describe('the report engine', () => {
  it('admits by role, scopes by own figures, and refuses outside both', async () => {
    const full = await runReport(P, { key: 'matter_list_financials' })
    expect(full.ownFiguresScope).toBe(false)
    const mine = full.rows.find((r) => r.matter === matter)
    expect(mine).toBeDefined()
    expect(cents(mine!.unbilled)).toBe(20000)
    expect(cents(mine!.outstanding)).toBe(40000)
    expect(cents(mine!.held_available)).toBe(35000)

    // a lawyer runs it scoped to their own matters (none here)
    const scoped = await runReport(L, { key: 'matter_list_financials' })
    expect(scoped.ownFiguresScope).toBe(true)
    expect(scoped.rows.find((r) => r.matter === matter)).toBeUndefined()

    // a report with no own-figures support refuses the lawyer outright
    await expect(runReport(L, { key: 'view_import_batches' })).rejects.toMatchObject({
      code: 'not_visible',
    })
  })

  it('unbilled work aged lists time AND disbursements (the dashboard path — a wrong column here broke a live dashboard once)', async () => {
    const m = await createMatter(P, {
      title: 'Unbilled aged host rept',
      clientParty: fx.clientParty,
      responsibleLawyer: fx.staff,
      office: fx.office,
      practiceArea: fx.practiceArea,
    })
    await createTimeEntry(P, { matter: m.id, workDate: dateStr(5), units: 5, narrative: 'aged report time' })
    await createDisbursement(P, {
      matter: m.id,
      incurredDate: dateStr(45),
      description: 'aged report filing fee',
      amount: 12.5,
      taxTreatment: 'standard',
    })
    const r = await runReport(P, { key: 'unbilled_work_aged' })
    const mine = r.rows.filter((x: Record<string, unknown>) => x.matter === m.id)
    expect(mine.some((x: Record<string, unknown>) => x.kind === 'time')).toBe(true)
    expect(mine.some((x: Record<string, unknown>) => x.kind === 'disbursement')).toBe(true)
    expect(mine.find((x: Record<string, unknown>) => x.kind === 'disbursement')!.age_band).toBe('31-60')
  })

  it('invoicing by lawyer carries the journal position per issued bill (0055)', async () => {
    const r = await runReport(P, {
      key: 'invoicing_by_lawyer',
      filters: { periodStart: dateStr(60), periodEnd: dateStr(0) },
    })
    const mine = r.rows.find((x: Record<string, unknown>) => x.matter === matter)
    expect(mine).toBeDefined()
    expect(cents(mine!.invoiced)).toBe(40000) // 10 units × 6 min × $400/h
    expect(cents(mine!.received)).toBe(0)
    expect(cents(mine!.owing)).toBe(40000)
    expect(String(mine!.lawyer).length).toBeGreaterThan(0)
    expect(cents((r.totals as Record<string, unknown>).invoiced)).toBeGreaterThanOrEqual(40000)
    // own-figures scope: the lawyer sees no other lawyer's bills
    const scoped = await runReport(L, {
      key: 'invoicing_by_lawyer',
      filters: { periodStart: dateStr(60), periodEnd: dateStr(0) },
    })
    expect(scoped.rows.find((x: Record<string, unknown>) => x.matter === matter)).toBeUndefined()
  })

  it('aged receivables bands by due date; tiles aggregate', async () => {
    const aged = await runReport(P, { key: 'aged_receivables' })
    const mine = aged.rows.find((r) => r.matter === matter)
    expect(mine).toBeDefined()
    expect(mine!.age_band).toBe('1-30') // due 26 days ago
    const tile = await runReport(P, { key: 'tile_client_money_available' })
    expect(cents(tile.totals.available)).toBeGreaterThanOrEqual(35000)
    const myTasksBefore = await runReport(P, { key: 'view_my_tasks' })
    await createTask(P, { title: 'Report follow-up rept', matter })
    const myTasks = await runReport(P, { key: 'view_my_tasks' })
    expect(myTasks.rows.length).toBe(myTasksBefore.rows.length + 1)
  })
})

describe('exports, saved reports, targets', () => {
  it('exports machine-clean CSV as a privileged registered artefact', async () => {
    const r = await exportReport(P, { key: 'aged_receivables', format: 'csv' })
    expect(r.rows).toBeGreaterThan(0)
    expect(r.restrictedMatters).toBe(0)
    const artefact = await admin.query(
      `select content_ref, content_type from deedbox.stored_artefact where id = $1`,
      [r.artefact],
    )
    expect(artefact.rows[0].content_type).toBe('text/csv')
    const lines = (artefact.rows[0].content_ref as string).split('\n')
    expect(lines[0]).toBe('bill_number,matter_number,due_date,age_band,outstanding')
    expect(lines.length).toBe(r.rows + 1) // header + data rows, nothing else
    const reg = await admin.query(
      `select privileged, detail from deedbox.register_entry
        where event_kind = 'export.performed' and subject = $1`,
      [r.artefact],
    )
    expect(reg.rows[0].privileged).toBe(true)
    expect(reg.rows[0].detail.after.restricted_matters).toBe(0)
  })

  it('saved reports run for the owner and shared readers only', async () => {
    const s = await saveReport(P, {
      key: 'aged_receivables',
      name: 'My ageing rept',
      filters: { practiceArea: fx.practiceArea },
    })
    const run = await runSavedReport(P, { savedReport: s.id })
    expect(run.rows.find((r) => r.matter === matter)).toBeDefined()
    await expect(runSavedReport(L, { savedReport: s.id })).rejects.toMatchObject({
      code: 'not_shared',
    })
  })

  it('targets replace whole with the full before/after registered; others need the firm right', async () => {
    await expect(
      replaceTargets(P, {
        subjectKind: 'staff',
        subject: fx.staff,
        targets: [
          { metric: 'amount_billed', amount: 10000, periodKind: 'custom', periodStart: dateStr(30) },
        ],
      }),
    ).rejects.toMatchObject({ code: 'bad_period' })
    await replaceTargets(P, {
      subjectKind: 'staff',
      subject: fx.staff,
      targets: [
        { metric: 'amount_billed', amount: 10000, periodKind: 'month', periodStart: dateStr(30) },
        { metric: 'amount_collected', amount: 8000, periodKind: 'month', periodStart: dateStr(30) },
      ],
    })
    const own = await listTargets(P, { subjectKind: 'staff', subject: fx.staff })
    expect(own.targets.length).toBe(2)
    await expect(
      listTargets(L, { subjectKind: 'staff', subject: fx.staff }),
    ).rejects.toMatchObject({ code: 'not_visible' })
  })
})

describe('schedules', () => {
  it('runs per recipient under their own predicate; skips the inadmissible; reschedules', async () => {
    await expect(
      createReportSchedule(L, {
        reportKind: 'standard',
        report: 'aged_receivables',
        period: { every: 'week' },
        format: 'csv',
        recipients: [{ staff: fx.staff }],
      }),
    ).rejects.toMatchObject({ code: 'capability_missing' })

    const s = await createReportSchedule(P, {
      reportKind: 'standard',
      report: 'refusal_register', // admin/accounts only, no own-figures: the lawyer must skip
      period: { every: 'week' },
      format: 'csv',
      recipients: [{ staff: fx.staff }, { staff: L.id }],
    })
    const outcomes = await runDueSchedules(P)
    const mine = outcomes.find((o) => o.schedule === s.id)
    expect(mine).toBeDefined()
    expect(mine!.sent).toEqual([fx.staff])
    expect(mine!.skipped.length).toBe(1)
    expect(mine!.skipped[0].staff).toBe(L.id)

    const row = await admin.query(
      `select last_run_at, next_run_at from deedbox.report_schedule where id = $1`,
      [s.id],
    )
    expect(row.rows[0].last_run_at).not.toBeNull()
    expect(new Date(row.rows[0].next_run_at as string).getTime()).toBeGreaterThan(Date.now())
    const outbound = await admin.query(
      `select count(*)::int as n from deedbox.outbound_message
        where purpose = 'scheduled_report' and related = $1`,
      [s.id],
    )
    expect(outbound.rows[0].n).toBe(1)

    await setSchedulePaused(P, { schedule: s.id, paused: true, reason: 'season over' })
    const paused = await admin.query(
      `select active, paused_reason from deedbox.report_schedule where id = $1`,
      [s.id],
    )
    expect(paused.rows[0].active).toBe(false)
  })
})

describe('search and experience, the cache', () => {
  it('the index serves suggestions and search under the predicate', async () => {
    const sug = await suggest(P, { query: 'zephyrqux' })
    expect(sug.hits.find((h) => h.entryType === 'matter' && h.matter === matter)).toBeDefined()
    const hits = await search(P, { query: 'quuxword' })
    expect(hits.hits.length).toBeGreaterThan(0)
    expect(hits.hits[0].snippet).toContain('quuxword')
  })

  it('recents upsert and trim; pins cap at the schema', async () => {
    await recordView(P, { itemType: 'matter', item: matter })
    await recordView(P, { itemType: 'matter', item: matter })
    const recents = await admin.query(
      `select count(*)::int as n from deedbox.recent_item
        where staff = $1 and item_type = 'matter' and item = $2`,
      [fx.staff, matter],
    )
    expect(recents.rows[0].n).toBe(1)
    await pinItem(P, { itemType: 'matter', item: matter })
    const pins = await admin.query(
      `select count(*)::int as n from deedbox.pinned_item where staff = $1`,
      [fx.staff],
    )
    expect(pins.rows[0].n).toBe(1)
    await unpinItem(P, { itemType: 'matter', item: matter })
  })

  it('the cache recomputes to the truth and the verifier heals corruption', async () => {
    await recomputePositionCache(P)
    const cached = await admin.query(
      `select unbilled_value, outstanding_value, held_available
         from deedbox.matter_position_cache where matter = $1`,
      [matter],
    )
    expect(cents(cached.rows[0].unbilled_value)).toBe(20000)
    expect(cents(cached.rows[0].outstanding_value)).toBe(40000)
    expect(cents(cached.rows[0].held_available)).toBe(35000)

    await admin.query(
      `update deedbox.matter_position_cache set outstanding_value = 999.99 where matter = $1`,
      [matter],
    )
    const verified = await verifyPositionCache(P, { sample: 1000 })
    expect(verified.diverged).toContain(matter)
    const healed = await admin.query(
      `select outstanding_value from deedbox.matter_position_cache where matter = $1`,
      [matter],
    )
    expect(cents(healed.rows[0].outstanding_value)).toBe(40000)
  })
})
