// The Intake API's operations: a generic, versioned inbound door through
// which an authorised outside source delivers a whole matter — client,
// matter, notes, documents — using a key the firm issued itself. The route
// surface lives in app/api/intake/v1; this module is the behaviour.
//
// The door rides the ALREADY-PROVEN interface machinery: integration keys
// (shown once, hashed, revocable), the structurally idempotent submission log
// (every call an evidenced row; replays return the stored acknowledgement
// byte-for-byte), the receipt trail (submissions + key.used register
// events), and the same rate-limit discipline as the intake-record door.
//
// Implementation notes:
//   * The matter creation itself executes as the PLATFORM (a system_job
//     principal, actor id 21) after the key authenticates — the visibility
//     predicate fails closed for integration_key principals by design
//     (write-only is structural), so the key's context writes only the
//     submission/receipt rows while the platform runs the ordinary
//     creation path (createMatterInTx). Every creation-side register
//     entry carries detail {source:'intake_api', integration_key,
//     external_ref}.
//   * The matter-shaped doors (bundle, notes, documents) refuse TEST-MODE
//     keys typed ('live_key_required'): matters have no 0022-style test
//     containment, and a test matter would surface on every business
//     surface. Test keys keep the intake-record door and /me.
//   * Client policy: ALWAYS create, with candidates recorded as a
//     deferred duplicate review (integration_deferred) — never a silent
//     email match. The creation path's own client invariant applies
//     unchanged.
//   * area_of_law maps case-insensitively against ACTIVE practice areas;
//     no match = the key's default area. The as-sent text always lands in
//     the matter's origin note, so nothing the caller said is lost and
//     the call NEVER fails over an area name.
//   * matter.state → jurisdiction; court_name/court_date compose into a
//     note alongside notes[] (notes carry no staff owner — the register
//     carries the actor).
//   * Documents are a SEAM (setIntakeDocumentStore), bound at deployment.
//     Until bound, a payload carrying documents is refused typed
//     ('document_storage_unbound') — the bundle is all-or-nothing, a 201
//     never lies about a partial landing.
//   * A missing external_ref is a 422 with NO submission row (there is
//     nothing to key the idempotency slot by); every other rejection is
//     an evidenced 'rejected' submission row and replays idempotently.
//   * Any domain refusal inside the creation transaction (conflict gate
//     demanded by the firm, several active workflow templates, inactive
//     defaults…) becomes a documented rejection {error, message} — the
//     door never bypasses a firm's discipline.
//   * The bundle door requires the key's defaults row (0026); without it
//     the door refuses 'key_defaults_missing'. The granular doors need no
//     defaults.
//   * Granular doors accept an OPTIONAL external_ref for idempotency;
//     absent, each call creates (the row's idempotency key is a synthesised
//     auto_… value, recorded verbatim).
//   * /me writes nothing — the one read a key can perform, revealing the
//     firm's display name only.

import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import type { Principal, Tx } from '@/lib/db'
import { withPrincipal, emitRegister, OperationRefused } from '@/lib/db'
import { requireCapability } from '@/lib/ops/shared'
import { seamSlot } from '@/lib/seam-slot'
import { checkDuplicatesInTx } from '@/lib/ops/matters/duplicates'
import { createMatterInTx } from '@/lib/ops/matters/createMatter'

/** The platform actor the creation side runs as (register actor, system_job). */
export const INTAKE_API_SYSTEM_ACTOR = 21

// ---------------------------------------------------------------------------
// The document seam — bound at deployment by the documents module.
// ---------------------------------------------------------------------------

export type IntakeDocumentStore = (
  tx: Tx,
  input: {
    matter: number
    filename: string
    bytes: Buffer
    integrationKey: number
    externalRef: string | null
  },
) => Promise<number | string>

// Process-wide, not module-level: see lib/seam-slot.ts for why.
const documentStore = seamSlot<IntakeDocumentStore>('intake-document-store')

export function setIntakeDocumentStore(store: IntakeDocumentStore | null): void {
  documentStore.set(store)
}

// ---------------------------------------------------------------------------
// Key defaults (0026) — the firm-admin configuration the bundle door needs.
// ---------------------------------------------------------------------------

