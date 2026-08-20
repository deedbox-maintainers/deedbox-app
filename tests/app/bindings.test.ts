// The deployment bindings: the email transport behind the outbound seam,
// the hosted sign-in service behind the auth seam, and the hosted-storage
// document store (with its 0028 landing table) behind the intake API's
// document seam — plus bindFromEnvironment, the one boot-time wiring point.
//
// Cross-suite contract: runs after billing-*, before bulk-import. The
// dispatch test drains other suites' queued outbound rows through its
// recording transport (the interface-outbound precedent — nothing asserts
// on them afterwards); our own rows are asserted by id. Every seam this
// suite binds is unbound again in finally/afterAll — later suites (config,
// intake-api, jobs) prove the UNBOUND refusals and must find the seams
// clear. No firm settings are flipped.

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import type { Pool } from 'pg'
import { closePool, withPrincipal } from '@/lib/db'
import type { Principal } from '@/lib/db'
import { queueOutboundMessage, dispatchOutboundQueue } from '@/lib/ops/outbound'
import { setOutboundTransport } from '@/lib/jobs/registry'
import { setSignInService } from '@/lib/auth/seam'
import {
  issueIntegrationKey,
  setIntakeKeyDefaults,
  setIntakeDocumentStore,
  intakeMatterBundle,
  intakeAddDocuments,
  INTAKE_API_SYSTEM_ACTOR,
} from '@/lib/ops/interface'
import { establishStaffSession } from '@/lib/ops/security'
import {
  emailTransport,
  hostedSignInService,
  hostedDocumentStore,
  bindFromEnvironment,
  type HttpPost,
  type HttpPut,
} from '@/lib/bindings'
import { makeAdminPool, buildFixture, type Fixture } from './helpers'

let admin: Pool
let fx: Fixture
let P: Principal

interface PostCall {
  url: string
  headers: Record<string, string>
  body: string
}

function recordingPost(status = 200, text = '{}'): { post: HttpPost; calls: PostCall[] } {
  const calls: PostCall[] = []
  return {
    calls,
    post: async (url, headers, body) => {
      calls.push({ url, headers, body })
      return { status, text }
    },
  }
}

interface PutCall {
  url: string
  headers: Record<string, string>
  bytes: number
}

function recordingPut(status = 200): { put: HttpPut; calls: PutCall[] } {
  const calls: PutCall[] = []
  return {
    calls,
    put: async (url, headers, body) => {
      calls.push({ url, headers, bytes: body.length })
      return { status, text: status === 200 ? '{}' : 'storage says no' }
    },
  }
}

beforeAll(async () => {
  admin = makeAdminPool()
  fx = await buildFixture(admin, 'bnd')
  P = { kind: 'staff', id: fx.staff, firm: fx.firm }
})

afterAll(async () => {
  // later suites prove the unbound refusals — leave every seam clear
  setOutboundTransport(null)
  setSignInService(null)
  setIntakeDocumentStore(null)
  await closePool()
  await admin.end()
})

// ---------------------------------------------------------------------------
// The email transport.
// ---------------------------------------------------------------------------

