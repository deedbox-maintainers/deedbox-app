import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import type { Pool } from 'pg'
import { closePool, OperationRefused } from '@/lib/db'
import type { Principal } from '@/lib/db'
import {
  checkDuplicates,
  createParty,
  renameParty,
  addPartyName,
  addContactPoint,
  addAddress,
  linkParties,
  createMatter,
  updateMatterDetails,
  closeMatter,
  approveCloseRequest,
  reopenMatter,
  archiveMatter,
  holdMatter,
  resumeMatter,
  addMatterParty,
  setPortalAccess,
  softDeleteMatterParty,
  changeClient,
  changeRestriction,
  changeStaffing,
  createNote,
  editNote,
  softDeleteNote,
  restoreNote,
  createIntake,
  moveIntakeStage,
  setIntakeOutcome,
  closeIntake,
  reopenIntake,
  addIntakeParty,
  convertIntake,
  relateMatters,
  createRelatedMatter,
  attachConflictCheck,
  recordConflictResolution,
  createPracticeArea,
  renamePracticeArea,
  setPracticeAreaActive,
  setConflictRequirement,
  setRelatablePair,
} from '@/lib/ops/matters'
import { withPrincipal } from '@/lib/db'
import { makeAdminPool, buildFixture, addStaff, setFirmSetting, type Fixture } from './helpers'

let admin: Pool
let fx: Fixture
let P: Principal
let P2: Principal

async function registerCount(kind: string, subjectType: string, subject: number): Promise<number> {
  const r = await admin.query(
    `select count(*)::int as n from deedbox.register_entry
      where event_kind = $1 and subject_type = $2 and subject = $3`,
    [kind, subjectType, subject],
  )
  return r.rows[0].n as number
}

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
  fx = await buildFixture(admin, 'mtr')
  P = { kind: 'staff', id: fx.staff, firm: fx.firm }
  P2 = { kind: 'staff', id: await addStaff(admin, fx, 'sam.mtr'), firm: fx.firm }
})

afterAll(async () => {
  await closePool()
  await admin.end()
})

describe('parties', () => {
  let alexId: number

  it('creates a party with name, contacts and address; match keys and register follow', async () => {
    const r = await createParty(P, {
      kind: 'person',
      fullName: 'Alex Rivermont',
      givenNames: 'Alex',
      familyName: 'Rivermont',
      phones: [{ value: '0400 111 222', primary: true }],
      emails: [{ value: 'alex@rivermont.example', primary: true }],
      addresses: [{ locality: 'Sydney', region: 'NSW', postcode: '2000', country: 'AU' }],
      notes: 'met at the tribunal open day',
    })
    alexId = r.id
    const name = await admin.query(
      `select full_name from deedbox.party_name where party = $1 and name_kind = 'current'`,
      [alexId],
    )
    expect(name.rows[0].full_name).toBe('Alex Rivermont')
    const mirror = await admin.query(
      `select primary_phone, primary_email from deedbox.party where id = $1`,
      [alexId],
    )
    expect(mirror.rows[0].primary_email).toBe('alex@rivermont.example')
    const keys = await admin.query(
      `select count(*)::int as n from deedbox.party_match_key where party = $1`,
      [alexId],
    )
    expect(keys.rows[0].n).toBeGreaterThan(0)
    expect(await registerCount('record.created', 'party', alexId)).toBe(1)
  })

  it('refuses a blind create when candidates exist, then records the deliberate decision', async () => {
    await expect(
      createParty(P, {
        kind: 'person',
        fullName: 'Alex Rivermont',
        phones: [{ value: '0400111222' }],
      }),
    ).rejects.toMatchObject({ code: 'duplicates_found' })

    const candidates = await checkDuplicates(P, {
      name: 'Alex Rivermont',
      phone: '0400111222',
    })
    expect(candidates.map((c) => c.party)).toContain(alexId)

    const r = await createParty(P, {
      kind: 'person',
      fullName: 'Alex Rivermont',
      phones: [{ value: '0400111222' }],
      candidatesShown: candidates.map((c) => ({ party: c.party, displayName: c.displayName })),
    })
    const dec = await admin.query(
      `select decision_mode from deedbox.duplicate_decision
        where created_entity_type = 'party' and created_entity = $1`,
      [r.id],
    )
    expect(dec.rowCount).toBe(1)
    expect(dec.rows[0].decision_mode).toBe('interactive')
  })

  it('renames: demotes the current name, installs the new one, and registers before/after', async () => {
    await renameParty(P, { party: alexId, fullName: 'Alex Rivermont-Chase' })
    const names = await admin.query(
      `select name_kind, full_name from deedbox.party_name where party = $1 order by id`,
      [alexId],
    )
    expect(names.rows.map((n) => n.name_kind)).toEqual(['former', 'current'])
    const display = await admin.query(`select display_name from deedbox.party where id = $1`, [alexId])
    expect(display.rows[0].display_name).toBe('Alex Rivermont-Chase')
    expect(await registerCount('record.changed', 'party', alexId)).toBeGreaterThan(0)
    // no ledger-bearing matter has this party as client: no master-data event
    expect(await registerCount('master_data.changed', 'party', alexId)).toBe(0)
  })

  it('emits master_data.changed when renaming the client of a ledger-bearing matter', async () => {
    await renameParty(P, { party: fx.clientParty, fullName: 'Fixture Client mtr (renamed)' })
    expect(await registerCount('master_data.changed', 'party', fx.clientParty)).toBe(1)
  })

  it('adds a trading name and links two parties', async () => {
    await addPartyName(P, { party: alexId, nameKind: 'trading', fullName: 'Rivermont Consulting' })
    const kinds = await admin.query(
      `select count(*)::int as n from deedbox.party_name where party = $1 and name_kind = 'trading'`,
      [alexId],
    )
    expect(kinds.rows[0].n).toBe(1)

    const linkKind = await admin.query(
      `select ci.id from deedbox.choice_item ci
         join deedbox.choice_list cl on cl.id = ci.list
        where cl.purpose_key = 'party_link_kinds' and ci.shipped_key = 'related'`,
    )
    const link = await linkParties(P, {
      fromParty: fx.clientParty,
      toParty: alexId,
      linkKind: linkKind.rows[0].id as number,
    })
    expect(await registerCount('record.created', 'party_link', link.id)).toBe(1)
  })

  it('adds contacts and addresses with the primary hand-over', async () => {
    await addContactPoint(P, { party: alexId, kind: 'phone', value: '0400 333 444', primary: true })
    const primaries = await admin.query(
      `select value from deedbox.contact_point
        where party = $1 and kind = 'phone' and is_primary and deleted_at is null`,
      [alexId],
    )
    expect(primaries.rowCount).toBe(1)
    expect(primaries.rows[0].value).toBe('0400 333 444')
    await addAddress(P, { party: alexId, locality: 'Newcastle', region: 'NSW' })
  })
})