export async function setIntakeKeyDefaults(
  p: Principal,
  input: { key: number; office: number; responsibleLawyer: number; practiceArea: number },
): Promise<void> {
  await withPrincipal(p, async (tx) => {
    await requireCapability(tx, p, 'keys.manage')
    const key = await tx.query(
      `select id, revoked_at from deedbox.integration_key where id = $1`,
      [input.key],
    )
    if (key.rowCount === 0) throw new OperationRefused('not_found', 'integration key not found')
    const office = await tx.query(`select active from deedbox.office where id = $1`, [input.office])
    if (office.rowCount === 0 || !office.rows[0].active) {
      throw new OperationRefused('office_inactive', 'the default office must be active')
    }
    const lawyer = await tx.query(`select active from deedbox.staff_member where id = $1`, [
      input.responsibleLawyer,
    ])
    if (lawyer.rowCount === 0 || !lawyer.rows[0].active) {
      throw new OperationRefused('lawyer_inactive', 'the default lawyer must be active staff')
    }
    const area = await tx.query(`select active from deedbox.practice_area where id = $1`, [
      input.practiceArea,
    ])
    if (area.rowCount === 0 || !area.rows[0].active) {
      throw new OperationRefused('area_inactive', 'the default practice area must be active')
    }
    const before = await tx.query(
      `select office, responsible_lawyer, practice_area
         from deedbox.integration_key_defaults where key = $1`,
      [input.key],
    )
    await tx.query(
      `insert into deedbox.integration_key_defaults (key, office, responsible_lawyer, practice_area)
       values ($1, $2, $3, $4)
       on conflict (key) do update
         set office = $2, responsible_lawyer = $3, practice_area = $4`,
      [input.key, input.office, input.responsibleLawyer, input.practiceArea],
    )
    await emitRegister(tx, p, {
      kind: 'record.changed',
      subjectType: 'integration_key',
      subject: input.key,
      detail: {
        before: before.rowCount === 0 ? null : before.rows[0],
        after: {
          office: input.office,
          responsible_lawyer: input.responsibleLawyer,
          practice_area: input.practiceArea,
        },
      },
    })
  })
}

export async function clearIntakeKeyDefaults(
  p: Principal,
  input: { key: number },
): Promise<void> {
  await withPrincipal(p, async (tx) => {
    await requireCapability(tx, p, 'keys.manage')
    const before = await tx.query(
      `select office, responsible_lawyer, practice_area
         from deedbox.integration_key_defaults where key = $1`,
      [input.key],
    )
    if (before.rowCount === 0) {
      throw new OperationRefused('not_found', 'this key has no defaults to clear')
    }
    await tx.query(`delete from deedbox.integration_key_defaults where key = $1`, [input.key])
    await emitRegister(tx, p, {
      kind: 'record.changed',
      subjectType: 'integration_key',
      subject: input.key,
      detail: { before: before.rows[0], after: null },
    })
  })
}

// ---------------------------------------------------------------------------
// Authentication: the x-api-key value IS the shown-once secret from the
// route contract; the lookup hashes it and finds the key row.
// ---------------------------------------------------------------------------

interface AuthedKey {
  id: number
  label: string
  test_mode: boolean
  rate_limit: { per_minute?: number; per_day?: number }
  revoked: boolean
}

function safeHashEqual(a: string, b: string): boolean {
  const ha = Buffer.from(a, 'utf8')
  const hb = Buffer.from(b, 'utf8')
  return ha.length === hb.length && timingSafeEqual(ha, hb)
}

async function authenticate(firm: number, secret: string): Promise<AuthedKey | null> {
  if (!secret) return null
  const hash = createHash('sha256').update(secret).digest('hex')
  return withPrincipal(
    { kind: 'integration_key', id: 0, firm },
    async (tx) => {
      const r = await tx.query(
        `select id, label, secret_hash, revoked_at, rate_limit, test_mode
           from deedbox.integration_key where secret_hash = $1`,
        [hash],
      )
      if (r.rowCount === 0) return null
      // constant-time re-check of the stored hash against the presented one
      if (!safeHashEqual(hash, r.rows[0].secret_hash as string)) return null
      return {
        id: r.rows[0].id as number,
        label: r.rows[0].label as string,
        test_mode: Boolean(r.rows[0].test_mode),
        rate_limit: (r.rows[0].rate_limit ?? {}) as { per_minute?: number; per_day?: number },
        revoked: r.rows[0].revoked_at !== null,
      }
    },
    { readOnly: true },
  )
}

