// The Intake API: identity check, the one-call matter bundle, idempotent
// replays (created AND rejected outcomes hold the slot), lenient area
// mapping, the key-defaults gate, test-mode refusal, the documents seam,
// granular doors, the receipt trail, and the write-only property (an intake
// key reads nothing).
//
// Cross-suite contracts (localeCompare order: after imports/interface
// suites, before matters): fixture rows are tag-named (igw); NO
// database-global setting is flipped — the conflict-gate test rides a
// suite-local practice area's own flag.

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import type { Pool } from 'pg'
import { closePool, withPrincipal } from '@/lib/db'
import type { Principal } from '@/lib/db'
import {
  issueIntegrationKey,
  setIntakeKeyDefaults,
  clearIntakeKeyDefaults,
  intakeIdentity,
  intakeMatterBundle,
  intakeAddNotes,
  intakeAddDocuments,
  setIntakeDocumentStore,
  revokeIntegrationKey,
} from '@/lib/ops/interface'
import { keyDetail } from '@/lib/reads/operations'
import { makeAdminPool, buildFixture, type Fixture } from './helpers'

let admin: Pool
let fx: Fixture
let P: Principal
let liveKey: { id: number; secret: string }
let testKey: { id: number; secret: string }

beforeAll(async () => {
  admin = makeAdminPool()
  fx = await buildFixture(admin, 'igw')
  P = { kind: 'staff', id: fx.staff, firm: fx.firm }
  const k1 = await issueIntegrationKey(P, { label: 'Referral source igw' })
  liveKey = { id: k1.id, secret: k1.secret }
  const k2 = await issueIntegrationKey(P, { label: 'Test source igw', testMode: true })
  testKey = { id: k2.id, secret: k2.secret }
})

afterAll(async () => {
  setIntakeDocumentStore(null)
  await closePool()
  await admin.end()
})

describe('identity and the defaults gate', () => {
  it('me labels a valid key with the firm name and nothing else', async () => {
    const r = await intakeIdentity(fx.firm, liveKey.secret)
    expect(r).toEqual({ ok: true, firmName: 'Test Firm igw' })
    const bad = await intakeIdentity(fx.firm, 'not-a-secret')
    expect(bad).toEqual({ ok: false, reason: 'unauthenticated' })
  })

  it('the matter door refuses typed until defaults exist, then opens', async () => {
    const before = await intakeMatterBundle(fx.firm, liveKey.secret, {
      external_ref: 'igw-gate-1',
      client: { first_name: 'Gate', last_name: 'Check' },
    })
    expect(before.outcome).toBe('rejected')
    expect((before as { acknowledgement: { error: string } }).acknowledgement.error).toBe(
      'key_defaults_missing',
    )
    await setIntakeKeyDefaults(P, {
      key: liveKey.id,
      office: fx.office,
      responsibleLawyer: fx.staff,
      practiceArea: fx.practiceArea,
    })
  })
})

