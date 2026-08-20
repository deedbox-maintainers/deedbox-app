// Matters/parties screens: the predicate-governed reads behind the
// seventeen screen surfaces, the security domain's compute_delta service,
// restricted-view recording on screen surfaces, and the intake-stage
// administration this slice built (first consumer).
//
// Cross-suite contracts (this file sorts after jobs.*, BEFORE matters.*):
//   * matter.close_requires_approval is flipped ON at minutesAgo=120 and
//     restored OFF at minutesAgo=90 — both OLDER than matters.test.ts's own
//     60/30 flips, so that suite's rows always outrank these.
//   * Intake stages created here are tag-named (xscr…) and left at positions
//     1..n; matters.test.ts inserts its own stages at positions 91/92.
//   * All fixture rows are tag-named (xscr); assertions filter by own ids.

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import type { Pool } from 'pg'
import { closePool } from '@/lib/db'
import type { Principal } from '@/lib/db'
import {
  createParty,
  createMatter,
  closeMatter,
  approveCloseRequest,
  holdMatter,
  resumeMatter,
  addMatterParty,
  changeRestriction,
  changeStaffing,
  createNote,
  linkParties,
  createIntake,
  addIntakeParty,
  setIntakeOutcome,
  closeIntake,
  runConflictCheck,
  attachConflictCheck,
  recordConflictResolution,
  createPracticeArea,
  setRelatablePair,
  createIntakeStage,
  renameIntakeStage,
  setIntakeStageActive,
  reorderIntakeStages,
} from '@/lib/ops/matters'
import { computeRestrictionDelta } from '@/lib/ops/security'
import { reviewDuplicateDecision } from '@/lib/ops/interface'
import { dryRunBulk, commitBulk, reverseBulk } from '@/lib/ops/bulk'
import {
  partyList,
  partyProfile,
  duplicateReviewQueue,
  matterList,
  matterFilterOptions,
  matterHub,
  closeScreen,
  closeApprovalQueue,
  restrictionPanel,
  staffingPanel,
  bulkRunReport,
  intakeBoard,
  intakeTiles,
  intakeRecord,
  conflictRegister,
  conflictCheckDetail,
  practiceAreasAdmin,
  mattersViewerFlags,
} from '@/lib/reads/matters'
import { makeAdminPool, buildFixture, addStaff, setFirmSetting, type Fixture } from './helpers'

let admin: Pool
let fx: Fixture
let P: Principal // fixture administrator (Pat)
let sam: number
let S: Principal // second administrator (Sam)

async function registerCount(kind: string, matter: number, surface: string): Promise<number> {
  const r = await admin.query(
    `select count(*)::int as n from deedbox.register_entry
      where event_kind = $1 and matter = $2 and detail ->> 'surface' = $3`,
    [kind, matter, surface],
  )
  return r.rows[0].n as number
}

beforeAll(async () => {
  admin = makeAdminPool()
  fx = await buildFixture(admin, 'xscr')
  P = { kind: 'staff', id: fx.staff, firm: fx.firm }
  sam = await addStaff(admin, fx, 'sam.xscr')
  S = { kind: 'staff', id: sam, firm: fx.firm }
})

afterAll(async () => {
  await closePool()
  await admin.end()
})