describe('matter creation', () => {
  let matterId: number

  it('creates a matter: gapless number, auto client row, staffing, corpus, register', async () => {
    const r = await createMatter(P, {
      title: 'Rivermont purchase',
      clientParty: fx.clientParty,
      responsibleLawyer: fx.staff,
      office: fx.office,
      practiceArea: fx.practiceArea,
      summary: 'purchase of the river block',
    })
    matterId = r.id
    expect(r.matterNumber).toMatch(/^M-\d{4}-\d{5}$/)

    const clientRow = await admin.query(
      `select count(*)::int as n from deedbox.matter_party mp
         join deedbox.choice_item ci on ci.id = mp.capacity
        where mp.matter = $1 and mp.party = $2 and ci.shipped_key = 'client' and mp.deleted_at is null`,
      [matterId, fx.clientParty],
    )
    expect(clientRow.rows[0].n).toBe(1)

    const staffing = await admin.query(
      `select count(*)::int as n from deedbox.matter_staffing
        where matter = $1 and role_on_matter = 'responsible_lawyer' and to_at is null`,
      [matterId],
    )
    expect(staffing.rows[0].n).toBe(1)

    const corpus = await admin.query(
      `select count(*)::int as n from deedbox.registered_text
        where matter = $1 and superseded_at is null`,
      [matterId],
    )
    expect(corpus.rows[0].n).toBeGreaterThan(0)

    expect(await registerCount('record.created', 'matter', matterId)).toBe(1)
    expect(await registerCount('matter.status_changed', 'matter', matterId)).toBe(1)
  })

  it('amends the title and summary with before/after on the register; the corpus follows', async () => {
    await updateMatterDetails(P, {
      matter: matterId,
      title: 'Rivermont purchase (amended)',
      summary: 'purchase of the river block, boundary corrected',
    })
    const m = await admin.query(`select title, summary from deedbox.matter where id = $1`, [
      matterId,
    ])
    expect(m.rows[0].title).toBe('Rivermont purchase (amended)')
    expect(m.rows[0].summary).toContain('boundary corrected')
    const corpus = await admin.query(
      `select count(*)::int as n from deedbox.registered_text
        where matter = $1 and superseded_at is null and content like '%boundary corrected%'`,
      [matterId],
    )
    expect(corpus.rows[0].n).toBeGreaterThan(0)
    expect(await registerCount('record.changed', 'matter', matterId)).toBeGreaterThanOrEqual(1)

    // a blank title refuses; the record keeps its words
    await expect(
      updateMatterDetails(P, { matter: matterId, title: '   ' }),
    ).rejects.toMatchObject({ code: 'title_required' })
  })

  it('enforces the conflict gate and attaches the resolved check', async () => {
    const gated = await admin.query(
      `insert into deedbox.practice_area (name, require_conflict_resolution)
       values ('Gated mtr', true) returning id`,
    )
    await expect(
      createMatter(P, {
        title: 'Gated matter',
        clientParty: fx.clientParty,
        responsibleLawyer: fx.staff,
        office: fx.office,
        practiceArea: gated.rows[0].id,
      }),
    ).rejects.toMatchObject({ code: 'conflict_check_required' })

    const check = await admin.query(
      `insert into deedbox.conflict_check (run_by, terms, result_snapshot)
       values ($1, '{"name":"Rivermont"}', '{"groups":[]}') returning id`,
      [fx.staff],
    )
    const checkId = check.rows[0].id as number
    await expect(
      createMatter(P, {
        title: 'Gated matter',
        clientParty: fx.clientParty,
        responsibleLawyer: fx.staff,
        office: fx.office,
        practiceArea: gated.rows[0].id,
        conflictCheck: checkId,
      }),
    ).rejects.toMatchObject({ code: 'conflict_check_unresolved' })

    await admin.query(
      `insert into deedbox.conflict_resolution ("check", resolution, resolved_by)
       values ($1, 'no_conflict_found', $2)`,
      [checkId, fx.staff],
    )
    const r = await createMatter(P, {
      title: 'Gated matter',
      clientParty: fx.clientParty,
      responsibleLawyer: fx.staff,
      office: fx.office,
      practiceArea: gated.rows[0].id,
      conflictCheck: checkId,
    })
    const attached = await admin.query(
      `select attached_to_kind, attached_to from deedbox.conflict_check where id = $1`,
      [checkId],
    )
    expect(attached.rows[0].attached_to_kind).toBe('matter')
    expect(attached.rows[0].attached_to).toBe(r.id)
  })

  it('a refused create consumes no matter number', async () => {
    const doomedParty = await admin.query(
      `insert into deedbox.party (kind, display_name, deleted_at) values ('person', 'Deleted mtr', now()) returning id`,
    )
    await expect(
      createMatter(P, {
        title: 'Doomed',
        clientParty: doomedParty.rows[0].id,
        responsibleLawyer: fx.staff,
        office: fx.office,
        practiceArea: fx.practiceArea,
      }),
    ).rejects.toMatchObject({ code: 'client_inactive' })

    const a = await createMatter(P, {
      title: 'Sequential A',
      clientParty: fx.clientParty,
      responsibleLawyer: fx.staff,
      office: fx.office,
      practiceArea: fx.practiceArea,
    })
    const b = await createMatter(P, {
      title: 'Sequential B',
      clientParty: fx.clientParty,
      responsibleLawyer: fx.staff,
      office: fx.office,
      practiceArea: fx.practiceArea,
    })
    const seqOf = (n: string) => Number(n.slice(n.lastIndexOf('-') + 1))
    expect(seqOf(b.matterNumber)).toBe(seqOf(a.matterNumber) + 1)
  })
})

