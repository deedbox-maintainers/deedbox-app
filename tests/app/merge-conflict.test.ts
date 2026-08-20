import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import type { Pool } from 'pg'
import { closePool, withPrincipal } from '@/lib/db'
import type { Principal } from '@/lib/db'
import {
  createParty,
  createMatter,
  addMatterParty,
  linkParties,
  createIntake,
  checkDuplicates,
  dryRunMerge,
  commitMerge,
  undoMerge,
  changeClient,
  changeRestriction,
  runConflictCheck,
  createNote,
} from '@/lib/ops/matters'
import { makeAdminPool, buildFixture, addStaff, type Fixture } from './helpers'

let admin: Pool
let fx: Fixture
let P: Principal
let P2: Principal

async function capacityItem(shippedKey: string): Promise<number> {
  const r = await admin.query(
    `select ci.id from deedbox.choice_item ci
       join deedbox.choice_list cl on cl.id = ci.list
      where cl.purpose_key = 'matter_party_capacities' and ci.shipped_key = $1`,
    [shippedKey],
  )
  return r.rows[0].id as number
}

beforeAll(async () => {
  admin = makeAdminPool()
  fx = await buildFixture(admin, 'mgc')
  P = { kind: 'staff', id: fx.staff, firm: fx.firm }
  P2 = { kind: 'staff', id: await addStaff(admin, fx, 'sam.mgc'), firm: fx.firm }
})

afterAll(async () => {
  await closePool()
  await admin.end()
})