describe('party surfaces', () => {
  let partyId: number

  it('party list searches match keys; merged parties are absent', async () => {
    const made = await createParty(P, {
      kind: 'person',
      fullName: 'Zebedee Quirkafleeg xscr',
      phones: [{ value: '0400 111 222', primary: true }],
      emails: [{ value: 'zeb.xscr@example.test', primary: true }],
    })
    partyId = made.id

    const byName = await partyList(P, { q: 'Quirkafleeg' })
    expect(byName.some((r) => r.id === partyId)).toBe(true)
    const byPhone = await partyList(P, { q: '0400111222' })
    expect(byPhone.some((r) => r.id === partyId)).toBe(true)

    // a merged party never appears in the picker
    const dup = await createParty(P, { kind: 'person', fullName: 'Zebedee Quirkafleeg Dup xscr' })
    await admin.query(`update deedbox.party set state = 'merged', merged_into = $2 where id = $1`, [
      dup.id,
      partyId,
    ])
    const after = await partyList(P, { q: 'Quirkafleeg' })
    expect(after.some((r) => r.id === dup.id)).toBe(false)
  })

  it('party profile carries names, contacts, links, visible matters and notes', async () => {
    await linkParties(P, {
      fromParty: partyId,
      toParty: fx.clientParty,
      linkKind: (
        await admin.query(
          `select ci.id from deedbox.choice_item ci join deedbox.choice_list cl on cl.id = ci.list
            where cl.purpose_key = 'party_link_kinds' and ci.active order by ci.position limit 1`,
        )
      ).rows[0].id,
    })
    await createNote(P, { ownerType: 'party', owner: partyId, body: 'a profile note xscr' })

    const profile = await partyProfile(P, partyId)
    expect(profile.party.displayName).toBe('Zebedee Quirkafleeg xscr')
    expect(profile.names.some((n) => n.kind === 'current')).toBe(true)
    expect(profile.contacts.some((c) => c.kind === 'phone' && c.isPrimary)).toBe(true)
    expect(profile.links.length).toBe(1)
    expect(profile.links[0].otherParty).toBe(fx.clientParty)
    expect(profile.notes.some((n) => n.body === 'a profile note xscr')).toBe(true)

    // the fixture client's profile lists the fixture matter with the client capacity
    const clientProfile = await partyProfile(P, fx.clientParty)
    expect(clientProfile.matters.some((m) => m.id === fx.matter)).toBe(true)
  })

  it('duplicate review queue: deferred rows appear, test rows never, reviewed rows leave', async () => {
    const seeded = await admin.query(
      `insert into deedbox.duplicate_decision
         (created_entity_type, created_entity, candidates_shown, decision_mode, test,
          decided_by_kind, decided_by)
       values ('party', $1, '[]'::jsonb, 'integration_deferred', false, 'staff', $2),
              ('party', $1, '[]'::jsonb, 'integration_deferred', true,  'staff', $2)
       returning id, test`,
      [partyId, fx.staff],
    )
    const realRow = seeded.rows.find((r) => r.test === false)!.id as number
    const testRow = seeded.rows.find((r) => r.test === true)!.id as number

    const queue = await duplicateReviewQueue(P)
    expect(queue.some((q) => q.id === realRow)).toBe(true)
    expect(queue.some((q) => q.id === testRow)).toBe(false)

    await reviewDuplicateDecision(P, { decision: realRow })
    const after = await duplicateReviewQueue(P)
    expect(after.some((q) => q.id === realRow)).toBe(false)
  })
})