describe('matter lifecycle', () => {
  let lifeMatter: number

  beforeAll(async () => {
    const r = await createMatter(P, {
      title: 'Lifecycle matter',
      clientParty: fx.clientParty,
      responsibleLawyer: fx.staff,
      office: fx.office,
      practiceArea: fx.practiceArea,
    })
    lifeMatter = r.id
  })

  it('refuses to close while client money is held, naming the failure', async () => {
    // give the FIXTURE matter's ledger money through the posting protocol
    await admin.query(
      `select deedbox.post_money_transaction('receipt', current_date, $1, 'money_receipt', 910001,
         jsonb_build_array(
           jsonb_build_object('side','cash_book','account',$2::bigint,'signed_amount',150.00),
           jsonb_build_object('side','matter_ledger','account',$2::bigint,'matter_ledger',$3::bigint,'signed_amount',150.00)))`,
      [fx.staff, fx.account, fx.ledger],
    )
    let refusal: OperationRefused | undefined
    try {
      await closeMatter(P, { matter: fx.matter })
    } catch (e) {
      if (e instanceof OperationRefused) refusal = e
      else throw e
    }
    expect(refusal).toBeDefined()
    expect(refusal!.code).toBe('close_refused')
    expect(refusal!.message).toMatch(/holds 150\.00/)
    expect(refusal!.message).toMatch(/client money remains held/)
    const still = await admin.query(`select status from deedbox.matter where id = $1`, [fx.matter])
    expect(still.rows[0].status).toBe('open')
  })

  it('closes a clean matter: approved request, status, register events', async () => {
    const r = await closeMatter(P, { matter: lifeMatter })
    expect(r.closed).toBe(true)
    const m = await admin.query(
      `select status, closed_date from deedbox.matter where id = $1`,
      [lifeMatter],
    )
    expect(m.rows[0].status).toBe('closed')
    expect(m.rows[0].closed_date).not.toBeNull()
    const req = await admin.query(
      `select state, requested_by, decided_by from deedbox.matter_close_request where matter = $1`,
      [lifeMatter],
    )
    expect(req.rows[0].state).toBe('approved')
    expect(await registerCount('matter.status_changed', 'matter', lifeMatter)).toBe(2) // create + close
  })

  it('reopen demands a reason, then reopens with it on the register', async () => {
    await expect(reopenMatter(P, { matter: lifeMatter, reason: '  ' })).rejects.toMatchObject({
      code: 'reason_required',
    })
    await reopenMatter(P, { matter: lifeMatter, reason: 'client instructed further work' })
    const m = await admin.query(
      `select status, closed_date from deedbox.matter where id = $1`,
      [lifeMatter],
    )
    expect(m.rows[0].status).toBe('open')
    expect(m.rows[0].closed_date).toBeNull()
    const reg = await admin.query(
      `select reason from deedbox.register_entry
        where event_kind = 'matter.status_changed' and subject = $1 and reason is not null`,
      [lifeMatter],
    )
    expect(reg.rows[0].reason).toBe('client instructed further work')
  })

  it('holds, resumes, re-closes (a fresh approved request), and archives', async () => {
    await holdMatter(P, { matter: lifeMatter })
    await resumeMatter(P, { matter: lifeMatter })
    const r = await closeMatter(P, { matter: lifeMatter, note: 'second close' })
    expect(r.closed).toBe(true)
    const reqs = await admin.query(
      `select count(*)::int as n from deedbox.matter_close_request where matter = $1 and state = 'approved'`,
      [lifeMatter],
    )
    expect(reqs.rows[0].n).toBe(2)
    await archiveMatter(P, { matter: lifeMatter })
    const m = await admin.query(`select status from deedbox.matter where id = $1`, [lifeMatter])
    expect(m.rows[0].status).toBe('archived')
  })

  it('runs the approval flow with approver separation', async () => {
    await setFirmSetting(admin, 'matter.close_requires_approval', true, 60)
    try {
      const m = await createMatter(P, {
        title: 'Approval-flow matter',
        clientParty: fx.clientParty,
        responsibleLawyer: fx.staff,
        office: fx.office,
        practiceArea: fx.practiceArea,
      })
      const r = await closeMatter(P, { matter: m.id })
      expect(r.closed).toBe(false)
      expect(r.pendingRequest).toBeGreaterThan(0)

      await expect(
        approveCloseRequest(P, { request: r.pendingRequest! }),
      ).rejects.toMatchObject({ code: 'approver_separation' })

      await approveCloseRequest(P2, { request: r.pendingRequest! })
      const closed = await admin.query(`select status from deedbox.matter where id = $1`, [m.id])
      expect(closed.rows[0].status).toBe('closed')
      const req = await admin.query(
        `select requested_by, decided_by from deedbox.matter_close_request where id = $1`,
        [r.pendingRequest],
      )
      expect(req.rows[0].requested_by).toBe(fx.staff)
      expect(req.rows[0].decided_by).toBe(P2.id)
    } finally {
      await setFirmSetting(admin, 'matter.close_requires_approval', false, 30)
    }
  })
})

