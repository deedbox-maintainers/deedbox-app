import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import type { Pool } from 'pg'
import { closePool, withPrincipal } from '@/lib/db'
import type { Principal } from '@/lib/db'
import { createMatter, changeRestriction } from '@/lib/ops/matters'
import {
  addStaffRate,
  addStaffCostRate,
  addMatterRateOverride,
  createTimeEntry,
  editTimeEntry,
  writeOffUnbilledItem,
  softDeleteUnbilledItem,
  restoreUnbilledItem,
  startTimer,
  pauseTimer,
  resumeTimer,
  stopTimer,
  ingestSignal,
  assignSuggestionMatter,
  acceptSuggestion,
  discardSuggestion,
  createDisbursement,
  createCostType,
  deactivateCostType,
  reviseEstimate,
  setBudget,
  setFundsPolicy,
  replacePayerSet,
  evaluateThresholds,
} from '@/lib/ops/billing'
import { makeAdminPool, buildFixture, type Fixture } from './helpers'

let admin: Pool
let fx: Fixture
let P: Principal
let JOB: Principal
let lawyer: number
let L: Principal

beforeAll(async () => {
  admin = makeAdminPool()
  fx = await buildFixture(admin, 'bil')
  P = { kind: 'staff', id: fx.staff, firm: fx.firm }
  JOB = { kind: 'system_job', id: 1, firm: fx.firm }
  const lawyerRole = await admin.query(`select id from deedbox.role where system_key = 'lawyer'`)
  const l = await admin.query(
    `insert into deedbox.staff_member (person_name, login, role, office, email)
     values ('{"given":"Lena","family":"Lawyer"}', 'lena.bil', $1, $2, 'lena.bil@example.test')
     returning id`,
    [lawyerRole.rows[0].id, fx.office],
  )
  lawyer = l.rows[0].id
  L = { kind: 'staff', id: lawyer, firm: fx.firm }
  await addStaffRate(P, { staff: fx.staff, rate: 400, effectiveFrom: '2020-01-01' })
  await addStaffRate(P, { staff: lawyer, rate: 300, effectiveFrom: '2020-01-01' })
})

afterAll(async () => {
  await closePool()
  await admin.end()
})

describe('pricing', () => {
  it('cost rates are privileged and invisible without see_cost_rates', async () => {
    await addStaffCostRate(P, { staff: fx.staff, rate: 150, effectiveFrom: '2020-01-01' })
    const priv = await admin.query(
      `select count(*)::int as n from deedbox.register_entry
        where event_kind = 'record.created' and subject_type = 'staff_cost_rate' and privileged`,
    )
    expect(priv.rows[0].n).toBeGreaterThanOrEqual(1)
    const asLawyer = await withPrincipal(
      L,
      async (tx) => {
        const r = await tx.query(`select count(*)::int as n from deedbox.staff_cost_rate`)
        return r.rows[0].n as number
      },
      { readOnly: true },
    )
    expect(asLawyer).toBe(0) // row security: no see_cost_rates, no rows
    const asAdmin = await withPrincipal(
      P,
      async (tx) => {
        const r = await tx.query(`select count(*)::int as n from deedbox.staff_cost_rate`)
        return r.rows[0].n as number
      },
      { readOnly: true },
    )
    expect(asAdmin).toBeGreaterThanOrEqual(1)
  })

  it('a matter override beats the staff rate when entries resolve', async () => {
    await addMatterRateOverride(P, {
      matter: fx.matter,
      rate: 500,
      effectiveFrom: '2020-01-01',
    })
    const e = await createTimeEntry(P, {
      matter: fx.matter,
      workDate: '2026-08-13',
      units: 10,
      narrative: 'override-rate work',
    })
    // 10 units × 6 min × $500/hr ÷ 60 = $500.00
    expect(e.value).toBe(500)
    const row = await admin.query(
      `select rate_source, applied_rate from deedbox.time_entry where id = $1`,
      [e.id],
    )
    expect(row.rows[0].rate_source).toBe('matter_override')
    expect(Number(row.rows[0].applied_rate)).toBe(500)
  })
})