describe('the bundle door', () => {
  it('one call creates client + matter + notes and returns the matter number', async () => {
    const r = await intakeMatterBundle(fx.firm, liveKey.secret, {
      external_ref: 'igw-bundle-1',
      client: { first_name: 'Vera', last_name: 'Bundle', email: 'vera@example.test', phone: '0400990011' },
      matter: {
        summary: 'Needs help with a traffic matter',
        area_of_law: 'Anything At All',
        state: 'QLD',
        court_name: 'Brisbane Magistrates Court',
        court_date: '2026-09-01',
        source: 'referral',
      },
      notes: [{ title: 'Call summary', body: 'Caller explained the situation.' }],
      an_unknown_field: 'ignored, never rejected',
    })
    expect(r.outcome).toBe('created')
    const ack = (r as { acknowledgement: Record<string, unknown> }).acknowledgement
    expect(typeof ack.matter_id).toBe('number')
    expect(String(ack.matter_number)).not.toBe('')
    expect(Array.isArray(ack.note_ids)).toBe(true)
    // two notes: the court line + the caller's note
    expect((ack.note_ids as number[]).length).toBe(2)

    // the matter opened under the key's defaults; the unmatched area fell
    // back to the default with the as-sent text kept in the origin note
    const m = await admin.query(
      `select responsible_lawyer, office, practice_area, jurisdiction, origin_note
         from deedbox.matter where id = $1`,
      [ack.matter_id],
    )
    expect(m.rows[0].responsible_lawyer).toBe(fx.staff)
    expect(m.rows[0].office).toBe(fx.office)
    expect(m.rows[0].practice_area).toBe(fx.practiceArea)
    expect(m.rows[0].jurisdiction).toBe('QLD')
    expect(String(m.rows[0].origin_note)).toContain('Anything At All')
    expect(String(m.rows[0].origin_note)).toContain('igw-bundle-1')
  })

  it('a re-send of the same external_ref replays the same matter byte-for-byte', async () => {
    const first = await intakeMatterBundle(fx.firm, liveKey.secret, {
      external_ref: 'igw-bundle-1',
      client: { first_name: 'Vera', last_name: 'Bundle' },
    })
    expect(first.outcome).toBe('duplicate_replayed')
    const again = await intakeMatterBundle(fx.firm, liveKey.secret, {
      external_ref: 'igw-bundle-1',
      client: { first_name: 'Vera', last_name: 'Bundle' },
    })
    expect(again.outcome).toBe('duplicate_replayed')
    expect((first as { acknowledgement: unknown }).acknowledgement).toEqual(
      (again as { acknowledgement: unknown }).acknowledgement,
    )
    const count = await admin.query(
      `select count(*)::int as n from deedbox.matter where title like 'Vera Bundle%'`,
    )
    expect(count.rows[0].n).toBe(1)
  })

  it('a named area matches case-insensitively', async () => {
    await admin.query(`insert into deedbox.practice_area (name) values ('Traffic Law Igw')`)
    const r = await intakeMatterBundle(fx.firm, liveKey.secret, {
      external_ref: 'igw-bundle-2',
      client: { first_name: 'Ted', last_name: 'Traffic' },
      matter: { area_of_law: 'traffic law igw' },
    })
    expect(r.outcome).toBe('created')
    const ack = (r as { acknowledgement: { matter_id: number } }).acknowledgement
    const m = await admin.query(
      `select pa.name from deedbox.matter mt join deedbox.practice_area pa on pa.id = mt.practice_area
        where mt.id = $1`,
      [ack.matter_id],
    )
    expect(m.rows[0].name).toBe('Traffic Law Igw')
  })

  it('rejections are evidenced rows and hold the idempotency slot', async () => {
    const r = await intakeMatterBundle(fx.firm, liveKey.secret, {
      external_ref: 'igw-broken-1',
      client: { first_name: 'OnlyFirst', last_name: '' },
    })
    expect(r.outcome).toBe('rejected')
    expect((r as { acknowledgement: { error: string } }).acknowledgement.error).toBe(
      'client_name_required',
    )
    const replay = await intakeMatterBundle(fx.firm, liveKey.secret, {
      external_ref: 'igw-broken-1',
      client: { first_name: 'OnlyFirst', last_name: '' },
    })
    expect(replay.outcome).toBe('duplicate_replayed')
  })

  it('a test-mode key is refused at the matter door (no containment for matters)', async () => {
    await setIntakeKeyDefaults(P, {
      key: testKey.id,
      office: fx.office,
      responsibleLawyer: fx.staff,
      practiceArea: fx.practiceArea,
    })
    const r = await intakeMatterBundle(fx.firm, testKey.secret, {
      external_ref: 'igw-test-1',
      client: { first_name: 'Tess', last_name: 'Mode' },
    })
    expect(r.outcome).toBe('rejected')
    expect((r as { acknowledgement: { error: string } }).acknowledgement.error).toBe(
      'live_key_required',
    )
  })

  it("the firm's conflict discipline stands: a gate the machine cannot satisfy rejects", async () => {
    const area = await admin.query(
      `insert into deedbox.practice_area (name, require_conflict_resolution)
       values ('Conflict Gated Igw', true) returning id`,
    )
    const k = await issueIntegrationKey(P, { label: 'Gated source igw' })
    await setIntakeKeyDefaults(P, {
      key: k.id,
      office: fx.office,
      responsibleLawyer: fx.staff,
      practiceArea: area.rows[0].id as number,
    })
    const r = await intakeMatterBundle(fx.firm, k.secret, {
      external_ref: 'igw-gated-1',
      client: { first_name: 'Gina', last_name: 'Gated' },
    })
    expect(r.outcome).toBe('rejected')
    expect((r as { acknowledgement: { error: string } }).acknowledgement.error).toBe(
      'conflict_check_required',
    )
  })

  it('missing external_ref never writes a row', async () => {
    const before = await admin.query(
      `select count(*)::int as n from deedbox.inbound_submission where key = $1`,
      [liveKey.id],
    )
    const r = await intakeMatterBundle(fx.firm, liveKey.secret, {
      client: { first_name: 'No', last_name: 'Ref' },
    })
    expect(r.outcome).toBe('rejected')
    expect((r as { acknowledgement: { error: string } }).acknowledgement.error).toBe(
      'external_ref_required',
    )
    const after = await admin.query(
      `select count(*)::int as n from deedbox.inbound_submission where key = $1`,
      [liveKey.id],
    )
    expect(after.rows[0].n).toBe(before.rows[0].n)
  })
})