describe('matter parties, client change, staffing, notes', () => {
  let workMatter: number
  let witnessParty: number

  beforeAll(async () => {
    const m = await createMatter(P, {
      title: 'Working matter',
      clientParty: fx.clientParty,
      responsibleLawyer: fx.staff,
      office: fx.office,
      practiceArea: fx.practiceArea,
    })
    workMatter = m.id
    const w = await createParty(P, { kind: 'person', fullName: 'Winnie Witness mtr' })
    witnessParty = w.id
  })

  it('adds a witness, flips portal access as a privileged event, soft-deletes it', async () => {
    const witnessCap = await capacityItem('witness')
    const mp = await addMatterParty(P, {
      matter: workMatter,
      party: witnessParty,
      capacity: witnessCap,
    })
    await setPortalAccess(P, { matterParty: mp.id, portalAccess: true })
    const priv = await admin.query(
      `select count(*)::int as n from deedbox.register_entry
        where event_kind = 'record.changed' and subject_type = 'matter_party'
          and subject = $1 and privileged`,
      [mp.id],
    )
    expect(priv.rows[0].n).toBe(1)
    await softDeleteMatterParty(P, { matterParty: mp.id })
    expect(await registerCount('record.soft_deleted', 'matter_party', mp.id)).toBe(1)
  })

  it('refuses to forge or remove the client capacity row by hand', async () => {
    const clientCap = await capacityItem('client')
    await expect(
      addMatterParty(P, { matter: workMatter, party: witnessParty, capacity: clientCap }),
    ).rejects.toMatchObject({ code: 'client_capacity_reserved' })
    const clientRow = await admin.query(
      `select mp.id from deedbox.matter_party mp
         join deedbox.choice_item ci on ci.id = mp.capacity
        where mp.matter = $1 and ci.shipped_key = 'client' and mp.deleted_at is null`,
      [workMatter],
    )
    await expect(
      softDeleteMatterParty(P, { matterParty: clientRow.rows[0].id }),
    ).rejects.toMatchObject({ code: 'client_row_protected' })
  })

  it('changes the client: mirror rows follow, old client stays as related party', async () => {
    await changeClient(P, { matter: workMatter, newClient: witnessParty })
    const m = await admin.query(`select client_party from deedbox.matter where id = $1`, [workMatter])
    expect(m.rows[0].client_party).toBe(witnessParty)
    const rows = await admin.query(
      `select ci.shipped_key, mp.party from deedbox.matter_party mp
         join deedbox.choice_item ci on ci.id = mp.capacity
        where mp.matter = $1 and mp.deleted_at is null order by ci.shipped_key`,
      [workMatter],
    )
    const byKey = Object.fromEntries(rows.rows.map((r) => [r.shipped_key, r.party]))
    expect(byKey['client']).toBe(witnessParty)
    expect(byKey['related_party']).toBe(fx.clientParty)
  })

  it('moves the responsible lawyer with the mirror in one transaction', async () => {
    await changeStaffing(P, { matter: workMatter, newResponsible: P2.id })
    const m = await admin.query(
      `select responsible_lawyer from deedbox.matter where id = $1`,
      [workMatter],
    )
    expect(m.rows[0].responsible_lawyer).toBe(P2.id)
    const current = await admin.query(
      `select staff from deedbox.matter_staffing
        where matter = $1 and role_on_matter = 'responsible_lawyer' and to_at is null`,
      [workMatter],
    )
    expect(current.rowCount).toBe(1)
    expect(current.rows[0].staff).toBe(P2.id)
  })

  it('notes: create syncs the corpus; edit, soft-delete and restore register honestly', async () => {
    const n = await createNote(P, {
      ownerType: 'matter',
      owner: workMatter,
      body: 'spoke with the other side about settlement',
    })
    const corpus = await admin.query(
      `select count(*)::int as n from deedbox.registered_text
        where source_ref = $1::text and superseded_at is null and content like '%settlement%'`,
      [String(n.id)],
    )
    expect(corpus.rows[0].n).toBeGreaterThan(0)

    await editNote(P, { note: n.id, body: 'settlement agreed in principle' })
    const changed = await admin.query(
      `select detail from deedbox.register_entry
        where event_kind = 'record.changed' and subject_type = 'note' and subject = $1`,
      [n.id],
    )
    expect(changed.rows[0].detail.before.body).toMatch(/spoke with the other side/)

    await softDeleteNote(P, { note: n.id })
    await restoreNote(P, { note: n.id })
    expect(await registerCount('record.restored', 'note', n.id)).toBe(1)
  })

  it('the register chain still verifies end to end', async () => {
    const breaks = await admin.query(`select deedbox.register_verify_chain($1) as b`, [fx.firm])
    expect(breaks.rows[0].b).toBe(0)
  })
})