describe('time capture', () => {
  let workMatter: number

  beforeAll(async () => {
    const m = await createMatter(P, {
      title: 'Billing capture matter',
      clientParty: fx.clientParty,
      responsibleLawyer: fx.staff,
      office: fx.office,
      practiceArea: fx.practiceArea,
    })
    workMatter = m.id
  })

  it('computes value by the formula and registers the entry', async () => {
    const e = await createTimeEntry(L, {
      matter: workMatter,
      workDate: '2026-08-13',
      units: 7,
      narrative: 'reviewed disclosure bundle',
    })
    // 7 × 6 × 300 / 60 = 210.00
    expect(e.value).toBe(210)
    const reg = await admin.query(
      `select count(*)::int as n from deedbox.register_entry
        where event_kind = 'record.created' and subject_type = 'time_entry' and subject = $1`,
      [e.id],
    )
    expect(reg.rows[0].n).toBe(1)
  })

  it('refuses without a resolvable rate, closed matters, and zero units', async () => {
    const rateless = await admin.query(
      `insert into deedbox.staff_member (person_name, login, role, office, email)
       select '{"given":"Nora"}', 'nora.bil', role, office, 'nora.bil@example.test'
         from deedbox.staff_member where id = $1 returning id`,
      [lawyer],
    )
    // recorded by the administrator, who holds time.record_for_others (0053)
    // — so the refusal reached is the RATE one, the thing under test
    await expect(
      createTimeEntry(P, {
        matter: workMatter,
        staff: rateless.rows[0].id,
        workDate: '2026-08-13',
        units: 5,
        narrative: 'no rate exists',
      }),
    ).rejects.toMatchObject({ code: 'no_rate' })
    await expect(
      createTimeEntry(L, {
        matter: workMatter,
        workDate: '2026-08-13',
        units: 0,
        narrative: 'zero units',
      }),
    ).rejects.toMatchObject({ code: 'units_required' })

    const closable = await createMatter(P, {
      title: 'Closed capture matter',
      clientParty: fx.clientParty,
      responsibleLawyer: fx.staff,
      office: fx.office,
      practiceArea: fx.practiceArea,
    })
    await admin.query(
      `do $$ begin
         insert into deedbox.matter_close_request
           (matter, requested_by, financial_position, condition_evaluation, state, decided_by, decided_at)
         values (${closable.id}, ${fx.staff}, '{}', '{}', 'approved', ${fx.staff}, now());
         update deedbox.matter set status = 'closed' where id = ${closable.id};
       end $$`,
    )
    await expect(
      createTimeEntry(L, {
        matter: closable.id,
        workDate: '2026-08-13',
        units: 3,
        narrative: 'work on closed matter',
      }),
    ).rejects.toMatchObject({ code: 'matter_closed' })
  })

  it('a manual entry supersedes the overlapping pending suggestion', async () => {
    const sig = await ingestSignal(JOB, {
      sourceModule: 'email',
      signalKind: 'email_sent',
      sourceRef: 'msg-supersede-1',
      occurredAt: '2026-08-12T03:00:00Z',
      staff: lawyer,
      matterHint: workMatter,
      durationMinutes: 12,
    })
    expect(sig.suggestion).not.toBeNull()
    await createTimeEntry(L, {
      matter: workMatter,
      workDate: '2026-08-12',
      units: 2,
      narrative: 'the manual record of that email work',
    })
    const s = await admin.query(`select state from deedbox.suggested_entry where id = $1`, [
      sig.suggestion,
    ])
    expect(s.rows[0].state).toBe('superseded_by_manual')
  })

  it('locks value fields after write-off; narrative stays writable until then', async () => {
    const e = await createTimeEntry(L, {
      matter: workMatter,
      workDate: '2026-08-13',
      units: 4,
      narrative: 'to be written off',
    })
    await editTimeEntry(L, { entry: e.id, units: 6 })
    const v = await admin.query(`select value from deedbox.time_entry where id = $1`, [e.id])
    expect(Number(v.rows[0].value)).toBe(180) // 6 × 6 × 300/60

    await expect(
      writeOffUnbilledItem(L, { itemType: 'time_entry', item: e.id, reason: '' }),
    ).rejects.toMatchObject({ code: 'reason_required' })
    await writeOffUnbilledItem(L, { itemType: 'time_entry', item: e.id, reason: 'goodwill' })
    await expect(editTimeEntry(L, { entry: e.id, units: 8 })).rejects.toMatchObject({
      code: 'value_locked',
    })
  })

  it('soft-deletes and restores an unbilled entry', async () => {
    const e = await createTimeEntry(L, {
      matter: workMatter,
      workDate: '2026-08-13',
      units: 1,
      narrative: 'deletable',
    })
    await softDeleteUnbilledItem(L, { itemType: 'time_entry', item: e.id })
    await restoreUnbilledItem(L, { itemType: 'time_entry', item: e.id })
    const row = await admin.query(`select deleted_at from deedbox.time_entry where id = $1`, [e.id])
    expect(row.rows[0].deleted_at).toBeNull()
  })

  it('timer: start, pause, resume, stop — minimum one unit, timer gone', async () => {
    const t = await startTimer(L, { matter: workMatter, narrativeDraft: 'timer test work' })
    await pauseTimer(L, { timer: t.id })
    await resumeTimer(L, { timer: t.id })
    const r = await stopTimer(L, { timer: t.id })
    expect(r.value).toBe(30) // 1 unit × 6 min × 300/60
    const gone = await admin.query(`select count(*)::int as n from deedbox.timer where id = $1`, [
      t.id,
    ])
    expect(gone.rows[0].n).toBe(0)
    const entry = await admin.query(
      `select origin, units from deedbox.time_entry where id = $1`,
      [r.entry],
    )
    expect(entry.rows[0].origin).toBe('timer')
    expect(entry.rows[0].units).toBe(1)
  })
})