describe('the email transport', () => {
  const base = {
    apiKey: 'key-under-test',
    from: 'Test Firm <no-reply@firm.test>',
    endpoint: 'https://mail.test/send',
  }

  it('sends a finished text rendering as-is, subject mapped from the purpose', async () => {
    const { post, calls } = recordingPost()
    await emailTransport({ ...base, post })({
      id: 1,
      channel: 'email',
      recipient: 'someone@example.test',
      content: 'Security alert (signin_failures): 4 failures against one login',
      purpose: 'anomaly_alert',
      contentType: 'text/plain',
    })
    expect(calls).toHaveLength(1)
    expect(calls[0].url).toBe('https://mail.test/send')
    expect(calls[0].headers.Authorization).toBe('Bearer key-under-test')
    const sent = JSON.parse(calls[0].body)
    expect(sent).toEqual({
      from: 'Test Firm <no-reply@firm.test>',
      to: ['someone@example.test'],
      subject: 'Security alert',
      text: 'Security alert (signin_failures): 4 failures against one login',
    })
  })

  it('wraps a bare named reference in an honest pointer message', async () => {
    const { post, calls } = recordingPost()
    await emailTransport({ ...base, post })({
      id: 2,
      channel: 'email',
      recipient: 'lawyer@example.test',
      content: 'top-up-000042',
      purpose: 'top_up_alert',
      contentType: null,
    })
    const sent = JSON.parse(calls[0].body)
    expect(sent.subject).toBe('A matter needs funds topped up')
    expect(sent.text).toContain('Reference: top-up-000042')
  })

  it('humanises an unmapped purpose into a subject', async () => {
    const { post, calls } = recordingPost()
    await emailTransport({ ...base, post })({
      id: 3,
      channel: 'email',
      recipient: 'x@example.test',
      content: 'plain words',
      purpose: 'welcome_pack',
      contentType: 'text/plain',
    })
    expect(JSON.parse(calls[0].body).subject).toBe('Welcome pack')
  })

  it('refuses an unpresented data rendering typed — a client never receives a data document', async () => {
    const { post, calls } = recordingPost()
    await expect(
      emailTransport({ ...base, post })({
        id: 4,
        channel: 'email',
        recipient: 'client@example.test',
        content: '{"batch": 12}',
        purpose: 'migration_summary',
        contentType: 'application/json',
      }),
    ).rejects.toThrow(/presentation_pending/)
    expect(calls).toHaveLength(0)
  })

  it('refuses a text-message row typed — no such transport is bound', async () => {
    const { post, calls } = recordingPost()
    await expect(
      emailTransport({ ...base, post })({
        id: 5,
        channel: 'text_message',
        recipient: '+61400000000',
        content: 'sms body',
        purpose: 'general_notice',
        contentType: 'text/plain',
      }),
    ).rejects.toThrow(/channel_unsupported/)
    expect(calls).toHaveLength(0)
  })

  it('surfaces a mail API failure with its status', async () => {
    const { post } = recordingPost(500, 'upstream broke')
    await expect(
      emailTransport({ ...base, post })({
        id: 6,
        channel: 'email',
        recipient: 'x@example.test',
        content: 'body',
        purpose: 'general_notice',
        contentType: 'text/plain',
      }),
    ).rejects.toThrow(/mail_api_error: HTTP 500/)
  })
})

// ---------------------------------------------------------------------------
// Dispatch through the real transport (the queue's honesty end-to-end).
// ---------------------------------------------------------------------------

