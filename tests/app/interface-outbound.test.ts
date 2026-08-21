// The interface operations (integration keys, the structurally idempotent
// inbound path, per-key activity export) and the outbound queue, its
// dispatch and artefact retrieval. Exercises invariants 31–35 and the
// test-mode containment 0022 closed.
//
// Cross-suite contract: runs after bulk-import, before matters. Flips
// intake.enabled OFF inside one test and restores it (newer row) in the
// same test; afterAll re-asserts the restore defensively. The dispatch
// tests drain other suites' queued outbound rows (they assert nothing
// afterwards); our own rows are asserted by id.

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import type { Pool } from 'pg'
import { closePool } from '@/lib/db'
import type { Principal } from '@/lib/db'
import {
  issueIntegrationKey,
  revokeIntegrationKey,
  handleInboundSubmission,
  reviewDuplicateDecision,
  exportKeyActivity,
  setKeyTemplatesRead,
  templatesList,
  templatesFetch,
} from '@/lib/ops/interface'
import { setDocumentByteFetch } from '@/lib/ops/documents/store'
import {
  queueOutboundMessage,
  dispatchOutboundQueue,
  retryOutboundMessage,
  retrieveArtefact,
} from '@/lib/ops/outbound'
import { createHash } from 'node:crypto'
import { makeAdminPool, buildFixture, setFirmSetting, type Fixture } from './helpers'

let admin: Pool
let fx: Fixture
let P: Principal
let key: { id: number; keyDisplay: string; secret: string }

function submission(
  k: { keyDisplay: string; secret: string },
  idem: string,
  payload: unknown,
  version = '1',
) {
  return handleInboundSubmission({
    keyDisplay: k.keyDisplay,
    secret: k.secret,
    idempotencyKey: idem,
    payloadVersion: version,
    payload,
    firm: fx.firm,
  })
}

const intakePayload = (name: string, phone: string, extra?: Record<string, unknown>) => ({
  kind: 'intake',
  contact_phone: phone,
  about: `enquiry from ${name}`,
  prospect: { kind: 'person', full_name: name },
  ...extra,
})

beforeAll(async () => {
  admin = makeAdminPool()
  fx = await buildFixture(admin, 'intf')
  P = { kind: 'staff', id: fx.staff, firm: fx.firm }
  key = await issueIntegrationKey(P, { label: 'Website intf' })
})

afterAll(async () => {
  await setFirmSetting(admin, 'intake.enabled', true, 1)
  await closePool()
  await admin.end()
})

describe('integration keys', () => {
  it('issues a key: secret shown once, only its hash stored, registered privileged', async () => {
    expect(key.secret.length).toBeGreaterThan(20)
    const row = await admin.query(
      `select secret_hash, key_display from deedbox.integration_key where id = $1`,
      [key.id],
    )
    expect(row.rows[0].secret_hash).toBe(createHash('sha256').update(key.secret).digest('hex'))
    expect(row.rows[0].secret_hash).not.toBe(key.secret)
    expect(row.rows[0].key_display).toBe(key.keyDisplay)
    const evt = await admin.query(
      `select privileged from deedbox.register_entry
        where event_kind = 'key.issued' and subject = $1`,
      [key.id],
    )
    expect(evt.rows[0].privileged).toBe(true)
  })

  it('revocation is immediate and registered; the attempt leaves no submission row', async () => {
    const dead = await issueIntegrationKey(P, { label: 'Doomed intf' })
    await revokeIntegrationKey(P, { key: dead.id })
    const evt = await admin.query(
      `select privileged from deedbox.register_entry
        where event_kind = 'key.revoked' and subject = $1`,
      [dead.id],
    )
    expect(evt.rows[0].privileged).toBe(true)
    const r = await submission(dead, 'revoked-1', intakePayload('Riva Revoked', '0400900001'))
    expect(r.outcome).toBe('revoked')
    const subs = await admin.query(
      `select count(*)::int as n from deedbox.inbound_submission where key = $1`,
      [dead.id],
    )
    expect(subs.rows[0].n).toBe(0)
    const used = await admin.query(
      `select count(*)::int as n from deedbox.register_entry
        where event_kind = 'key.used' and subject = $1
          and detail ->> 'outcome' = 'revoked_attempt'`,
      [dead.id],
    )
    expect(used.rows[0].n).toBe(1)
  })
})