describe('recording time for another fee earner (0053)', () => {
  let hostMatter: number

  beforeAll(async () => {
    const m = await createMatter(P, {
      title: 'Record-for host',
      clientParty: fx.clientParty,
      responsibleLawyer: fx.staff,
      office: fx.office,
      practiceArea: fx.practiceArea,
    })
    hostMatter = m.id
  })

  it('without the capability the operation refuses; own time stays free', async () => {
    await expect(
      createTimeEntry(L, {
        matter: hostMatter,
        staff: fx.staff,
        workDate: '2026-01-10',
        units: 2,
        narrative: 'not mine to record',
      }),
    ).rejects.toMatchObject({ code: 'not_permitted' })
    const own = await createTimeEntry(L, {
      matter: hostMatter,
      workDate: '2026-01-10',
      units: 1,
      narrative: 'my own work, no gate',
    })
    expect(own.id).toBeGreaterThan(0)
  })

  it('a holder records for another; the entry belongs to the target at the target\'s own rate', async () => {
    const e = await createTimeEntry(P, {
      matter: hostMatter,
      staff: lawyer,
      workDate: '2026-01-10',
      units: 2,
      narrative: 'entered by the practice manager',
    })
    const row = await admin.query(
      `select staff, applied_rate, value, rate_source from deedbox.time_entry where id = $1`,
      [e.id],
    )
    expect(row.rows[0].staff).toBe(lawyer)
    expect(Math.round(Number(row.rows[0].applied_rate) * 100)).toBe(30000)
    expect(Math.round(Number(row.rows[0].value) * 100)).toBe(6000) // 2 × 6 min × 300/h
    expect(row.rows[0].rate_source).toBe('staff_rate')
  })

  it('an unknown or inactive target refuses honestly', async () => {
    await expect(
      createTimeEntry(P, {
        matter: hostMatter,
        staff: 999999,
        workDate: '2026-01-10',
        units: 1,
        narrative: 'ghost target',
      }),
    ).rejects.toMatchObject({ code: 'not_found' })
  })
})