describe('matter surfaces', () => {
  let m2: number // becomes restricted
  let portalParty: number

  it('matter list filters and carries cache financials; options read works', async () => {
    const cached = await matterList(P, { q: 'xscr' })
    expect(cached.some((r) => r.id === fx.matter)).toBe(true)
    expect(cached.find((r) => r.id === fx.matter)!.unbilled).toBeNull() // no cache row yet

    await admin.query(
      `insert into deedbox.matter_position_cache
         (matter, unbilled_value, outstanding_value, held_available, as_at_register_seq)
       values ($1, 123.45, 67.80, 0, 0)`,
      [fx.matter],
    )
    const withCache = await matterList(P, { q: 'xscr' })
    const row = withCache.find((r) => r.id === fx.matter)!
    expect(row.unbilled).toBe(123.45)
    expect(row.outstanding).toBe(67.8)

    const byStatus = await matterList(P, { q: 'xscr', status: 'closed' })
    expect(byStatus.some((r) => r.id === fx.matter)).toBe(false)

    const options = await matterFilterOptions(P)
    expect(options.offices.length).toBeGreaterThan(0)
    expect(options.capacities.length).toBeGreaterThan(0)

    const flags = await mattersViewerFlags(P)
    expect(flags.close).toBe(true)
    expect(flags.restriction).toBe(true)
  })

  it('the hub carries header, cache position, parties, timeline; status moves land on it', async () => {
    await holdMatter(P, { matter: fx.matter })
    await resumeMatter(P, { matter: fx.matter })
    await createNote(P, { ownerType: 'matter', owner: fx.matter, body: 'hub note xscr' })

    const hub = await matterHub(P, fx.matter)
    expect(hub.matter.matterNumber).toBe('T-xscr-000001')
    expect(hub.position!.unbilled).toBe(123.45)
    expect(hub.parties.some((mp) => mp.party === fx.clientParty)).toBe(true) // the automatic client row
    expect(hub.notes.some((n) => n.body === 'hub note xscr')).toBe(true)
    const statusEvents = hub.timeline.filter((t) => t.eventKind === 'matter.status_changed')
    expect(statusEvents.length).toBeGreaterThanOrEqual(2) // hold + resume
    expect(hub.pendingCloseRequest).toBeNull()
  })

  it('restriction: delta service, panel, predicate absence, and recorded disclosures', async () => {
    const made = await createMatter(P, {
      title: 'Restricted matter xscr',
      clientParty: fx.clientParty,
      responsibleLawyer: fx.staff,
      office: fx.office,
      practiceArea: fx.practiceArea,
    })
    m2 = made.id

    // a portal party rides the delta when the restricted flag flips
    const pp = await createParty(P, { kind: 'person', fullName: 'Portal Person xscr' })
    portalParty = pp.id
    await admin.query(`update deedbox.party set portal_login = 'portal.xscr' where id = $1`, [portalParty])
    const capacity = (
      await admin.query(
        `select ci.id from deedbox.choice_item ci join deedbox.choice_list cl on cl.id = ci.list
          where cl.purpose_key = 'matter_party_capacities' and ci.active
            and coalesce(ci.shipped_key, '') <> 'client' order by ci.position limit 1`,
      )
    ).rows[0].id
    const mp = await addMatterParty(P, { matter: m2, party: portalParty, capacity })
    await admin.query(`update deedbox.matter_party set portal_access = true where id = $1`, [mp.id])

    // delta BEFORE any grant: adding the first grant restricts the matter —
    // Sam loses sight, the grantee keeps it, the portal party loses it too
    const delta = await computeRestrictionDelta(P, {
      matter: m2,
      change: { action: 'add_grant', granteeKind: 'staff', grantee: fx.staff },
    })
    expect(delta.restrictedNow).toBe(false)
    expect(delta.restrictedAfter).toBe(true)
    expect(delta.seesAfter).toBe(1)
    expect(delta.gains.length).toBe(0)
    expect(delta.loses.some((l) => l.staff === sam)).toBe(true)
    expect(delta.loses.some((l) => l.staff === fx.staff)).toBe(false)
    expect(delta.portalLoses.some((x) => x.party === portalParty)).toBe(true)

    // a block delta on the unrestricted matter names exactly that person
    const blockDelta = await computeRestrictionDelta(P, {
      matter: m2,
      change: { action: 'add_block', staff: sam },
    })
    expect(blockDelta.restrictedAfter).toBe(false)
    expect(blockDelta.loses.map((l) => l.staff)).toEqual([sam])
    expect(blockDelta.gains.length).toBe(0)

    // commit the grant; the panel shows membership + effective viewers, and
    // opening the restricted panel records the disclosure (no session ⇒ one
    // entry per open, the conflict-check posture)
    await changeRestriction(P, {
      matter: m2,
      change: { action: 'add_grant', granteeKind: 'staff', grantee: fx.staff },
      reason: 'screens test xscr',
    })
    const before = await registerCount('restricted.read', m2, 'restriction_panel')
    const panel = await restrictionPanel(P, m2)
    expect(panel.matter.restricted).toBe(true)
    expect(panel.membership.grants.length).toBe(1)
    expect(panel.effectiveViewers.map((v) => v.staff)).toEqual([fx.staff])
    expect(await registerCount('restricted.read', m2, 'restriction_panel')).toBe(before + 1)

    // the predicate: Sam sees neither the hub nor the panel nor the list row
    await expect(matterHub(S, m2)).rejects.toMatchObject({ code: 'not_found' })
    await expect(restrictionPanel(S, m2)).rejects.toMatchObject({ code: 'not_found' })
    const samList = await matterList(S, { q: 'xscr' })
    expect(samList.some((r) => r.id === m2)).toBe(false)

    // the cleared viewer's hub and list opens are recorded per surface
    const hubBefore = await registerCount('restricted.read', m2, 'matter_profile')
    await matterHub(P, m2)
    expect(await registerCount('restricted.read', m2, 'matter_profile')).toBe(hubBefore + 1)
    const listBefore = await registerCount('restricted.read', m2, 'matter_list')
    const pList = await matterList(P, { q: 'xscr' })
    expect(pList.some((r) => r.id === m2 && r.restricted)).toBe(true)
    expect(await registerCount('restricted.read', m2, 'matter_list')).toBe(listBefore + 1)

    // lifting the restriction: the remove-grant delta restores everyone
    const lift = await computeRestrictionDelta(P, {
      matter: m2,
      change: { action: 'remove_grant', granteeKind: 'staff', grantee: fx.staff },
    })
    expect(lift.restrictedAfter).toBe(false)
    expect(lift.gains.some((g) => g.staff === sam)).toBe(true)
    expect(lift.portalGains.some((x) => x.party === portalParty)).toBe(true)
  })

  it('close screen reads the live position and setting badges', async () => {
    const scr = await closeScreen(P, fx.matter)
    expect(scr.requiresApproval).toBe(false)
    expect(scr.evaluation.heldFunds.behaviour).toBe('block') // shipped default
    expect(scr.evaluation.unbilled.behaviour).toBe('warn')
    expect(scr.refusals).toEqual([])
    expect(scr.position.ledgers.length).toBe(1) // the fixture ledger, zero balance
    expect(scr.pendingRequest).toBeNull()
  })

  it('approval queue: own requests flagged unapprovable; a second admin decides', async () => {
    const made = await createMatter(P, {
      title: 'Approval queue matter xscr',
      clientParty: fx.clientParty,
      responsibleLawyer: fx.staff,
      office: fx.office,
      practiceArea: fx.practiceArea,
    })
    await setFirmSetting(admin, 'matter.close_requires_approval', true, 120)
    try {
      const r = await closeMatter(P, { matter: made.id })
      expect(r.closed).toBe(false)

      const mine = await closeApprovalQueue(P)
      const myRow = mine.find((x) => x.matter === made.id)!
      expect(myRow.own).toBe(true)

      const theirs = await closeApprovalQueue(S)
      const samRow = theirs.find((x) => x.matter === made.id)!
      expect(samRow.own).toBe(false)

      // the pending request also surfaces on the hub and the close screen
      const hub = await matterHub(P, made.id)
      expect(hub.pendingCloseRequest!.id).toBe(myRow.id)

      await approveCloseRequest(S, { request: myRow.id })
      const after = await closeApprovalQueue(P)
      expect(after.some((x) => x.matter === made.id)).toBe(false)
    } finally {
      await setFirmSetting(admin, 'matter.close_requires_approval', false, 90)
    }
  })

  it('staffing panel reflects the one dedicated change operation', async () => {
    // an OP-created matter carries its initial responsible-lawyer staffing
    // row — the raw fixture matter deliberately bypasses that
    const made = await createMatter(P, {
      title: 'Staffing panel matter xscr',
      clientParty: fx.clientParty,
      responsibleLawyer: fx.staff,
      office: fx.office,
      practiceArea: fx.practiceArea,
    })
    await changeStaffing(P, { matter: made.id, addAssisting: [sam] })
    const panel = await staffingPanel(P, made.id)
    const current = panel.staffing.filter((s) => s.toAt === null)
    expect(current.some((s) => s.staff === sam && s.role === 'assisting')).toBe(true)
    expect(current.some((s) => s.staff === fx.staff && s.role === 'responsible_lawyer')).toBe(true)
    expect(panel.staffOptions.length).toBeGreaterThanOrEqual(2)
  })

  it('bulk run report: commit, report, reverse — with outcomes recorded', async () => {
    const a = await createMatter(P, {
      title: 'Bulk A xscr',
      clientParty: fx.clientParty,
      responsibleLawyer: fx.staff,
      office: fx.office,
      practiceArea: fx.practiceArea,
    })
    const b = await createMatter(P, {
      title: 'Bulk B xscr',
      clientParty: fx.clientParty,
      responsibleLawyer: fx.staff,
      office: fx.office,
      practiceArea: fx.practiceArea,
    })
    const dry = await dryRunBulk(P, { kind: 'matter_hold', matters: [a.id, b.id] })
    expect(dry.included).toBe(2)
    const committed = await commitBulk(P, { dryRun: dry })

    const report = await bulkRunReport(P, committed.bulkOperation)
    expect(report.run.stillReversible).toBe(true)
    expect(report.items.length).toBe(2)
    expect(report.items.every((i) => (i.after as { status: string }).status === 'on_hold')).toBe(true)

    const reversed = await reverseBulk(P, {
      bulkOperation: committed.bulkOperation,
      reason: 'screens test xscr',
    })
    expect(reversed.blocked).toBe(0)
    const after = await bulkRunReport(P, committed.bulkOperation)
    expect(after.run.reversedAt).not.toBeNull()
    expect(after.items.every((i) => i.reversalOutcome === 'reversed')).toBe(true)
  })
})