describe('restriction changes', () => {
  let secretMatter: number

  beforeAll(async () => {
    const m = await createMatter(P, {
      title: 'Sensitive matter',
      clientParty: fx.clientParty,
      responsibleLawyer: fx.staff,
      office: fx.office,
      practiceArea: fx.practiceArea,
    })
    secretMatter = m.id
  })

  it('demands a reason, restricts the matter, and the non-granted actor loses sight', async () => {
    await expect(
      changeRestriction(P, {
        matter: secretMatter,
        change: { action: 'add_grant', granteeKind: 'staff', grantee: P2.id },
        reason: '',
      }),
    ).rejects.toMatchObject({ code: 'reason_required' })

    await changeRestriction(P, {
      matter: secretMatter,
      change: { action: 'add_grant', granteeKind: 'staff', grantee: P2.id },
      reason: 'sensitive counterparty',
    })
    const m = await admin.query(`select restricted from deedbox.matter where id = $1`, [secretMatter])
    expect(m.rows[0].restricted).toBe(true)

    const seenByActor = await withPrincipal(
      P,
      async (tx) => {
        const r = await tx.query(`select count(*)::int as n from deedbox.matter where id = $1`, [
          secretMatter,
        ])
        return r.rows[0].n as number
      },
      { readOnly: true },
    )
    expect(seenByActor).toBe(0) // restriction defeats even the administrator who imposed it
    const seenByGrantee = await withPrincipal(
      P2,
      async (tx) => {
        const r = await tx.query(`select count(*)::int as n from deedbox.matter where id = $1`, [
          secretMatter,
        ])
        return r.rows[0].n as number
      },
      { readOnly: true },
    )
    expect(seenByGrantee).toBe(1)

    const reg = await admin.query(
      `select privileged, reason, detail from deedbox.register_entry
        where event_kind = 'restriction.changed' and subject = $1`,
      [secretMatter],
    )
    expect(reg.rowCount).toBe(1)
    expect(reg.rows[0].privileged).toBe(true)
    expect(reg.rows[0].reason).toBe('sensitive counterparty')
    expect(reg.rows[0].detail.after.grants.length).toBe(1)
  })

  it('an actor who cannot see the matter cannot change its restriction', async () => {
    await expect(
      changeRestriction(P, {
        matter: secretMatter,
        change: { action: 'add_grant', granteeKind: 'staff', grantee: fx.staff },
        reason: 'let me back in',
      }),
    ).rejects.toMatchObject({ code: 'not_found' })
  })

  it('the granted holder lifts the restriction and sight returns', async () => {
    await changeRestriction(P2, {
      matter: secretMatter,
      change: { action: 'remove_grant', granteeKind: 'staff', grantee: P2.id },
      reason: 'sensitivity resolved',
    })
    const m = await admin.query(`select restricted from deedbox.matter where id = $1`, [secretMatter])
    expect(m.rows[0].restricted).toBe(false)
  })
})