// ---------------------------------------------------------------------------
// Outcome shapes shared by the doors.
// ---------------------------------------------------------------------------

export type IntakeOutcome =
  | { outcome: 'unauthenticated' }
  | { outcome: 'revoked' }
  | { outcome: 'rate_limited'; retryAfterSeconds: number }
  | { outcome: 'created'; submission: number; acknowledgement: unknown }
  | { outcome: 'duplicate_replayed'; submission: number; acknowledgement: unknown }
  | { outcome: 'rejected'; submission: number; acknowledgement: unknown }

const PAYLOAD_VERSION = 'intake-api-v1'

interface DoorContext {
  firm: number
  key: AuthedKey
  principal: Principal
  external_ref: string
  payload: unknown
}

/** The shared front half: revoked check, rate limit, idempotent replay. */
async function frontDoor(
  firm: number,
  key: AuthedKey,
  externalRef: string,
  payload: unknown,
): Promise<{ ctx: DoorContext } | IntakeOutcome> {
  const principal: Principal = { kind: 'integration_key', id: key.id, firm }
  if (key.revoked) {
    await withPrincipal(principal, async (tx) => {
      await emitRegister(tx, principal, {
        kind: 'key.used',
        subjectType: 'integration_key',
        subject: key.id,
        detail: { outcome: 'revoked_attempt', door: 'intake_api' },
      })
    })
    return { outcome: 'revoked' }
  }

  const perMinute = key.rate_limit?.per_minute ?? 60
  const perDay = key.rate_limit?.per_day ?? 5000
  const limited = await withPrincipal(principal, async (tx) => {
    const c = await tx.query(
      `select count(*) filter (where received_at > now() - interval '1 minute')::int as m,
              count(*) filter (where received_at > now() - interval '1 day')::int as d
         from deedbox.inbound_submission where key = $1`,
      [key.id],
    )
    if ((c.rows[0].m as number) < perMinute && (c.rows[0].d as number) < perDay) return false
    const bucket = await tx.query(`select to_char(now(), 'YYYY-MM-DD HH24:MI') as b`)
    const seen = await tx.query(
      `select 1 from deedbox.register_entry
        where event_kind = 'key.used' and subject_type = 'integration_key' and subject = $1
          and detail ->> 'outcome' = 'rate_limited' and detail ->> 'bucket' = $2`,
      [key.id, bucket.rows[0].b],
    )
    if (seen.rowCount === 0) {
      await emitRegister(tx, principal, {
        kind: 'key.used',
        subjectType: 'integration_key',
        subject: key.id,
        detail: { outcome: 'rate_limited', bucket: bucket.rows[0].b },
      })
    }
    return true
  })
  if (limited) return { outcome: 'rate_limited', retryAfterSeconds: 60 }

  const replay = await replayIfSeen(principal, key, externalRef, payload)
  if (replay !== null) return replay

  return { ctx: { firm, key, principal, external_ref: externalRef, payload } }
}

async function replayIfSeen(
  principal: Principal,
  key: AuthedKey,
  externalRef: string,
  payload: unknown,
): Promise<IntakeOutcome | null> {
  return withPrincipal(principal, async (tx) => {
    const orig = await tx.query(
      `select id, acknowledgement from deedbox.inbound_submission
        where key = $1 and idempotency_key = $2 and outcome in ('created','rejected')`,
      [key.id, externalRef],
    )
    if (orig.rowCount === 0) return null
    const r = await tx.query(
      `insert into deedbox.inbound_submission
         (key, idempotency_key, payload_version, payload_verbatim, outcome,
          created_type, acknowledgement, original, test)
       values ($1, $2, $3, $4, 'duplicate_replayed', 'none', $5, $6, $7)
       returning id`,
      [
        key.id,
        externalRef,
        PAYLOAD_VERSION,
        JSON.stringify(payload ?? null),
        JSON.stringify(orig.rows[0].acknowledgement),
        orig.rows[0].id,
        key.test_mode,
      ],
    )
    await emitRegister(tx, principal, {
      kind: 'key.used',
      subjectType: 'integration_key',
      subject: key.id,
      detail: { outcome: 'duplicate_replayed', original: orig.rows[0].id, door: 'intake_api' },
    })
    return {
      outcome: 'duplicate_replayed' as const,
      submission: r.rows[0].id as number,
      acknowledgement: orig.rows[0].acknowledgement,
    }
  })
}