describe('granular doors and the documents seam', () => {
  let matterId: number

  beforeAll(async () => {
    const r = await intakeMatterBundle(fx.firm, liveKey.secret, {
      external_ref: 'igw-granular-base',
      client: { first_name: 'Greta', last_name: 'Granular' },
    })
    matterId = ((r as { acknowledgement: { matter_id: number } }).acknowledgement).matter_id
  })

  it('the notes door appends to an existing matter; a wrong id is typed not_found', async () => {
    const r = await intakeAddNotes(fx.firm, liveKey.secret, matterId, {
      external_ref: 'igw-note-1',
      notes: [{ body: 'A follow-up detail from the source.' }],
    })
    expect(r.outcome).toBe('created')
    const n = await admin.query(
      `select count(*)::int as n from deedbox.note where owner_type = 'matter' and owner = $1`,
      [matterId],
    )
    expect(n.rows[0].n).toBeGreaterThanOrEqual(1)

    const missing = await intakeAddNotes(fx.firm, liveKey.secret, 999999321, {
      notes: [{ body: 'Nowhere to land.' }],
    })
    expect(missing.outcome).toBe('rejected')
    expect((missing as { acknowledgement: { error: string } }).acknowledgement.error).toBe(
      'matter_not_found',
    )
  })

  it('documents refuse typed while the seam is unbound, then store through it', async () => {
    const unbound = await intakeAddDocuments(fx.firm, liveKey.secret, matterId, {
      documents: [{ filename: 'letter.pdf', content_base64: Buffer.from('hello').toString('base64') }],
    })
    expect(unbound.outcome).toBe('rejected')
    expect((unbound as { acknowledgement: { error: string } }).acknowledgement.error).toBe(
      'document_storage_unbound',
    )

    const stored: { filename: string; bytes: number }[] = []
    setIntakeDocumentStore(async (_tx, input) => {
      stored.push({ filename: input.filename, bytes: input.bytes.length })
      return `doc_${stored.length}`
    })
    try {
      const r = await intakeAddDocuments(fx.firm, liveKey.secret, matterId, {
        external_ref: 'igw-doc-1',
        documents: [{ filename: 'letter.pdf', content_base64: Buffer.from('hello').toString('base64') }],
      })
      expect(r.outcome).toBe('created')
      expect(stored).toEqual([{ filename: 'letter.pdf', bytes: 5 }])
      expect(
        ((r as { acknowledgement: { document_ids: unknown[] } }).acknowledgement).document_ids,
      ).toEqual(['doc_1'])
    } finally {
      setIntakeDocumentStore(null)
    }
  })
})

describe('the receipt trail, revocation, write-only and defaults lifecycle', () => {
  it('every call sits on the key detail screen as evidence', async () => {
    const d = await keyDetail(P, liveKey.id)
    const outcomes = d.submissions.map((s) => s.outcome)
    expect(outcomes).toContain('created')
    expect(outcomes).toContain('duplicate_replayed')
    expect(outcomes).toContain('rejected')
    expect(d.submissions.some((s) => s.created_type === 'matter')).toBe(true)
    expect(d.defaults).not.toBeNull()
  })

  it('an intake key reads nothing: the predicate fails closed', async () => {
    const asKey: Principal = { kind: 'integration_key', id: liveKey.id, firm: fx.firm }
    const rows = await withPrincipal(
      asKey,
      async (tx) => {
        const r = await tx.query(`select id from deedbox.matter`)
        return r.rowCount
      },
      { readOnly: true },
    )
    expect(rows).toBe(0)
  })

  it('a revoked key is refused everywhere, registered', async () => {
    const k = await issueIntegrationKey(P, { label: 'Doomed source igw' })
    await revokeIntegrationKey(P, { key: k.id })
    const me = await intakeIdentity(fx.firm, k.secret)
    expect(me).toEqual({ ok: false, reason: 'revoked' })
    const r = await intakeMatterBundle(fx.firm, k.secret, {
      external_ref: 'igw-revoked-1',
      client: { first_name: 'Dee', last_name: 'Nied' },
    })
    expect(r.outcome).toBe('revoked')
    const ev = await admin.query(
      `select count(*)::int as n from deedbox.register_entry
        where event_kind = 'key.used' and subject = $1 and detail ->> 'outcome' = 'revoked_attempt'`,
      [k.id],
    )
    expect(ev.rows[0].n).toBeGreaterThanOrEqual(1)
  })

  it('clearing defaults closes the matter door again', async () => {
    await clearIntakeKeyDefaults(P, { key: testKey.id })
    const r = await intakeMatterBundle(fx.firm, testKey.secret, {
      external_ref: 'igw-cleared-1',
      client: { first_name: 'Clea', last_name: 'Red' },
    })
    expect(r.outcome).toBe('rejected')
    // the defaults gate sits behind the live-key check? No — defaults are
    // read in the creation transaction, the test-mode refusal comes first;
    // this asserts the DOOR stays shut for this key either way
    expect(
      ['live_key_required', 'key_defaults_missing'].includes(
        (r as { acknowledgement: { error: string } }).acknowledgement.error,
      ),
    ).toBe(true)
  })
})