describe('intake', () => {
  let intakeId: number
  let prospectId: number

  it('creates an intake with a new prospect; the about text reaches the corpus', async () => {
    const r = await createIntake(P, {
      newProspect: { kind: 'person', fullName: 'Ivy Prospect mtr' },
      contactPhone: '0400 555 666',
      contactEmail: 'ivy@prospect.example',
      about: 'boundary dispute with the neighbouring farm',
      notes: 'called after hours',
      practiceArea: fx.practiceArea,
    })
    intakeId = r.id
    prospectId = r.prospectParty
    const corpus = await admin.query(
      `select count(*)::int as n from deedbox.registered_text
        where superseded_at is null and content like '%boundary dispute%'`,
    )
    expect(corpus.rows[0].n).toBeGreaterThan(0)
    expect(await registerCount('record.created', 'intake_record', intakeId)).toBe(1)
  })

  it('moves stages (active only), sets and clears the outcome, closes and reopens', async () => {
    const stage = await admin.query(
      `insert into deedbox.intake_stage (name, position) values ('Qualified mtr', 91) returning id`,
    )
    await moveIntakeStage(P, { intake: intakeId, stage: stage.rows[0].id })

    const dead = await admin.query(
      `insert into deedbox.intake_stage (name, position, active) values ('Dead mtr', 92, false) returning id`,
    )
    await expect(
      moveIntakeStage(P, { intake: intakeId, stage: dead.rows[0].id }),
    ).rejects.toMatchObject({ code: 'stage_inactive' })

    const reason = await admin.query(
      `select ci.id from deedbox.choice_item ci join deedbox.choice_list cl on cl.id = ci.list
        where cl.purpose_key = 'intake_outcomes' and ci.shipped_key = 'did_not_proceed'`,
    )
    await setIntakeOutcome(P, { intake: intakeId, outcomeReason: reason.rows[0].id })
    let rec = await admin.query(
      `select outcome_at from deedbox.intake_record where id = $1`,
      [intakeId],
    )
    expect(rec.rows[0].outcome_at).not.toBeNull()
    await setIntakeOutcome(P, { intake: intakeId, outcomeReason: null })
    rec = await admin.query(`select outcome_at from deedbox.intake_record where id = $1`, [intakeId])
    expect(rec.rows[0].outcome_at).toBeNull()

    await closeIntake(P, { intake: intakeId })
    await reopenIntake(P, { intake: intakeId })
  })

  it('converts to a matter: parties copied, terminal state, cross-linked register', async () => {
    const witnessCap = await capacityItem('witness')
    const extra = await createParty(P, { kind: 'person', fullName: 'Colin Colleague mtr' })
    await addIntakeParty(P, { intake: intakeId, party: extra.id, capacity: witnessCap })

    const r = await convertIntake(P, {
      intake: intakeId,
      responsibleLawyer: fx.staff,
      office: fx.office,
    })
    expect(r.matterNumber).toMatch(/^M-\d{4}-\d{5}$/)

    const m = await admin.query(
      `select client_party, summary from deedbox.matter where id = $1`,
      [r.matter],
    )
    expect(m.rows[0].client_party).toBe(prospectId)
    expect(m.rows[0].summary).toMatch(/boundary dispute/)

    const copied = await admin.query(
      `select count(*)::int as n from deedbox.matter_party
        where matter = $1 and party = $2 and deleted_at is null`,
      [r.matter, extra.id],
    )
    expect(copied.rows[0].n).toBe(1)

    const rec = await admin.query(
      `select state, converted_matter from deedbox.intake_record where id = $1`,
      [intakeId],
    )
    expect(rec.rows[0].state).toBe('converted')
    expect(rec.rows[0].converted_matter).toBe(r.matter)

    await expect(
      moveIntakeStage(P, { intake: intakeId, stage: 1 }),
    ).rejects.toMatchObject({ code: 'converted_terminal' })

    const correlated = await admin.query(
      `select count(*)::int as n from deedbox.register_entry
        where event_kind = 'record.changed'
          and detail ->> 'correlation' = $1`,
      [`intake-${intakeId}-matter-${r.matter}`],
    )
    expect(correlated.rows[0].n).toBe(2)
  })

  it('the conversion conflict gate rides the intake-attached check for both gates', async () => {
    const gated = await admin.query(
      `insert into deedbox.practice_area (name, require_conflict_resolution)
       values ('Gated convert mtr', true) returning id`,
    )
    const intake = await createIntake(P, {
      prospectParty: fx.clientParty,
      contactPhone: '0400 777 888',
      about: 'gated conversion enquiry',
      practiceArea: gated.rows[0].id,
    })
    await expect(
      convertIntake(P, {
        intake: intake.id,
        responsibleLawyer: fx.staff,
        office: fx.office,
      }),
    ).rejects.toMatchObject({ code: 'conflict_check_required' })

    const check = await admin.query(
      `insert into deedbox.conflict_check (run_by, terms, attached_to_kind, attached_to, result_snapshot)
       values ($1, '{"name":"gated"}', 'intake_record', $2, '{"groups":[]}') returning id`,
      [fx.staff, intake.id],
    )
    await admin.query(
      `insert into deedbox.conflict_resolution ("check", resolution, resolved_by)
       values ($1, 'no_conflict_found', $2)`,
      [check.rows[0].id, fx.staff],
    )
    const done = await convertIntake(P, {
      intake: intake.id,
      responsibleLawyer: fx.staff,
      office: fx.office,
    })
    expect(done.matter).toBeGreaterThan(0)
  })
})