function isIdempotencyRace(err: unknown): boolean {
  return (
    typeof err === 'object' &&
    err !== null &&
    (err as { code?: string }).code === '23505' &&
    String((err as { constraint?: string }).constraint ?? '').includes('inbound_submission_idempotent')
  )
}

async function rejectDoor(
  ctx: DoorContext,
  reason: string,
  acknowledgement: unknown,
): Promise<IntakeOutcome> {
  try {
    return await withPrincipal(ctx.principal, async (tx) => {
      const r = await tx.query(
        `insert into deedbox.inbound_submission
           (key, idempotency_key, payload_version, payload_verbatim, outcome,
            created_type, acknowledgement, rejection_reason, test)
         values ($1, $2, $3, $4, 'rejected', 'none', $5, $6, $7)
         returning id`,
        [
          ctx.key.id,
          ctx.external_ref,
          PAYLOAD_VERSION,
          JSON.stringify(ctx.payload ?? null),
          JSON.stringify(acknowledgement),
          reason,
          ctx.key.test_mode,
        ],
      )
      await emitRegister(tx, ctx.principal, {
        kind: 'key.used',
        subjectType: 'integration_key',
        subject: ctx.key.id,
        detail: { outcome: 'rejected', reason, door: 'intake_api' },
      })
      return {
        outcome: 'rejected' as const,
        submission: r.rows[0].id as number,
        acknowledgement,
      }
    })
  } catch (err) {
    if (!isIdempotencyRace(err)) throw err
    const raced = await replayIfSeen(ctx.principal, ctx.key, ctx.external_ref, ctx.payload)
    if (raced === null) throw err
    return raced
  }
}

// ---------------------------------------------------------------------------
// /me — the identity check: writes nothing, reveals the display name.
// ---------------------------------------------------------------------------

export async function intakeIdentity(
  firm: number,
  secret: string,
): Promise<{ ok: true; firmName: string } | { ok: false; reason: 'unauthenticated' | 'revoked' }> {
  const key = await authenticate(firm, secret)
  if (key === null) return { ok: false, reason: 'unauthenticated' }
  if (key.revoked) return { ok: false, reason: 'revoked' }
  const name = await withPrincipal(
    { kind: 'integration_key', id: key.id, firm },
    async (tx) => {
      const r = await tx.query(`select name from deedbox.firm where id = $1`, [firm])
      return r.rowCount === 0 ? null : (r.rows[0].name as string)
    },
    { readOnly: true },
  )
  if (name === null) return { ok: false, reason: 'unauthenticated' }
  return { ok: true, firmName: name }
}

// ---------------------------------------------------------------------------
// The bundle door — one call, whole matter.
// ---------------------------------------------------------------------------

export interface MatterBundlePayload {
  external_ref: string
  client: {
    first_name: string
    last_name: string
    email?: string
    phone?: string
  }
  matter?: {
    summary?: string
    area_of_law?: string
    state?: string
    court_name?: string
    court_date?: string
    source?: string
  }
  documents?: { filename: string; content_base64: string }[]
  notes?: { title?: string; body: string }[]
}