describe('signals and suggestions', () => {
  let hiddenMatter: number

  beforeAll(async () => {
    const m = await createMatter(P, {
      title: 'Hidden from the lawyer',
      clientParty: fx.clientParty,
      responsibleLawyer: fx.staff,
      office: fx.office,
      practiceArea: fx.practiceArea,
    })
    hiddenMatter = m.id
    await changeRestriction(P, {
      matter: hiddenMatter,
      change: { action: 'add_grant', granteeKind: 'staff', grantee: fx.staff },
      reason: 'sensitive billing test',
    })
  })

  it('replays are no-ops; a hint outside the staff predicate holds unmatched', async () => {
    const again = await ingestSignal(JOB, {
      sourceModule: 'email',
      signalKind: 'email_sent',
      sourceRef: 'msg-supersede-1',
      occurredAt: '2026-08-12T03:00:00Z',
      staff: lawyer,
    })
    expect(again.signal).toBeNull()

    const held = await ingestSignal(JOB, {
      sourceModule: 'documents',
      signalKind: 'document_worked',
      sourceRef: 'doc-held-1',
      occurredAt: '2026-08-13T01:00:00Z',
      staff: lawyer,
      matterHint: hiddenMatter, // the lawyer cannot see it
      durationMinutes: 30,
    })
    const s = await admin.query(
      `select state, matter from deedbox.suggested_entry where id = $1`,
      [held.suggestion],
    )
    expect(s.rows[0].state).toBe('held_unmatched')
    expect(s.rows[0].matter).toBeNull()

    // held ones cannot discard (a discarded row carries its matter)
    await expect(discardSuggestion(L, { suggestion: held.suggestion! })).rejects.toMatchObject({
      code: 'not_pending',
    })
    // assignment demands the suggestion's staff can see the target
    await expect(
      assignSuggestionMatter(P, { suggestion: held.suggestion!, matter: hiddenMatter }),
    ).rejects.toMatchObject({ code: 'staff_cannot_see' })
    await assignSuggestionMatter(P, { suggestion: held.suggestion!, matter: fx.matter })
    const after = await admin.query(
      `select state, matter from deedbox.suggested_entry where id = $1`,
      [held.suggestion],
    )
    expect(after.rows[0].state).toBe('pending')
    expect(after.rows[0].matter).toBe(fx.matter)
  })

  it('acceptance is the only exit that creates an entry', async () => {
    const sig = await ingestSignal(JOB, {
      sourceModule: 'calendar',
      signalKind: 'appointment_held',
      sourceRef: 'appt-1',
      occurredAt: '2026-08-13T02:00:00Z',
      staff: lawyer,
      matterHint: fx.matter,
      durationMinutes: 30,
    })
    const r = await acceptSuggestion(L, { suggestion: sig.suggestion! })
    const entry = await admin.query(
      `select origin, suggestion, units from deedbox.time_entry where id = $1`,
      [r.entry],
    )
    expect(entry.rows[0].origin).toBe('suggestion')
    expect(entry.rows[0].suggestion).toBe(sig.suggestion)
    expect(entry.rows[0].units).toBe(5) // 30 min / 6-min units
    const s = await admin.query(
      `select state, resulting_entry from deedbox.suggested_entry where id = $1`,
      [sig.suggestion],
    )
    expect(s.rows[0].state).toBe('accepted')
    expect(s.rows[0].resulting_entry).toBe(r.entry)
  })
})