describe('inbound submissions', () => {
  it('creates an intake record and prospect through the ordinary domain path', async () => {
    const r = await submission(key, 'idem-1', intakePayload('Ivy Interface', '0400900100'))
    expect(r.outcome).toBe('created')
    if (r.outcome !== 'created') return
    const sub = await admin.query(
      `select outcome, created_type, created, test from deedbox.inbound_submission where id = $1`,
      [r.submission],
    )
    expect(sub.rows[0].created_type).toBe('intake_record')
    expect(sub.rows[0].test).toBe(false)
    const intake = await admin.query(
      `select prospect_party, source_integration_key, test_flag from deedbox.intake_record where id = $1`,
      [sub.rows[0].created],
    )
    expect(intake.rows[0].source_integration_key).toBe(key.id)
    expect(intake.rows[0].test_flag).toBe(false)
    const used = await admin.query(
      `select count(*)::int as n from deedbox.register_entry
        where event_kind = 'key.used' and subject = $1 and detail ->> 'outcome' = 'created'`,
      [key.id],
    )
    expect(used.rows[0].n).toBe(1)
  })

  it('replays are byte-identical from the store and create nothing', async () => {
    const first = await submission(key, 'idem-1', intakePayload('Ivy Interface', '0400900100'))
    expect(first.outcome).toBe('duplicate_replayed')
    if (first.outcome !== 'duplicate_replayed') return
    const original = await admin.query(
      `select id, acknowledgement from deedbox.inbound_submission
        where key = $1 and idempotency_key = 'idem-1' and outcome = 'created'`,
      [key.id],
    )
    expect(JSON.stringify(first.acknowledgement)).toBe(
      JSON.stringify(original.rows[0].acknowledgement),
    )
    const replayRow = await admin.query(
      `select original, outcome from deedbox.inbound_submission where id = $1`,
      [first.submission],
    )
    expect(replayRow.rows[0].outcome).toBe('duplicate_replayed')
    expect(replayRow.rows[0].original).toBe(original.rows[0].id)
    const intakes = await admin.query(
      `select count(*)::int as n from deedbox.intake_record where contact_phone = '0400900100'`,
    )
    expect(intakes.rows[0].n).toBe(1) // one business record, ever
  })

  it('rejects unknown payload versions and malformed payloads with evidenced rows', async () => {
    const v = await submission(key, 'idem-v9', intakePayload('Vera Version', '0400900200'), '9')
    expect(v.outcome).toBe('rejected')
    const s = await submission(key, 'idem-schema', { kind: 'intake', about: 'no phone' })
    expect(s.outcome).toBe('rejected')
    const m = await submission(key, 'idem-matter', { kind: 'matter', title: 'Direct matter' })
    expect(m.outcome).toBe('rejected')
    const reasons = await admin.query(
      `select rejection_reason from deedbox.inbound_submission
        where key = $1 and outcome = 'rejected' order by id`,
      [key.id],
    )
    const all = reasons.rows.map((r) => r.rejection_reason as string).join(' | ')
    expect(all).toMatch(/unsupported_payload_version/)
    expect(all).toMatch(/schema_validation_failed/)
    expect(all).toMatch(/matter_creation_not_supported/)
  })

  it('refuses with a documented code while intake is disabled', async () => {
    await setFirmSetting(admin, 'intake.enabled', false, 10)
    try {
      const r = await submission(key, 'idem-disabled', intakePayload('Dana Disabled', '0400900300'))
      expect(r.outcome).toBe('rejected')
      if (r.outcome !== 'rejected') return
      expect(JSON.stringify(r.acknowledgement)).toMatch(/intake_disabled/)
    } finally {
      await setFirmSetting(admin, 'intake.enabled', true, 5)
    }
  })

  it('rate limits without writing submission rows, one aggregated register event (flood resistance)', async () => {
    const limited = await issueIntegrationKey(P, {
      label: 'Limited intf',
      rateLimit: { per_minute: 2, per_day: 5000 },
    })
    const a = await submission(limited, 'lim-1', intakePayload('Lena Limit One', '0400900401'))
    const b = await submission(limited, 'lim-2', intakePayload('Lena Limit Two', '0400900402'))
    expect(a.outcome).toBe('created')
    expect(b.outcome).toBe('created')
    const c = await submission(limited, 'lim-3', intakePayload('Lena Limit Three', '0400900403'))
    const d = await submission(limited, 'lim-4', intakePayload('Lena Limit Four', '0400900404'))
    expect(c.outcome).toBe('rate_limited')
    expect(d.outcome).toBe('rate_limited')
    const subs = await admin.query(
      `select count(*)::int as n from deedbox.inbound_submission where key = $1`,
      [limited.id],
    )
    expect(subs.rows[0].n).toBe(2) // over-limit requests write NO submission row
    const events = await admin.query(
      `select count(*)::int as n from deedbox.register_entry
        where event_kind = 'key.used' and subject = $1 and detail ->> 'outcome' = 'rate_limited'`,
      [limited.id],
    )
    // one aggregated event per limiting episode (two only if the two
    // throttled calls straddled a minute boundary)
    expect(events.rows[0].n).toBeGreaterThanOrEqual(1)
    expect(events.rows[0].n).toBeLessThanOrEqual(2)
  })

  it('defers duplicate decisions to staff review, never auto-merging', async () => {
    const party = await admin.query(
      `insert into deedbox.party (kind, display_name) values ('person', 'Norma Dupe') returning id`,
    )
    await admin.query(
      `insert into deedbox.party_name (party, name_kind, full_name) values ($1, 'current', 'Norma Dupe')`,
      [party.rows[0].id],
    )
    await admin.query(
      `insert into deedbox.contact_point (party, kind, value, is_primary)
       values ($1, 'phone', '0400900500', true)`,
      [party.rows[0].id],
    )
    const r = await submission(key, 'idem-dupe', intakePayload('Norma Dupe', '0400900500'))
    expect(r.outcome).toBe('created')
    const decision = await admin.query(
      `select d.id, d.decision_mode, d.decided_by_kind, d.reviewed_at, d.candidates_shown
         from deedbox.duplicate_decision d
        where d.decision_mode = 'integration_deferred' and d.decided_by = $1 and not d.test
        order by d.id desc limit 1`,
      [key.id],
    )
    expect(decision.rowCount).toBe(1)
    expect(decision.rows[0].decided_by_kind).toBe('integration_key')
    expect(decision.rows[0].reviewed_at).toBeNull()
    expect(JSON.stringify(decision.rows[0].candidates_shown)).toContain(String(party.rows[0].id))
    // a second party row was created verbatim — never merged
    const parties = await admin.query(
      `select count(*)::int as n from deedbox.party where display_name = 'Norma Dupe'`,
    )
    expect(parties.rows[0].n).toBe(2)
    await reviewDuplicateDecision(P, { decision: decision.rows[0].id as number })
    const reviewed = await admin.query(
      `select reviewed_by from deedbox.duplicate_decision where id = $1`,
      [decision.rows[0].id],
    )
    expect(reviewed.rows[0].reviewed_by).toBe(fx.staff)
  })

  it('contains test-key records off every business surface (0022)', async () => {
    const testKey = await issueIntegrationKey(P, { label: 'Test-mode intf', testMode: true })
    const r = await submission(testKey, 'test-1', intakePayload('Norma Dupe', '0400900500'))
    expect(r.outcome).toBe('created')
    if (r.outcome !== 'created') return
    const sub = await admin.query(
      `select created, test from deedbox.inbound_submission where id = $1`,
      [r.submission],
    )
    expect(sub.rows[0].test).toBe(true)
    const intake = await admin.query(
      `select prospect_party, test_flag from deedbox.intake_record where id = $1`,
      [sub.rows[0].created],
    )
    expect(intake.rows[0].test_flag).toBe(true)
    const testParty = intake.rows[0].prospect_party as number
    const party = await admin.query(`select test from deedbox.party where id = $1`, [testParty])
    expect(party.rows[0].test).toBe(true)
    // search: the test party's name is not indexed
    const inSearch = await admin.query(
      `select count(*)::int as n from deedbox.search_index si
        join deedbox.party_name pn on pn.id = si.source and si.entry_type = 'party'
       where pn.party = $1`,
      [testParty],
    )
    expect(inSearch.rows[0].n).toBe(0)
    // the duplicate dialog: candidates for the same name exclude the test party
    const candidates = await admin.query(
      `select array_agg(party) as ids from deedbox.duplicate_candidates('Norma Dupe', '0400900500', null)`,
    )
    const ids: number[] = candidates.rows[0].ids ?? []
    expect(ids).not.toContain(testParty)
    expect(ids.length).toBeGreaterThanOrEqual(1)
    // the review queue: the test decision is not in the business queue
    const queue = await admin.query(
      `select count(*)::int as n from deedbox.duplicate_decision
        where decision_mode = 'integration_deferred' and reviewed_at is null
          and not test and decided_by = $1`,
      [testKey.id],
    )
    expect(queue.rows[0].n).toBe(0)
    // the register keeps the evidence
    const evt = await admin.query(
      `select count(*)::int as n from deedbox.register_entry
        where event_kind = 'record.created' and subject_type = 'party' and subject = $1`,
      [testParty],
    )
    expect(evt.rows[0].n).toBe(1)
    // the flag can never flip
    await expect(
      admin.query(`update deedbox.party set test = false where id = $1`, [testParty]),
    ).rejects.toThrow(/never changes/)
  })

  it('sender extras land only as custom-field values; unknown keys reject', async () => {
    await admin.query(
      `insert into deedbox.custom_field_definition (scope, key, label, data_type)
       values ('intake', 'intf_referrer', 'Referrer', 'text')`,
    )
    const ok = await submission(key, 'idem-extras', {
      ...intakePayload('Xena Extras', '0400900600'),
      extras: { intf_referrer: 'Google Ads' },
    })
    expect(ok.outcome).toBe('created')
    if (ok.outcome !== 'created') return
    const sub = await admin.query(
      `select created from deedbox.inbound_submission where id = $1`,
      [ok.submission],
    )
    const value = await admin.query(
      `select v.text_value from deedbox.custom_field_value v
        join deedbox.custom_field_definition d on d.id = v.definition
       where v.owner_type = 'intake_record' and v.owner = $1 and d.key = 'intf_referrer'`,
      [sub.rows[0].created],
    )
    expect(value.rows[0].text_value).toBe('Google Ads')

    const bad = await submission(key, 'idem-unknown-extra', {
      ...intakePayload('Yves Unknown', '0400900700'),
      extras: { estimated_budget: '5000' },
    })
    expect(bad.outcome).toBe('rejected')
    if (bad.outcome !== 'rejected') return
    expect(JSON.stringify(bad.acknowledgement)).toMatch(/unknown_custom_field/)
  })

  it('exports per-key activity as a registered privileged artefact', async () => {
    const r = await exportKeyActivity(P, { key: key.id })
    expect(r.rows).toBeGreaterThan(0)
    const evt = await admin.query(
      `select privileged, artefact from deedbox.register_entry
        where event_kind = 'export.performed' and subject_type = 'key_activity_export' and subject = $1`,
      [r.artefact],
    )
    expect(evt.rows[0].privileged).toBe(true)
    expect(evt.rows[0].artefact).toBe(String(r.artefact))
    const art = await admin.query(
      `select content_ref from deedbox.stored_artefact where id = $1`,
      [r.artefact],
    )
    expect(art.rows[0].content_ref).toMatch(/^section,at,outcome/)
  })
})