describe('matter relations', () => {
  it('relates two matters canonically with both timelines carrying the act', async () => {
    const label = await admin.query(
      `insert into deedbox.choice_item (list, label, position)
       select id, 'Related proceeding mtr', 90 from deedbox.choice_list
        where purpose_key = 'relation_labels' returning id`,
    )
    const m1 = await createMatter(P, {
      title: 'Relation A',
      clientParty: fx.clientParty,
      responsibleLawyer: fx.staff,
      office: fx.office,
      practiceArea: fx.practiceArea,
    })
    const m2 = await createMatter(P, {
      title: 'Relation B',
      clientParty: fx.clientParty,
      responsibleLawyer: fx.staff,
      office: fx.office,
      practiceArea: fx.practiceArea,
    })
    // deliberately reversed: the guard canonicalises to lower-id-first
    const rel = await relateMatters(P, { matterA: m2.id, matterB: m1.id, label: label.rows[0].id })
    const row = await admin.query(
      `select matter_a, matter_b from deedbox.matter_relation where id = $1`,
      [rel.id],
    )
    expect(row.rows[0].matter_a).toBe(m1.id)
    expect(row.rows[0].matter_b).toBe(m2.id)
    const entries = await admin.query(
      `select count(*)::int as n from deedbox.register_entry
        where subject_type = 'matter_relation' and subject = $1 and event_kind = 'record.created'`,
      [rel.id],
    )
    expect(entries.rows[0].n).toBe(2)

    const related = await createRelatedMatter(P, {
      sourceMatter: m1.id,
      label: label.rows[0].id,
      title: 'Spawned related matter',
      responsibleLawyer: fx.staff,
      office: fx.office,
      practiceArea: fx.practiceArea,
      copyParties: true,
    })
    const client = await admin.query(
      `select client_party from deedbox.matter where id = $1`,
      [related.id],
    )
    expect(client.rows[0].client_party).toBe(fx.clientParty)
    const relRow = await admin.query(
      `select carried_parties from deedbox.matter_relation where id = $1`,
      [related.relation],
    )
    expect(relRow.rows[0].carried_parties).toBe(true)
  })
})