describe('disbursements and cost types', () => {
  it('defaults flow from the cost type; deactivation preserves pointers', async () => {
    const ct = await createCostType(P, {
      name: 'Court filing bil',
      defaultAmount: 120.5,
      defaultTaxTreatment: 'standard',
    })
    const d = await createDisbursement(L, {
      matter: fx.matter,
      incurredDate: '2026-08-13',
      costType: ct.id,
    })
    const row = await admin.query(
      `select description, amount, tax_treatment from deedbox.disbursement where id = $1`,
      [d.id],
    )
    expect(row.rows[0].description).toBe('Court filing bil')
    expect(Number(row.rows[0].amount)).toBe(120.5)
    await deactivateCostType(P, { costType: ct.id })
    const still = await admin.query(`select cost_type from deedbox.disbursement where id = $1`, [
      d.id,
    ])
    expect(still.rows[0].cost_type).toBe(ct.id)
  })
})

describe('estimates, budgets, funds policy, payers', () => {
  let estMatter: number

  beforeAll(async () => {
    const m = await createMatter(P, {
      title: 'Estimate matter bil',
      clientParty: fx.clientParty,
      responsibleLawyer: fx.staff,
      office: fx.office,
      practiceArea: fx.practiceArea,
    })
    estMatter = m.id
  })

  it('creation is revision 1 (arming keeps); revising applies and re-arms', async () => {
    const r1 = await reviseEstimate(P, { matter: estMatter, amount: 1000, reason: 'initial' })
    expect(r1.revision).toBe(1)
    let est = await admin.query(
      `select current_amount, arming_version from deedbox.cost_estimate where id = $1`,
      [r1.estimate],
    )
    expect(Number(est.rows[0].current_amount)).toBe(1000)
    expect(est.rows[0].arming_version).toBe(1)

    const r2 = await reviseEstimate(P, {
      matter: estMatter,
      amount: 2000,
      reason: 'scope grew after directions',
    })
    expect(r2.revision).toBe(2)
    est = await admin.query(
      `select current_amount, arming_version from deedbox.cost_estimate where id = $1`,
      [r1.estimate],
    )
    expect(Number(est.rows[0].current_amount)).toBe(2000)
    expect(est.rows[0].arming_version).toBe(2)

    await expect(
      reviseEstimate(P, { matter: estMatter, amount: 3000, reason: '   ' }),
    ).rejects.toMatchObject({ code: 'reason_required' })
  })

  it('budgets supersede-never-edit with the responsible lawyer always included', async () => {
    const b1 = await setBudget(P, { matter: estMatter, amount: 5000, recipients: [lawyer] })
    const b2 = await setBudget(P, { matter: estMatter, amount: 8000 })
    const rows = await admin.query(
      `select id, active, recipients from deedbox.budget where matter = $1 order by id`,
      [estMatter],
    )
    expect(rows.rowCount).toBe(2)
    expect(rows.rows[0].id).toBe(b1.id)
    expect(rows.rows[0].active).toBe(false)
    expect(rows.rows[1].id).toBe(b2.id)
    expect(rows.rows[1].active).toBe(true)
    expect(rows.rows[1].recipients).toContain(fx.staff) // injected responsible
  })

  it('the funds policy guards target ≥ minimum and updates in place', async () => {
    await expect(
      setFundsPolicy(P, { matter: estMatter, minimumThreshold: 1000, targetAmount: 500 }),
    ).rejects.toMatchObject({ code: 'target_below_minimum' })
    await setFundsPolicy(P, { matter: estMatter, minimumThreshold: 500, targetAmount: 2000 })
    await setFundsPolicy(P, { matter: estMatter, minimumThreshold: 800, targetAmount: 2500 })
    const rows = await admin.query(
      `select count(*)::int as n, max(minimum_threshold) as m from deedbox.matter_funds_policy where matter = $1`,
      [estMatter],
    )
    expect(rows.rows[0].n).toBe(1)
    expect(Number(rows.rows[0].m)).toBe(800)
  })

  it('the payer set replaces whole, sums to 100, and names the bad sum', async () => {
    const second = await admin.query(
      `insert into deedbox.party (kind, display_name) values ('organisation', 'Payer Org bil') returning id`,
    )
    await admin.query(
      `insert into deedbox.party_name (party, name_kind, full_name) values ($1, 'current', 'Payer Org bil')`,
      [second.rows[0].id],
    )
    await expect(
      replacePayerSet(P, {
        matter: estMatter,
        payers: [
          { party: fx.clientParty, sharePct: 60 },
          { party: second.rows[0].id, sharePct: 30 },
        ],
      }),
    ).rejects.toMatchObject({ code: 'shares_must_sum_100' })
    await replacePayerSet(P, {
      matter: estMatter,
      payers: [
        { party: fx.clientParty, sharePct: 60 },
        { party: second.rows[0].id, sharePct: 40 },
      ],
    })
    await replacePayerSet(P, {
      matter: estMatter,
      payers: [{ party: fx.clientParty, sharePct: 100 }],
    })
    const active = await admin.query(
      `select count(*)::int as n from deedbox.matter_payer where matter = $1 and active`,
      [estMatter],
    )
    expect(active.rows[0].n).toBe(1)
  })
})