describe('dispatch through the real transport', () => {
  it('sends what is sendable and fails the rest typed, row by row', async () => {
    const text = await queueOutboundMessage(P, {
      channel: 'email',
      recipient: 'bnd-text@example.test',
      purpose: 'general_notice',
      content: 'a finished message',
    })
    const json = await queueOutboundMessage(P, {
      channel: 'email',
      recipient: 'bnd-json@example.test',
      purpose: 'bill_despatch',
      content: '{"bill": 99}',
      contentType: 'application/json',
    })
    const sms = await queueOutboundMessage(P, {
      channel: 'text_message',
      recipient: '+61400000099',
      purpose: 'general_notice',
      content: 'sms body',
    })
    const ref = await admin.query(
      `insert into deedbox.outbound_message (channel, recipient, rendered_artefact, purpose)
       values ('email', 'bnd-ref@example.test', 'top-up-000042', 'top_up_alert') returning id`,
    )
    const refId = ref.rows[0].id as number

    const { post, calls } = recordingPost()
    const transport = emailTransport({
      apiKey: 'dispatch-key',
      from: 'Test Firm <no-reply@firm.test>',
      endpoint: 'https://mail.test/send',
      post,
    })
    setOutboundTransport(transport)
    try {
      // drains whatever earlier suites left queued (asserted by nobody);
      // our four rows are asserted by id below
      const outcome = await dispatchOutboundQueue(P, transport, { limit: 500 })
      expect(outcome.sent).toBeGreaterThanOrEqual(2)
      expect(outcome.failed).toBeGreaterThanOrEqual(2)
    } finally {
      setOutboundTransport(null)
    }

    const states = await admin.query(
      `select id, state, failed_reason from deedbox.outbound_message where id = any($1::bigint[])`,
      [[text.message, json.message, sms.message, refId]],
    )
    const byId = new Map(states.rows.map((r) => [r.id as number, r]))
    expect(byId.get(text.message)!.state).toBe('sent')
    expect(byId.get(refId)!.state).toBe('sent')
    expect(byId.get(json.message)!.state).toBe('failed')
    // bill_despatch now HAS a presenter, so with no converter
    // bound the row fails one step later — still typed, still unsent
    expect(byId.get(json.message)!.failed_reason).toMatch(/converter_not_configured/)
    expect(byId.get(sms.message)!.state).toBe('failed')
    expect(byId.get(sms.message)!.failed_reason).toMatch(/channel_unsupported/)

    const mine = calls.map((c) => JSON.parse(c.body) as { to: string[]; text: string; subject: string })
    const toText = mine.find((m) => m.to[0] === 'bnd-text@example.test')
    expect(toText?.text).toBe('a finished message')
    const toRef = mine.find((m) => m.to[0] === 'bnd-ref@example.test')
    expect(toRef?.text).toContain('Reference: top-up-000042')
    expect(mine.some((m) => m.to[0] === 'bnd-json@example.test')).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// The hosted sign-in service.
// ---------------------------------------------------------------------------

describe('the hosted sign-in service', () => {
  const cfgOf = (post: HttpPost) => ({
    url: 'https://platform.test/',
    apiKey: 'anon-key-1',
    firm: 0, // overwritten per test where the database is touched
    post,
  })

  it('authenticates a person through the token grant, factors honest', async () => {
    const { post, calls } = recordingPost(200, JSON.stringify({ user: { factors: [] } }))
    const svc = hostedSignInService({ ...cfgOf(post), firm: fx.firm })
    const verdict = await svc.authenticate('pat.bnd', 'right-horse-battery')
    expect(verdict).toEqual({ authenticated: true, mfaSatisfied: true })
    expect(calls).toHaveLength(1)
    expect(calls[0].url).toBe('https://platform.test/auth/v1/token?grant_type=password')
    expect(calls[0].headers.apikey).toBe('anon-key-1')
    expect(JSON.parse(calls[0].body)).toEqual({ email: 'pat.bnd', password: 'right-horse-battery' })
  })

  it('reports an enrolled verified factor as unsatisfied by a bare password', async () => {
    const { post } = recordingPost(
      200,
      JSON.stringify({ user: { factors: [{ status: 'verified' }] } }),
    )
    const svc = hostedSignInService({ ...cfgOf(post), firm: fx.firm })
    const verdict = await svc.authenticate('pat.bnd', 'right-horse-battery')
    expect(verdict).toEqual({ authenticated: true, mfaSatisfied: false })
  })

  it('refuses wrong credentials without a word more', async () => {
    const { post } = recordingPost(400, JSON.stringify({ error_code: 'invalid_credentials' }))
    const svc = hostedSignInService({ ...cfgOf(post), firm: fx.firm })
    const verdict = await svc.authenticate('pat.bnd', 'wrong')
    expect(verdict).toEqual({ authenticated: false, mfaSatisfied: false })
  })

  it('surfaces a service outage typed, never as a silent refusal', async () => {
    const { post } = recordingPost(503, 'down')
    const svc = hostedSignInService({ ...cfgOf(post), firm: fx.firm })
    await expect(svc.authenticate('pat.bnd', 'anything')).rejects.toMatchObject({
      code: 'sign_in_unavailable',
    })
  })

  it('step-up re-verifies the session owner’s own login (provider re-authentication)', async () => {
    const outcome = await establishStaffSession({
      login: 'pat.bnd',
      firm: fx.firm,
      mfaSatisfied: true,
      device: { fingerprint: 'bndbndbndbndbndbndbndbndbndbnd01', label: 'bindings suite' },
    })

    const { post, calls } = recordingPost(200, JSON.stringify({ user: { factors: [] } }))
    const svc = hostedSignInService({ ...cfgOf(post), firm: fx.firm })
    expect(await svc.verifyStepUpChallenge(outcome.session, 'the-right-password')).toBe(true)
    expect(JSON.parse(calls[0].body).email).toBe('pat.bnd')

    const bad = recordingPost(400, '{}')
    const svcBad = hostedSignInService({ ...cfgOf(bad.post), firm: fx.firm })
    expect(await svcBad.verifyStepUpChallenge(outcome.session, 'a-wrong-password')).toBe(false)

    // an unknown or dead session never reaches the service
    const untouched = recordingPost()
    const svcNone = hostedSignInService({ ...cfgOf(untouched.post), firm: fx.firm })
    expect(await svcNone.verifyStepUpChallenge(999999999, 'whatever')).toBe(false)
    expect(await svcNone.verifyStepUpChallenge(outcome.session, '')).toBe(false)
    expect(untouched.calls).toHaveLength(0)
  })
})

// ---------------------------------------------------------------------------
// The hosted document store (0028 landing table + hosted storage bytes).
// ---------------------------------------------------------------------------

describe('the hosted document store', () => {
  let key: { id: number; keyDisplay: string; secret: string }
  let matterId: number

  beforeAll(async () => {
    key = await issueIntegrationKey(P, { label: 'bindings door key' })
    await setIntakeKeyDefaults(P, {
      key: key.id,
      office: fx.office,
      responsibleLawyer: fx.staff,
      practiceArea: fx.practiceArea,
    })
  })

  it('the bundle door lands bytes, the landing row, the register entry and an honest acknowledgement', async () => {
    const { put, calls } = recordingPut()
    setIntakeDocumentStore(
      hostedDocumentStore({
        url: 'https://platform.test/',
        serviceKey: 'service-key-1',
        bucket: 'bnd-bucket',
        put,
      }),
    )
    try {
      const r = await intakeMatterBundle(fx.firm, key.secret, {
        external_ref: 'bnd-doc-1',
        client: { first_name: 'Bindy', last_name: 'Docs' },
        matter: { summary: 'bindings suite bundle' },
        documents: [
          {
            filename: 'Letter of Advice #1.pdf',
            content_base64: Buffer.from('hello world').toString('base64'),
          },
        ],
      })
      expect(r.outcome).toBe('created')
      const ack = (r as { acknowledgement: { matter_id: number; document_ids: unknown[] } })
        .acknowledgement
      matterId = ack.matter_id
      expect(ack.document_ids).toHaveLength(1)
      const docId = ack.document_ids[0]
      expect(typeof docId).toBe('number')

      const row = await admin.query(`select * from deedbox.document_file where id = $1`, [docId])
      expect(row.rowCount).toBe(1)
      const d = row.rows[0]
      expect(d.matter).toBe(matterId)
      expect(d.filename).toBe('Letter of Advice #1.pdf')
      expect(d.content_type).toBe('application/pdf')
      expect(Number(d.size_bytes)).toBe(11)
      expect(d.source).toBe('intake_api')
      expect(d.integration_key).toBe(key.id)
      expect(d.external_ref).toBe('bnd-doc-1')
      expect(d.storage_ref).toMatch(new RegExp(`^${matterId}/[0-9a-f-]{36}-Letter_of_Advice__1\\.pdf$`))

      expect(calls).toHaveLength(1)
      expect(calls[0].url).toBe(
        `https://platform.test/storage/v1/object/bnd-bucket/${d.storage_ref}`,
      )
      expect(calls[0].headers.Authorization).toBe('Bearer service-key-1')
      expect(calls[0].headers['x-upsert']).toBe('false')
      expect(calls[0].headers['Content-Type']).toBe('application/pdf')
      expect(calls[0].bytes).toBe(11)

      const reg = await admin.query(
        `select event_kind, matter, actor_kind, actor, detail
           from deedbox.register_entry
          where subject_type = 'document_file' and subject = $1`,
        [docId],
      )
      expect(reg.rowCount).toBe(1)
      expect(reg.rows[0].event_kind).toBe('record.created')
      expect(reg.rows[0].matter).toBe(matterId)
      expect(reg.rows[0].actor_kind).toBe('system_job')
      expect(reg.rows[0].actor).toBe(INTAKE_API_SYSTEM_ACTOR)
      expect(reg.rows[0].detail.filename).toBe('Letter of Advice #1.pdf')
    } finally {
      setIntakeDocumentStore(null)
    }
  })

  it('the granular door lands on an existing matter the same way', async () => {
    const { put, calls } = recordingPut()
    setIntakeDocumentStore(
      hostedDocumentStore({
        url: 'https://platform.test',
        serviceKey: 'service-key-1',
        put, // default bucket
      }),
    )
    try {
      const r = await intakeAddDocuments(fx.firm, key.secret, matterId, {
        external_ref: 'bnd-doc-2',
        documents: [
          { filename: 'file note.txt', content_base64: Buffer.from('a note').toString('base64') },
        ],
      })
      expect(r.outcome).toBe('created')
      const ids = (r as { acknowledgement: { document_ids: number[] } }).acknowledgement
        .document_ids
      const row = await admin.query(
        `select content_type, storage_ref from deedbox.document_file where id = $1`,
        [ids[0]],
      )
      expect(row.rows[0].content_type).toBe('text/plain')
      expect(calls[0].url).toContain('/storage/v1/object/matter-documents/')
    } finally {
      setIntakeDocumentStore(null)
    }
  })

  it('a storage failure aborts the whole bundle unrecorded — the retry can then succeed', async () => {
    const failing = recordingPut(500)
    setIntakeDocumentStore(
      hostedDocumentStore({
        url: 'https://platform.test',
        serviceKey: 'service-key-1',
        put: failing.put,
      }),
    )
    const payload = {
      external_ref: 'bnd-doc-fail',
      client: { first_name: 'Failing', last_name: 'Bundle' },
      documents: [
        { filename: 'doomed.pdf', content_base64: Buffer.from('bytes').toString('base64') },
      ],
    }
    try {
      await expect(intakeMatterBundle(fx.firm, key.secret, payload)).rejects.toThrow(
        /document_storage_error/,
      )
      // nothing landed and — decisive — the idempotency slot was NOT consumed
      const sub = await admin.query(
        `select 1 from deedbox.inbound_submission where key = $1 and idempotency_key = 'bnd-doc-fail'`,
        [key.id],
      )
      expect(sub.rowCount).toBe(0)
      const party = await admin.query(
        `select 1 from deedbox.party where display_name = 'Failing Bundle'`,
      )
      expect(party.rowCount).toBe(0)
      const doc = await admin.query(
        `select 1 from deedbox.document_file where external_ref = 'bnd-doc-fail'`,
      )
      expect(doc.rowCount).toBe(0)
    } finally {
      setIntakeDocumentStore(null)
    }

    // the same reference replays into a clean success once storage recovers
    const healthy = recordingPut()
    setIntakeDocumentStore(
      hostedDocumentStore({
        url: 'https://platform.test',
        serviceKey: 'service-key-1',
        put: healthy.put,
      }),
    )
    try {
      const retry = await intakeMatterBundle(fx.firm, key.secret, payload)
      expect(retry.outcome).toBe('created')
    } finally {
      setIntakeDocumentStore(null)
    }
  })

  it('an empty file refuses at the store itself', async () => {
    const { put, calls } = recordingPut()
    const store = hostedDocumentStore({
      url: 'https://platform.test',
      serviceKey: 'service-key-1',
      put,
    })
    const sys: Principal = { kind: 'system_job', id: INTAKE_API_SYSTEM_ACTOR, firm: fx.firm }
    await expect(
      withPrincipal(sys, (tx) =>
        store(tx, {
          matter: matterId,
          filename: 'empty.pdf',
          bytes: Buffer.alloc(0),
          integrationKey: key.id,
          externalRef: null,
        }),
      ),
    ).rejects.toThrow(/empty/)
    expect(calls).toHaveLength(0)
  })
})

// ---------------------------------------------------------------------------
// Binding from the environment (the boot-time wiring point).
// ---------------------------------------------------------------------------

describe('binding from the environment', () => {
  it('an unconfigured environment binds nothing and says so', () => {
    const summary = bindFromEnvironment({} as NodeJS.ProcessEnv)
    expect(summary).toEqual({
      outboundTransport: false,
      signInService: false,
      intakeDocumentStore: false,
    })
  })

  it('a configured environment binds all three seams', () => {
    try {
      const summary = bindFromEnvironment({
        RESEND_API_KEY: 'k',
        DEEDBOX_MAIL_FROM: 'Firm <no-reply@firm.test>',
        DEEDBOX_PLATFORM_URL: 'https://platform.test',
        DEEDBOX_PLATFORM_ANON_KEY: 'anon',
        DEEDBOX_PLATFORM_SERVICE_KEY: 'service',
        DEEDBOX_DOCUMENT_BUCKET: 'firm-documents',
      } as NodeJS.ProcessEnv)
      expect(summary).toEqual({
        outboundTransport: true,
        signInService: true,
        intakeDocumentStore: true,
      })
    } finally {
      setOutboundTransport(null)
      setSignInService(null)
      setIntakeDocumentStore(null)
    }
  })
})