describe('outbound queue', () => {
  let queued: { message: number; artefact: number }

  it('the exact rendered copy exists before anything is sent', async () => {
    queued = await queueOutboundMessage(P, {
      channel: 'email',
      recipient: 'client@example.test',
      purpose: 'general_notice',
      content: 'Hello Exact Copy intf 123',
      relatedType: 'matter',
      related: fx.matter,
    })
    const art = await admin.query(
      `select content_ref from deedbox.stored_artefact where id = $1`,
      [queued.artefact],
    )
    expect(art.rows[0].content_ref).toBe('Hello Exact Copy intf 123')
    const row = await admin.query(
      `select state, rendered_artefact from deedbox.outbound_message where id = $1`,
      [queued.message],
    )
    expect(row.rows[0].state).toBe('queued')
    expect(row.rows[0].rendered_artefact).toBe(String(queued.artefact))
  })

  it('dispatch marks failed terminally; a retry is a new row; state never rewinds', async () => {
    const job: Principal = { kind: 'system_job', id: 1, firm: fx.firm }
    // drain the queue: our copy fails, everything else (other suites' rows) sends
    await dispatchOutboundQueue(
      job,
      async (m) => {
        if (m.content.includes('Exact Copy intf')) throw new Error('SMTP down (test)')
      },
      { limit: 500 },
    )
    const failed = await admin.query(
      `select state, failed_reason from deedbox.outbound_message where id = $1`,
      [queued.message],
    )
    expect(failed.rows[0].state).toBe('failed')
    expect(failed.rows[0].failed_reason).toMatch(/SMTP down/)

    const retry = await retryOutboundMessage(P, { message: queued.message })
    const retryRow = await admin.query(
      `select state, retry_of, rendered_artefact from deedbox.outbound_message where id = $1`,
      [retry.message],
    )
    expect(retryRow.rows[0].retry_of).toBe(queued.message)
    expect(retryRow.rows[0].rendered_artefact).toBe(String(queued.artefact))

    await dispatchOutboundQueue(job, async () => {}, { limit: 500 })
    const sent = await admin.query(
      `select state, sent_at from deedbox.outbound_message where id = $1`,
      [retry.message],
    )
    expect(sent.rows[0].state).toBe('sent')
    expect(sent.rows[0].sent_at).not.toBeNull()
    // terminal states are immutable — no rewind exists
    await expect(
      admin.query(`update deedbox.outbound_message set state = 'queued' where id = $1`, [
        retry.message,
      ]),
    ).rejects.toThrow(/immutable/)
    const original = await admin.query(
      `select state from deedbox.outbound_message where id = $1`,
      [queued.message],
    )
    expect(original.rows[0].state).toBe('failed') // the retry never rewrote it
  })

  it('retrieves the artefact gated by the owning record', async () => {
    const r = await retrieveArtefact(P, { artefact: queued.artefact })
    expect(r.content).toBe('Hello Exact Copy intf 123')
    expect(r.kind).toBe('outbound_rendering')
  })
})