export async function intakeMatterBundle(
  firm: number,
  secret: string,
  payload: unknown,
): Promise<IntakeOutcome> {
  const key = await authenticate(firm, secret)
  if (key === null) return { outcome: 'unauthenticated' }

  const p = (payload ?? {}) as Partial<MatterBundlePayload>
  const externalRef = typeof p.external_ref === 'string' ? p.external_ref.trim() : ''
  if (!externalRef) {
    // nothing to key the idempotency slot by — the route turns this
    // into a 422 without a submission row
    return {
      outcome: 'rejected',
      submission: 0,
      acknowledgement: { error: 'external_ref_required', message: 'external_ref is required' },
    }
  }

  const front = await frontDoor(firm, key, externalRef, payload)
  if (!('ctx' in front)) return front
  const ctx = front.ctx

  // -- validation (422-shaped rejections, evidenced) -------------------------
  const first = p.client?.first_name?.trim() ?? ''
  const last = p.client?.last_name?.trim() ?? ''
  if (!first || !last) {
    return rejectDoor(ctx, 'client_name_required', {
      error: 'client_name_required',
      message: 'client.first_name and client.last_name are required',
    })
  }
  if (key.test_mode) {
    // no test containment exists for matters
    return rejectDoor(ctx, 'live_key_required', {
      error: 'live_key_required',
      message:
        'this key is in test mode; the matter door needs a live key (test keys may use the intake-record door)',
    })
  }
  const documents = Array.isArray(p.documents) ? p.documents : []
  if (documents.length > 0 && documentStore.get() === null) {
    // all-or-nothing — a 201 never lies about a partial landing
    return rejectDoor(ctx, 'document_storage_unbound', {
      error: 'document_storage_unbound',
      message: 'document storage is not yet connected on this installation; send the bundle without documents',
    })
  }
  for (const d of documents) {
    if (!d?.filename?.trim() || typeof d?.content_base64 !== 'string' || d.content_base64 === '') {
      return rejectDoor(ctx, 'document_shape_invalid', {
        error: 'document_shape_invalid',
        message: 'each document needs filename and content_base64',
      })
    }
  }
  const notes = Array.isArray(p.notes) ? p.notes : []
  for (const n of notes) {
    if (typeof n?.body !== 'string' || !n.body.trim()) {
      return rejectDoor(ctx, 'note_body_required', {
        error: 'note_body_required',
        message: 'each note needs a body',
      })
    }
  }

  // -- the creation transaction, as the platform -----------------------------
  const sys: Principal = { kind: 'system_job', id: INTAKE_API_SYSTEM_ACTOR, firm }
  try {
    return await withPrincipal(sys, async (tx) => {
      const defaults = await tx.query(
        `select office, responsible_lawyer, practice_area
           from deedbox.integration_key_defaults where key = $1`,
        [key.id],
      )
      if (defaults.rowCount === 0) {
        throw new OperationRefused(
          'key_defaults_missing',
          'this key has no creation defaults; a firm admin sets the office, lawyer and practice area on the key',
        )
      }
      const d = defaults.rows[0] as {
        office: number
        responsible_lawyer: number
        practice_area: number
      }

      // lenient area mapping — active-name match or the key's default
      const areaAsSent = p.matter?.area_of_law?.trim() || null
      let practiceArea = d.practice_area
      let areaMatched = false
      if (areaAsSent) {
        const hit = await tx.query(
          `select id from deedbox.practice_area where active and lower(name) = lower($1)`,
          [areaAsSent],
        )
        if (hit.rowCount! > 0) {
          practiceArea = hit.rows[0].id as number
          areaMatched = true
        }
      }

      // always create the client; candidates go to deferred review
      const fullName = `${first} ${last}`
      const candidates = await checkDuplicatesInTx(tx, {
        name: fullName,
        phone: p.client?.phone,
        email: p.client?.email,
      })
      const party = await tx.query(
        `insert into deedbox.party (kind, display_name) values ('person', $1) returning id`,
        [fullName],
      )
      const partyId = party.rows[0].id as number
      await tx.query(
        `insert into deedbox.party_name (party, name_kind, full_name) values ($1, 'current', $2)`,
        [partyId, fullName],
      )
      if (p.client?.phone?.trim()) {
        await tx.query(
          `insert into deedbox.contact_point (party, kind, value, is_primary)
           values ($1, 'phone', $2, true)`,
          [partyId, p.client.phone.trim()],
        )
      }
      if (p.client?.email?.trim()) {
        await tx.query(
          `insert into deedbox.contact_point (party, kind, value, is_primary)
           values ($1, 'email', $2, true)`,
          [partyId, p.client.email.trim()],
        )
      }
      if (candidates.length > 0) {
        await tx.query(
          `insert into deedbox.duplicate_decision
             (created_entity_type, created_entity, candidates_shown, decision_mode,
              test, decided_by_kind, decided_by)
           values ('party', $1, $2, 'integration_deferred', false, 'integration_key', $3)`,
          [partyId, JSON.stringify(candidates), key.id],
        )
      }
      await emitRegister(tx, sys, {
        kind: 'record.created',
        subjectType: 'party',
        subject: partyId,
        detail: {
          display_name: fullName,
          source: 'intake_api',
          integration_key: key.id,
          external_ref: externalRef,
        },
      })

      // the matter, through the ordinary creation path — its refusals stand
      const areaName = await tx.query(`select name from deedbox.practice_area where id = $1`, [
        practiceArea,
      ])
      const originParts = [
        `Received via the intake API (key "${key.label}"), external reference ${externalRef}.`,
      ]
      if (areaAsSent) {
        originParts.push(
          areaMatched ? `Area as sent: ${areaAsSent}.` : `Area as sent (no match, default applied): ${areaAsSent}.`,
        )
      }
      if (p.matter?.source?.trim()) originParts.push(`Source: ${p.matter.source.trim()}.`)
      const created = await createMatterInTx(
        tx,
        sys,
        {
          title: `${fullName} — ${areaMatched ? (areaName.rows[0].name as string) : areaAsSent || (areaName.rows[0].name as string)}`,
          clientParty: partyId,
          responsibleLawyer: d.responsible_lawyer,
          office: d.office,
          practiceArea,
          jurisdiction: p.matter?.state?.trim() || undefined,
          summary: p.matter?.summary?.trim() || undefined,
          originNote: originParts.join(' '),
        },
        {},
      )

      // court details + caller notes land as notes
      const noteBodies: { body: string }[] = []
      if (p.matter?.court_name?.trim() || p.matter?.court_date?.trim()) {
        noteBodies.push({
          body: `Court details as delivered: ${[
            p.matter?.court_name?.trim() ? `court ${p.matter.court_name.trim()}` : null,
            p.matter?.court_date?.trim() ? `date ${p.matter.court_date.trim()}` : null,
          ]
            .filter(Boolean)
            .join(', ')}.`,
        })
      }
      for (const n of notes) {
        noteBodies.push({ body: n.title?.trim() ? `${n.title.trim()}: ${n.body}` : n.body })
      }
      const noteIds: number[] = []
      for (const n of noteBodies) {
        const nr = await tx.query(
          `insert into deedbox.note (owner_type, owner, body) values ('matter', $1, $2) returning id`,
          [created.id, n.body],
        )
        noteIds.push(nr.rows[0].id as number)
        await emitRegister(tx, sys, {
          kind: 'record.created',
          subjectType: 'note',
          subject: nr.rows[0].id as number,
          matter: created.id,
          detail: { source: 'intake_api', integration_key: key.id, external_ref: externalRef },
        })
      }

      // documents through the seam (bound — checked before the transaction);
      // a store that lands a core row (a numeric id) gets its arrival
      // registered here, where the transaction's principal is known — a
      // foreign store's string receipt is evidenced by the acknowledgement
      const documentIds: (number | string)[] = []
      for (const doc of documents) {
        const docId = await documentStore.get()!(tx, {
          matter: created.id,
          filename: doc.filename.trim(),
          bytes: Buffer.from(doc.content_base64, 'base64'),
          integrationKey: key.id,
          externalRef,
        })
        documentIds.push(docId)
        if (typeof docId === 'number') {
          await emitRegister(tx, sys, {
            kind: 'record.created',
            subjectType: 'document_file',
            subject: docId,
            matter: created.id,
            detail: {
              filename: doc.filename.trim(),
              source: 'intake_api',
              integration_key: key.id,
              external_ref: externalRef,
            },
          })
        }
      }

      const acknowledgement = {
        status: 'created',
        matter_id: created.id,
        matter_number: created.matterNumber,
        external_ref: externalRef,
        ...(noteIds.length > 0 ? { note_ids: noteIds } : {}),
        ...(documentIds.length > 0 ? { document_ids: documentIds } : {}),
      }
      const sub = await tx.query(
        `insert into deedbox.inbound_submission
           (key, idempotency_key, payload_version, payload_verbatim, outcome,
            created_type, created, acknowledgement, test)
         values ($1, $2, $3, $4, 'created', 'matter', $5, $6, false)
         returning id`,
        [
          key.id,
          externalRef,
          PAYLOAD_VERSION,
          JSON.stringify(payload),
          created.id,
          JSON.stringify(acknowledgement),
        ],
      )
      await tx.query(`update deedbox.integration_key set last_used_at = now() where id = $1`, [
        key.id,
      ])
      await emitRegister(tx, sys, {
        kind: 'key.used',
        subjectType: 'integration_key',
        subject: key.id,
        detail: {
          outcome: 'created',
          created_type: 'matter',
          created: created.id,
          external_ref: externalRef,
          door: 'intake_api',
        },
      })
      return {
        outcome: 'created' as const,
        submission: sub.rows[0].id as number,
        acknowledgement,
      }
    })
  } catch (err) {
    if (isIdempotencyRace(err)) {
      const raced = await replayIfSeen(ctx.principal, key, externalRef, payload)
      if (raced !== null) return raced
    }
    if (err instanceof OperationRefused) {
      // the firm's own discipline refused — an evidenced, documented rejection
      return rejectDoor(ctx, err.code, { error: err.code, message: err.message })
    }
    throw err
  }
}