describe('conflict records and practice-area administration', () => {
  it('attaches a check once, and a found conflict demands its action note', async () => {
    const check = await admin.query(
      `insert into deedbox.conflict_check (run_by, terms, result_snapshot)
       values ($1, '{"name":"records test"}', '{"groups":[]}') returning id`,
      [fx.staff],
    )
    const checkId = check.rows[0].id as number

    await expect(
      recordConflictResolution(P, { check: checkId, resolution: 'conflict_found_action_taken' }),
    ).rejects.toMatchObject({ code: 'action_note_required' })
    await recordConflictResolution(P, {
      check: checkId,
      resolution: 'conflict_found_action_taken',
      actionNote: 'screened the assisting team',
    })
    await expect(
      recordConflictResolution(P, { check: checkId, resolution: 'no_conflict_found' }),
    ).rejects.toMatchObject({ code: 'already_resolved' })

    await attachConflictCheck(P, { check: checkId, to: { kind: 'matter', id: fx.matter } })
    await expect(
      attachConflictCheck(P, { check: checkId, to: { kind: 'matter', id: fx.matter } }),
    ).rejects.toMatchObject({ code: 'not_attachable' })
  })

  it('administers practice areas with the privileged compliance toggle', async () => {
    const a = await createPracticeArea(P, { name: 'Area Admin mtr' })
    await renamePracticeArea(P, { area: a.id, name: 'Area Admin mtr v2' })
    await setConflictRequirement(P, { area: a.id, required: true })
    const priv = await admin.query(
      `select count(*)::int as n from deedbox.register_entry
        where subject_type = 'practice_area' and subject = $1 and privileged`,
      [a.id],
    )
    expect(priv.rows[0].n).toBe(1)
    await setRelatablePair(P, { areaA: a.id, areaB: fx.practiceArea, allowed: false })
    const pair = await admin.query(
      `select allowed from deedbox.practice_area_relatable
        where area_a = least($1::bigint, $2::bigint) and area_b = greatest($1::bigint, $2::bigint)`,
      [a.id, fx.practiceArea],
    )
    expect(pair.rows[0].allowed).toBe(false)
    await setPracticeAreaActive(P, { area: a.id, active: false })
    const row = await admin.query(`select active from deedbox.practice_area where id = $1`, [a.id])
    expect(row.rows[0].active).toBe(false)
  })
})

describe('office visibility walls (0054)', () => {
  it('under office scope a lawyer is walled to their office; the see_all_offices holder is not; blocks defeat both', async () => {
    const offB = await admin.query(
      `insert into deedbox.office (name, code) values ('Wall Office mtr', 'WMTR') returning id`,
    )
    const lawyerRole = await admin.query(`select id from deedbox.role where system_key = 'lawyer'`)
    const outsider = await admin.query(
      `insert into deedbox.staff_member (person_name, login, role, office, email)
       values ('{"given":"Wren","family":"Walled"}', 'wren.mtr', $1, $2, 'wren.mtr@example.test')
       returning id`,
      [lawyerRole.rows[0].id, offB.rows[0].id],
    )
    const m = await createMatter(P, {
      title: 'Wall test matter mtr',
      clientParty: fx.clientParty,
      responsibleLawyer: fx.staff,
      office: fx.office,
      practiceArea: fx.practiceArea,
    })
    const vis = async (staff: number) => {
      const r = await admin.query(`select deedbox.matter_visible('staff', $1, $2) v`, [staff, m.id])
      return r.rows[0].v as boolean
    }
    await setFirmSetting(admin, 'visibility.staff_scope', 'office', 0)
    try {
      // the other-office lawyer is walled; the administrator (capability
      // holder) sees firm-wide
      expect(await vis(outsider.rows[0].id as number)).toBe(false)
      expect(await vis(fx.staff)).toBe(true)
      // a block defeats the capability too
      await admin.query(
        `insert into deedbox.matter_restriction_block (matter, staff) values ($1, $2)`,
        [m.id, fx.staff],
      )
      expect(await vis(fx.staff)).toBe(false)
      await admin.query(
        `delete from deedbox.matter_restriction_block where matter = $1 and staff = $2`,
        [m.id, fx.staff],
      )
    } finally {
      await setFirmSetting(admin, 'visibility.staff_scope', 'all_staff', 0)
    }
    // back on all_staff, the outsider sees again
    expect(await vis(outsider.rows[0].id as number)).toBe(true)
  })
})