describe('intake surfaces + stage administration', () => {
  let stageA: number
  let stageB: number
  let stageC: number
  let intakeId: number

  it('stage administration: create, rename, reorder, retire — registered and guarded', async () => {
    stageA = (await createIntakeStage(P, { name: 'xscr First look' })).id
    stageB = (await createIntakeStage(P, { name: 'xscr Quoting' })).id
    stageC = (await createIntakeStage(P, { name: 'xscr Decision' })).id

    await expect(createIntakeStage(P, { name: 'xscr Quoting' })).rejects.toMatchObject({
      code: 'name_in_use',
    })
    await expect(reorderIntakeStages(P, { orderedStages: [stageA, stageB] })).rejects.toMatchObject({
      code: 'order_incomplete',
    })

    await reorderIntakeStages(P, { orderedStages: [stageC, stageA, stageB] })
    await renameIntakeStage(P, { stage: stageB, name: 'xscr Quoting & costs' })
    await setIntakeStageActive(P, { stage: stageC, active: false })

    const board = await intakeBoard(P, {})
    const mine = board.stages.filter((s) => s.name.startsWith('xscr'))
    expect(mine.find((s) => s.id === stageB)!.name).toBe('xscr Quoting & costs')
    expect(mine.find((s) => s.id === stageC)!.active).toBe(false)
    const activeMine = mine.filter((s) => s.active).sort((a, b) => a.position - b.position)
    expect(activeMine.map((s) => s.id)).toEqual([stageA, stageB])
  })

  it('board and tiles carry records per stage; test-mode rows never surface', async () => {
    const made = await createIntake(P, {
      newProspect: { kind: 'person', fullName: 'Intake Prospect xscr' },
      contactPhone: '0400 333 444',
      about: 'Needs help with a fence dispute xscr',
      practiceArea: fx.practiceArea,
      stage: stageA,
    })
    intakeId = made.id

    // a test-mode record (the 0022 containment) — never on business surfaces
    const testParty = await admin.query(
      `insert into deedbox.party (kind, display_name, test) values ('person', 'Testy xscr', true) returning id`,
    )
    await admin.query(
      `insert into deedbox.intake_record (prospect_party, contact_phone, about, test_flag, stage)
       values ($1, '000', 'test containment row xscr', true, $2)`,
      [testParty.rows[0].id, stageA],
    )

    const board = await intakeBoard(P, {})
    expect(board.enabled).toBe(true)
    expect(board.records.some((r) => r.id === intakeId)).toBe(true)
    expect(board.records.some((r) => r.about.includes('test containment'))).toBe(false)

    const tiles = await intakeTiles(P)
    const stageTile = tiles.perStage.find((t) => t.stage_name === 'xscr First look')
    expect(stageTile?.n).toBe(1)

    await setIntakeOutcome(P, {
      intake: intakeId,
      outcomeReason: (
        await admin.query(
          `select ci.id from deedbox.choice_item ci join deedbox.choice_list cl on cl.id = ci.list
            where cl.purpose_key = 'intake_outcomes' and ci.active order by ci.position limit 1`,
        )
      ).rows[0].id,
    })
    const tilesAfter = await intakeTiles(P)
    expect(tilesAfter.outcomes.reduce((n, o) => n + o.n, 0)).toBeGreaterThanOrEqual(1)
  })

  it('the intake record read: parties, notes, attached checks', async () => {
    const other = await createParty(P, { kind: 'person', fullName: 'Intake Other Side xscr' })
    const capacity = (
      await admin.query(
        `select ci.id from deedbox.choice_item ci join deedbox.choice_list cl on cl.id = ci.list
          where cl.purpose_key = 'matter_party_capacities' and ci.active
            and coalesce(ci.shipped_key, '') <> 'client' order by ci.position limit 1`,
      )
    ).rows[0].id
    await addIntakeParty(P, { intake: intakeId, party: other.id, capacity })
    await createNote(P, { ownerType: 'intake_record', owner: intakeId, body: 'intake note xscr' })

    const check = await runConflictCheck(P, { name: 'Intake Other Side xscr' })
    await attachConflictCheck(P, { check: check.check, to: { kind: 'intake_record', id: intakeId } })

    const rec = await intakeRecord(P, intakeId)
    expect(rec.record.prospectName).toBe('Intake Prospect xscr')
    expect(rec.parties.some((x) => x.party === other.id)).toBe(true)
    expect(rec.notes.some((n) => n.body === 'intake note xscr')).toBe(true)
    expect(rec.checks.some((c) => c.id === check.check && c.resolution === null)).toBe(true)

    await closeIntake(P, { intake: intakeId })
    const closed = await intakeRecord(P, intakeId)
    expect(closed.record.state).toBe('closed')
    expect(closed.record.outcomeLabel).not.toBeNull() // outcome survives the close
  })
})