// ---------------------------------------------------------------------------
// Granular doors — notes and documents onto an existing matter.
// ---------------------------------------------------------------------------

async function granularFront(
  firm: number,
  secret: string,
  externalRef: string | undefined,
  payload: unknown,
): Promise<{ ctx: DoorContext; key: AuthedKey } | IntakeOutcome> {
  const key = await authenticate(firm, secret)
  if (key === null) return { outcome: 'unauthenticated' }
  const ref =
    typeof externalRef === 'string' && externalRef.trim()
      ? externalRef.trim()
      : `auto_${randomBytes(9).toString('hex')}`
  const front = await frontDoor(firm, key, ref, payload)
  if (!('ctx' in front)) return front
  return { ctx: front.ctx, key }
}

async function matterExists(firm: number, matter: number): Promise<boolean> {
  const sys: Principal = { kind: 'system_job', id: INTAKE_API_SYSTEM_ACTOR, firm }
  return withPrincipal(
    sys,
    async (tx) => {
      const r = await tx.query(`select 1 from deedbox.matter where id = $1`, [matter])
      return r.rowCount! > 0
    },
    { readOnly: true },
  )
}

export async function intakeAddNotes(
  firm: number,
  secret: string,
  matter: number,
  payload: unknown,
): Promise<IntakeOutcome> {
  const front = await granularFront(
    firm,
    secret,
    (payload as { external_ref?: string } | null)?.external_ref,
    payload,
  )
  if (!('ctx' in front)) return front
  const { ctx, key } = front
  if (key.test_mode) {
    return rejectDoor(ctx, 'live_key_required', {
      error: 'live_key_required',
      message: 'this key is in test mode; the notes door needs a live key',
    })
  }
  const notes = (payload as { notes?: { title?: string; body: string }[] } | null)?.notes
  if (!Array.isArray(notes) || notes.length === 0 || notes.some((n) => !n?.body?.trim())) {
    return rejectDoor(ctx, 'note_body_required', {
      error: 'note_body_required',
      message: 'notes must be a non-empty array and each note needs a body',
    })
  }
  if (!(await matterExists(firm, matter))) {
    return rejectDoor(ctx, 'matter_not_found', {
      error: 'matter_not_found',
      message: 'no matter by that id',
    })
  }
  const sys: Principal = { kind: 'system_job', id: INTAKE_API_SYSTEM_ACTOR, firm }
  try {
    return await withPrincipal(sys, async (tx) => {
      const noteIds: number[] = []
      for (const n of notes) {
        const nr = await tx.query(
          `insert into deedbox.note (owner_type, owner, body) values ('matter', $1, $2) returning id`,
          [matter, n.title?.trim() ? `${n.title.trim()}: ${n.body}` : n.body],
        )
        noteIds.push(nr.rows[0].id as number)
        await emitRegister(tx, sys, {
          kind: 'record.created',
          subjectType: 'note',
          subject: nr.rows[0].id as number,
          matter,
          detail: { source: 'intake_api', integration_key: ctx.key.id, external_ref: ctx.external_ref },
        })
      }
      const acknowledgement = {
        status: 'created',
        matter_id: matter,
        note_ids: noteIds,
        external_ref: ctx.external_ref,
      }
      const sub = await tx.query(
        `insert into deedbox.inbound_submission
           (key, idempotency_key, payload_version, payload_verbatim, outcome,
            created_type, acknowledgement, test)
         values ($1, $2, $3, $4, 'created', 'none', $5, false)
         returning id`,
        [ctx.key.id, ctx.external_ref, PAYLOAD_VERSION, JSON.stringify(payload), JSON.stringify(acknowledgement)],
      )
      await tx.query(`update deedbox.integration_key set last_used_at = now() where id = $1`, [
        ctx.key.id,
      ])
      await emitRegister(tx, sys, {
        kind: 'key.used',
        subjectType: 'integration_key',
        subject: ctx.key.id,
        detail: { outcome: 'created', created_type: 'notes', matter, door: 'intake_api' },
      })
      return {
        outcome: 'created' as const,
        submission: sub.rows[0].id as number,
        acknowledgement,
      }
    })
  } catch (err) {
    if (isIdempotencyRace(err)) {
      const raced = await replayIfSeen(ctx.principal, ctx.key, ctx.external_ref, payload)
      if (raced !== null) return raced
    }
    if (err instanceof OperationRefused) {
      return rejectDoor(ctx, err.code, { error: err.code, message: err.message })
    }
    throw err
  }
}