describe('the templates read door (0062) — per-key opt-in, templates only', () => {
  const docxBytes = Buffer.from('PK fake-docx bytes for the round trip test')
  let readKey: { id: number; keyDisplay: string; secret: string }
  let activeTemplate: number
  let inactiveTemplate: number

  beforeAll(async () => {
    readKey = await issueIntegrationKey(P, { label: 'Reader intf' })
    const t1 = await admin.query(
      `insert into deedbox.document_template
         (name, category, filename, storage_ref, size_bytes, active, created_by)
       values ('Intf Cost Agreement', 'Costs', 'intf-ca.docx', 'intf-tpl-active', $1, true, $2)
       returning id`,
      [docxBytes.length, fx.staff],
    )
    activeTemplate = t1.rows[0].id as number
    const t2 = await admin.query(
      `insert into deedbox.document_template
         (name, category, filename, storage_ref, size_bytes, active, created_by)
       values ('Intf Dormant', 'Costs', 'intf-dormant.docx', 'intf-tpl-inactive', 10, false, $1)
       returning id`,
      [fx.staff],
    )
    inactiveTemplate = t2.rows[0].id as number
  })

  it('a key without the switch is refused typed, with evidence; flipping is registered', async () => {
    const refused = await templatesList(fx.firm, readKey.secret)
    expect(refused.outcome).toBe('not_enabled')
    const refusalEvidence = await admin.query(
      `select 1 from deedbox.register_entry
        where event_kind = 'key.used' and subject_type = 'integration_key' and subject = $1
          and detail ->> 'door' = 'templates'
          and detail ->> 'outcome' = 'templates_read_not_enabled'`,
      [readKey.id],
    )
    expect(refusalEvidence.rowCount).toBe(1)

    await setKeyTemplatesRead(P, { key: readKey.id, enabled: true })
    const flip = await admin.query(
      `select privileged, detail from deedbox.register_entry
        where event_kind = 'record.changed' and subject_type = 'integration_key' and subject = $1
          and detail -> 'after' ->> 'templates_read' = 'true'`,
      [readKey.id],
    )
    expect(flip.rowCount).toBe(1)
    expect(flip.rows[0].privileged).toBe(true)
    expect(flip.rows[0].detail.before.templates_read).toBe(false)
  })

  it('list names active templates with the declared grammar; fetch round-trips the bytes; both are evidenced', async () => {
    setDocumentByteFetch(async (storageRef) => {
      if (storageRef !== 'intf-tpl-active') throw new Error(`unexpected storage ref ${storageRef}`)
      return { bytes: docxBytes, contentType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' }
    })
    try {
      const list = await templatesList(fx.firm, readKey.secret)
      expect(list.outcome).toBe('ok')
      if (list.outcome !== 'ok') return
      const mine = list.result.templates.find((t) => t.id === activeTemplate)
      expect(mine).toBeDefined()
      expect(mine!.name).toBe('Intf Cost Agreement')
      expect(mine!.filename).toBe('intf-ca.docx')
      expect(mine!.merge_grammar).toBe('double_angle_dotted')
      expect(mine!.merge_delimiters).toEqual({ start: '<<', end: '>>' })
      // the dormant template never appears
      expect(list.result.templates.find((t) => t.id === inactiveTemplate)).toBeUndefined()

      const fetched = await templatesFetch(fx.firm, readKey.secret, activeTemplate)
      expect(fetched.outcome).toBe('ok')
      if (fetched.outcome !== 'ok') return
      expect(Buffer.from(fetched.result.file_base64, 'base64').equals(docxBytes)).toBe(true)
      expect(fetched.result.filename).toBe('intf-ca.docx')
      expect(fetched.result.size_bytes).toBe(docxBytes.length)

      const evidence = await admin.query(
        `select detail ->> 'outcome' as o from deedbox.register_entry
          where event_kind = 'key.used' and subject_type = 'integration_key' and subject = $1
            and detail ->> 'door' = 'templates'
            and detail ->> 'outcome' in ('list', 'fetch')`,
        [readKey.id],
      )
      const outcomes = evidence.rows.map((r) => r.o)
      expect(outcomes).toContain('list')
      expect(outcomes).toContain('fetch')
      const lastUsed = await admin.query(
        `select last_used_at from deedbox.integration_key where id = $1`,
        [readKey.id],
      )
      expect(lastUsed.rows[0].last_used_at).not.toBeNull()
    } finally {
      setDocumentByteFetch(null)
    }
  })

  it('the door serves templates and nothing else: dormant refused, foreign ids refused, wrong secrets refused', async () => {
    // an inactive template is outside the door even with the switch on
    const dormant = await templatesFetch(fx.firm, readKey.secret, inactiveTemplate)
    expect(dormant.outcome).toBe('not_found')
    // an id from any other record family finds nothing — the fetch reads
    // ONLY the template registry (probe with an id no template carries)
    const foreign = await templatesFetch(fx.firm, readKey.secret, 99999901)
    expect(foreign.outcome).toBe('not_found')
    // a wrong secret never gets as far as the switch
    const stranger = await templatesList(fx.firm, 'not-a-real-secret')
    expect(stranger.outcome).toBe('unauthenticated')
  })

  it('a revoked key is refused with evidence even with the switch on', async () => {
    const doomed = await issueIntegrationKey(P, { label: 'Doomed reader intf' })
    await setKeyTemplatesRead(P, { key: doomed.id, enabled: true })
    await revokeIntegrationKey(P, { key: doomed.id })
    const r = await templatesList(fx.firm, doomed.secret)
    expect(r.outcome).toBe('revoked')
    const evidence = await admin.query(
      `select 1 from deedbox.register_entry
        where event_kind = 'key.used' and subject_type = 'integration_key' and subject = $1
          and detail ->> 'door' = 'templates' and detail ->> 'outcome' = 'revoked_attempt'`,
      [doomed.id],
    )
    expect(evidence.rowCount).toBe(1)
  })
})