describe('conflict register + practice areas', () => {
  it('the register lists checks with attachment and resolution state; the snapshot renders', async () => {
    const check = await runConflictCheck(P, { name: 'Zebedee Quirkafleeg xscr' })
    let register = await conflictRegister(P, { limit: 50 })
    const row = register.find((c) => c.id === check.check)!
    expect(row.resolution).toBeNull()
    expect(row.runnerName).toContain('Pat')

    await recordConflictResolution(P, { check: check.check, resolution: 'no_conflict_found' })
    register = await conflictRegister(P, { limit: 50 })
    expect(register.find((c) => c.id === check.check)!.resolution).toBe('no_conflict_found')

    const detail = await conflictCheckDetail(P, check.check)
    const snapshot = detail.snapshot as { groups: { where: string; hits: unknown[] }[] }
    const partyGroup = snapshot.groups.find((g) => g.where === 'party_names')!
    expect(partyGroup.hits.length).toBeGreaterThanOrEqual(1) // the seeded party (fuzzy inclusive)
    expect(detail.resolution).toBe('no_conflict_found')
  })

  it('practice-area admin: areas, pairs matrix, absent default', async () => {
    const made = await createPracticeArea(P, { name: 'Fences xscr' })
    await setRelatablePair(P, { areaA: fx.practiceArea, areaB: made.id, allowed: false })

    const adminView = await practiceAreasAdmin(P)
    expect(adminView.areas.some((a) => a.id === made.id && a.active)).toBe(true)
    expect(adminView.absentDefault).toBe(true) // shipped default
    const [lo, hi] =
      fx.practiceArea <= made.id ? [fx.practiceArea, made.id] : [made.id, fx.practiceArea]
    expect(adminView.pairs.some((x) => x.area_a === lo && x.area_b === hi && x.allowed === false)).toBe(true)
  })
})