export async function intakeAddDocuments(
  firm: number,
  secret: string,
  matter: number,
  payload: unknown,
): Promise<IntakeOutcome> {
  const front = await granularFront(
    firm,
    secret,
    (payload as { external_ref?: string } | null)?.external_ref,
    payload,
  )
  if (!('ctx' in front)) return front
  const { ctx, key } = front
  if (key.test_mode) {
    return rejectDoor(ctx, 'live_key_required', {
      error: 'live_key_required',
      message: 'this key is in test mode; the documents door needs a live key',
    })
  }
  const documents = (payload as { documents?: { filename: string; content_base64: string }[] } | null)
    ?.documents
  if (
    !Array.isArray(documents) ||
    documents.length === 0 ||
    documents.some((d) => !d?.filename?.trim() || typeof d?.content_base64 !== 'string' || d.content_base64 === '')
  ) {
    return rejectDoor(ctx, 'document_shape_invalid', {
      error: 'document_shape_invalid',
      message: 'documents must be a non-empty array and each needs filename and content_base64',
    })
  }
  if (documentStore.get() === null) {
    return rejectDoor(ctx, 'document_storage_unbound', {
      error: 'document_storage_unbound',
      message: 'document storage is not yet connected on this installation',
    })
  }
  if (!(await matterExists(firm, matter))) {
    return rejectDoor(ctx, 'matter_not_found', {
      error: 'matter_not_found',
      message: 'no matter by that id',
    })
  }
  const sys: Principal = { kind: 'system_job', id: INTAKE_API_SYSTEM_ACTOR, firm }
  try {
    return await withPrincipal(sys, async (tx) => {
      const documentIds: (number | string)[] = []
      for (const doc of documents) {
        const docId = await documentStore.get()!(tx, {
          matter,
          filename: doc.filename.trim(),
          bytes: Buffer.from(doc.content_base64, 'base64'),
          integrationKey: ctx.key.id,
          externalRef: ctx.external_ref,
        })
        documentIds.push(docId)
        if (typeof docId === 'number') {
          await emitRegister(tx, sys, {
            kind: 'record.created',
            subjectType: 'document_file',
            subject: docId,
            matter,
            detail: {
              filename: doc.filename.trim(),
              source: 'intake_api',
              integration_key: ctx.key.id,
              external_ref: ctx.external_ref,
            },
          })
        }
      }
      const acknowledgement = {
        status: 'created',
        matter_id: matter,
        document_ids: documentIds,
        external_ref: ctx.external_ref,
      }
      const sub = await tx.query(
        `insert into deedbox.inbound_submission
           (key, idempotency_key, payload_version, payload_verbatim, outcome,
            created_type, acknowledgement, test)
         values ($1, $2, $3, $4, 'created', 'none', $5, false)
         returning id`,
        [ctx.key.id, ctx.external_ref, PAYLOAD_VERSION, JSON.stringify(payload), JSON.stringify(acknowledgement)],
      )
      await tx.query(`update deedbox.integration_key set last_used_at = now() where id = $1`, [
        ctx.key.id,
      ])
      await emitRegister(tx, sys, {
        kind: 'key.used',
        subjectType: 'integration_key',
        subject: ctx.key.id,
        detail: { outcome: 'created', created_type: 'documents', matter, door: 'intake_api' },
      })
      return {
        outcome: 'created' as const,
        submission: sub.rows[0].id as number,
        acknowledgement,
      }
    })
  } catch (err) {
    if (isIdempotencyRace(err)) {
      const raced = await replayIfSeen(ctx.principal, ctx.key, ctx.external_ref, payload)
      if (raced !== null) return raced
    }
    if (err instanceof OperationRefused) {
      return rejectDoor(ctx, err.code, { error: err.code, message: err.message })
    }
    throw err
  }
}