describe('party merge', () => {
  let survivor: number
  let absorbed: number
  let clientMatter: number
  let witnessMatter: number

  beforeAll(async () => {
    const s = await createParty(P, {
      kind: 'person',
      fullName: 'Dora Duplicate mgc',
      phones: [{ value: '0400 900 100', primary: true }],
    })
    survivor = s.id
    const a = await createParty(P, {
      kind: 'person',
      fullName: 'Dorah Duplicate mgc',
      phones: [{ value: '0400 900 200', primary: true }],
    })
    absorbed = a.id

    const m1 = await createMatter(P, {
      title: 'Absorbed client matter',
      clientParty: absorbed,
      responsibleLawyer: fx.staff,
      office: fx.office,
      practiceArea: fx.practiceArea,
    })
    clientMatter = m1.id

    const m2 = await createMatter(P, {
      title: 'Witness collision matter',
      clientParty: fx.clientParty,
      responsibleLawyer: fx.staff,
      office: fx.office,
      practiceArea: fx.practiceArea,
    })
    witnessMatter = m2.id
    const witnessCap = await capacityItem('witness')
    await addMatterParty(P, { matter: witnessMatter, party: survivor, capacity: witnessCap })
    await addMatterParty(P, { matter: witnessMatter, party: absorbed, capacity: witnessCap })

    const linkKind = await admin.query(
      `select ci.id from deedbox.choice_item ci join deedbox.choice_list cl on cl.id = ci.list
        where cl.purpose_key = 'party_link_kinds' and ci.shipped_key = 'related'`,
    )
    await linkParties(P, { fromParty: survivor, toParty: absorbed, linkKind: linkKind.rows[0].id })

    await createIntake(P, {
      prospectParty: absorbed,
      contactPhone: '0400 900 300',
      about: 'merge fixture enquiry',
    })
  })

  it('dry-runs with honest counts and collisions', async () => {
    const dr = await dryRunMerge(P, { survivor, absorbed })
    const byTable = Object.fromEntries(dr.repoints.map((r) => [r.table, r.rows]))
    expect(byTable['matter (client column)']).toBe(1)
    expect(byTable['intake prospects']).toBe(1)
    expect(dr.collisions.length).toBe(2) // witness capacity + the direct link
    expect(dr.absorbed.content).toHaveProperty('names')
  })

  it('commits: repoints, deduplicates, freezes the absorbed record, registers privileged', async () => {
    const dr = await dryRunMerge(P, { survivor, absorbed })
    const r = await commitMerge(P, { survivor, absorbed, dryRun: dr })
    expect(r.merge).toBeGreaterThan(0)

    const ap = await admin.query(
      `select state, merged_into, portal_login from deedbox.party where id = $1`,
      [absorbed],
    )
    expect(ap.rows[0].state).toBe('merged')
    expect(ap.rows[0].merged_into).toBe(survivor)

    const client = await admin.query(`select client_party from deedbox.matter where id = $1`, [
      clientMatter,
    ])
    expect(client.rows[0].client_party).toBe(survivor)

    // no live matter-party rows remain for the absorbed party anywhere
    const live = await admin.query(
      `select count(*)::int as n from deedbox.matter_party where party = $1 and deleted_at is null`,
      [absorbed],
    )
    expect(live.rows[0].n).toBe(0)

    // exactly one live witness row on the collision matter, held by the survivor
    const witnesses = await admin.query(
      `select count(*)::int as n from deedbox.matter_party mp
         join deedbox.choice_item ci on ci.id = mp.capacity
        where mp.matter = $1 and ci.shipped_key = 'witness' and mp.deleted_at is null`,
      [witnessMatter],
    )
    expect(witnesses.rows[0].n).toBe(1)

    // the direct link became a self-link and was deactivated
    const links = await admin.query(
      `select count(*)::int as n from deedbox.party_link
        where (from_party = $1 or to_party = $1) and deleted_at is null`,
      [absorbed],
    )
    expect(links.rows[0].n).toBe(0)

    const reg = await admin.query(
      `select privileged from deedbox.register_entry
        where event_kind = 'merge.executed' and subject = $1`,
      [r.merge],
    )
    expect(reg.rowCount).toBe(1)
    expect(reg.rows[0].privileged).toBe(true)

    // the absorbed NAME now finds the survivor (name keys re-aim through the
    // redirect; contact keys are active-party-only by design, so the search
    // is name-only — the exact-normalised path)
    const found = await checkDuplicates(P, { name: 'Dorah Duplicate mgc' })
    expect(found.map((f) => f.party)).toContain(survivor)
  })

  it('undoes cleanly inside the window: every item reversed, world restored', async () => {
    const merge = await admin.query(
      `select id from deedbox.party_merge where absorbed = $1 order by id desc limit 1`,
      [absorbed],
    )
    const r = await undoMerge(P, { merge: merge.rows[0].id, reason: 'merged the wrong pair' })
    expect(r.blocked).toBe(0)
    expect(r.undone).toBe(true)

    const ap = await admin.query(`select state, merged_into from deedbox.party where id = $1`, [
      absorbed,
    ])
    expect(ap.rows[0].state).toBe('active')
    expect(ap.rows[0].merged_into).toBeNull()
    const client = await admin.query(`select client_party from deedbox.matter where id = $1`, [
      clientMatter,
    ])
    expect(client.rows[0].client_party).toBe(absorbed)
    const witnesses = await admin.query(
      `select count(*)::int as n from deedbox.matter_party mp
         join deedbox.choice_item ci on ci.id = mp.capacity
        where mp.matter = $1 and ci.shipped_key = 'witness' and mp.deleted_at is null`,
      [witnessMatter],
    )
    expect(witnesses.rows[0].n).toBe(2)
    const undone = await admin.query(
      `select undone_at from deedbox.party_merge where id = $1`,
      [merge.rows[0].id],
    )
    expect(undone.rows[0].undone_at).not.toBeNull()
  })

  it('a partial undo blocks touched items, records outcomes, and the merge stands', async () => {
    const third = await createParty(P, { kind: 'person', fullName: 'Terry Third mgc' })
    const dr = await dryRunMerge(P, { survivor, absorbed })
    const r = await commitMerge(P, { survivor, absorbed, dryRun: dr })

    // touch a repointed row after the merge: move the client on to a third party
    await changeClient(P, { matter: clientMatter, newClient: third.id })

    const u = await undoMerge(P, { merge: r.merge, reason: 'attempting late reversal' })
    expect(u.blocked).toBeGreaterThan(0)
    expect(u.undone).toBe(false)

    const mg = await admin.query(`select undone_at from deedbox.party_merge where id = $1`, [r.merge])
    expect(mg.rows[0].undone_at).toBeNull() // the merge stands
    const outcomes = await admin.query(
      `select reversal_outcome, count(*)::int as n from deedbox.bulk_operation_item
        where operation = $1 group by reversal_outcome order by reversal_outcome`,
      [r.bulkOperation],
    )
    const map = Object.fromEntries(outcomes.rows.map((o) => [o.reversal_outcome, o.n]))
    expect(map['blocked']).toBeGreaterThan(0)
    expect(map['reversed']).toBeGreaterThan(0)
    // the itemised report names why
    const reasons = await admin.query(
      `select block_reason from deedbox.bulk_operation_item
        where operation = $1 and reversal_outcome = 'blocked'`,
      [r.bulkOperation],
    )
    expect(reasons.rows[0].block_reason).toMatch(/client changed/)
  })
})