describe('threshold evaluation', () => {
  let tMatter: number

  beforeAll(async () => {
    const m = await createMatter(P, {
      title: 'Threshold matter bil',
      clientParty: fx.clientParty,
      responsibleLawyer: fx.staff,
      office: fx.office,
      practiceArea: fx.practiceArea,
    })
    tMatter = m.id
    await reviseEstimate(P, { matter: tMatter, amount: 1000, reason: 'initial' })
    // consumption 600 = 60% — crosses the 50 threshold, not 80
    await createTimeEntry(P, {
      matter: tMatter,
      workDate: '2026-08-13',
      units: 12, // 12 × 6 × 500?? — staff rate 400: 12 × 6 × 400 / 60 = 480
      narrative: 'threshold work one',
    })
    await createTimeEntry(P, {
      matter: tMatter,
      workDate: '2026-08-13',
      units: 3, // 3 × 6 × 400 / 60 = 120 → total 600
      narrative: 'threshold work two',
    })
  })

  it('fires each crossed threshold exactly once per arming, with messages queued', async () => {
    const r1 = await evaluateThresholds(JOB, { matter: tMatter })
    expect(r1.fired.map((f) => f.pct)).toEqual([50])
    const r2 = await evaluateThresholds(JOB, { matter: tMatter })
    expect(r2.fired.length).toBe(0) // exactly-once

    const msg = await admin.query(
      `select count(*)::int as n from deedbox.outbound_message where purpose = 'threshold_alert'`,
    )
    expect(msg.rows[0].n).toBeGreaterThanOrEqual(1)
  })

  it('revising the estimate re-arms; the alert fires again for the new arming', async () => {
    await reviseEstimate(P, { matter: tMatter, amount: 1100, reason: 'small adjustment' })
    const r = await evaluateThresholds(JOB, { matter: tMatter })
    expect(r.fired.map((f) => f.pct)).toEqual([50]) // 600/1100 = 54.5% — 50 again, new arming
    const alerts = await admin.query(
      `select count(*)::int as n from deedbox.threshold_alert where subject_type = 'estimate'`,
    )
    expect(alerts.rows[0].n).toBe(2)
  })

  it('budget spend counts every category and fires on its own thresholds', async () => {
    await setBudget(P, { matter: tMatter, amount: 700 })
    const r = await evaluateThresholds(JOB, { matter: tMatter })
    // spend 600 of 700 = 85.7% → 50 and 80 both fire for the budget
    const pcts = r.fired.filter((f) => f.subjectType === 'budget').map((f) => f.pct).sort((a, b) => a - b)
    expect(pcts).toEqual([50, 80])
  })
})