describe('conflict check run', () => {
  let restrictedMatter: number

  beforeAll(async () => {
    const m = await createMatter(P, {
      title: 'Quietly sensitive matter',
      clientParty: fx.clientParty,
      responsibleLawyer: fx.staff,
      office: fx.office,
      practiceArea: fx.practiceArea,
    })
    restrictedMatter = m.id
    await createNote(P, {
      ownerType: 'matter',
      owner: restrictedMatter,
      body: 'notes concerning Quentin Quarry and the corpus sweep',
    })
    // restrict it to P2 alone — P keeps restriction.manage but loses sight
    await changeRestriction(P, {
      matter: restrictedMatter,
      change: { action: 'add_grant', granteeKind: 'staff', grantee: P2.id },
      reason: 'sensitive counterparty test',
    })
  })

  it('finds parties, matters and corpus text; stores the snapshot; registers', async () => {
    const r = await runConflictCheck(P, { name: 'Dora Duplicate mgc' })
    expect(r.check).toBeGreaterThan(0)
    const partyGroup = r.groups.find((g) => g.where === 'party_names')!
    expect(partyGroup.hits.length).toBeGreaterThan(0)
    const stored = await admin.query(
      `select result_snapshot from deedbox.conflict_check where id = $1`,
      [r.check],
    )
    expect(stored.rows[0].result_snapshot.groups.length).toBe(5)
    const snapshotNames = await admin.query(
      `select count(*)::int as n from deedbox.conflict_snapshot_name where "check" = $1`,
      [r.check],
    )
    expect(snapshotNames.rows[0].n).toBeGreaterThan(0)
  })

  it('the restricted pinhole: existence disclosed, detail withheld, disclosure registered', async () => {
    // the fixture client is a party on the restricted matter (its client);
    // P cannot see that matter, so the hit becomes a restricted-match line
    const r = await runConflictCheck(P, { name: 'Fixture Client mgc' })
    expect(r.restrictedMatches.count).toBeGreaterThanOrEqual(1)
    const matterGroup = r.groups.find((g) => g.where === 'matters')!
    const visibleIds = matterGroup.hits.map((h) => (h as { matter: number }).matter)
    expect(visibleIds).not.toContain(restrictedMatter)

    const disclosure = await admin.query(
      `select count(*)::int as n from deedbox.register_entry
        where event_kind = 'restricted.read' and matter = $1`,
      [restrictedMatter],
    )
    expect(disclosure.rows[0].n).toBeGreaterThanOrEqual(1)

    // the clear-sighted runner sees the matter plainly instead
    const r2 = await runConflictCheck(P2, { name: 'Fixture Client mgc' })
    const visibleToP2 = r2.groups
      .find((g) => g.where === 'matters')!
      .hits.map((h) => (h as { matter: number }).matter)
    expect(visibleToP2).toContain(restrictedMatter)
  })

  it('a later check finds the earlier one through the snapshot-name index', async () => {
    const r = await runConflictCheck(P, { name: 'Dora Duplicate mgc' })
    const past = r.groups.find((g) => g.where === 'past_check_snapshots')!
    expect(past.hits.length).toBeGreaterThan(0)
  })
})
