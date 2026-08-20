// Handle an inbound submission — the external interface path into the
// matters domain. The path, in order: authenticate (key_display +
// secret hash; revoked = refusal registered on the key, no submission row);
// rate limit (over-limit = documented throttle, NO submission row, one
// aggregated register event per limiting episode per key); idempotency (a
// replay inserts its own evidence row pointing at the original and returns
// the original acknowledgement BYTE-FOR-BYTE, creating nothing); payload
// version; schema validation; then creation through the ordinary domain
// path — intake record + prospect party, duplicate detection with the
// decision DEFERRED to staff review (never auto-merged), sender extras as
// plain custom-field values, no classification, no financial flags. Test
// keys traverse everything writing test-flagged records (0022's containment
// keeps them off every business surface), register entries kept.
//
// The acknowledgement is only ever returned for a durable outcome: the
// submission row, the created records and the register entries share one
// transaction.
//
// Implementation notes:
//   * created_type 'matter' is refused as an unsupported payload kind in
//     this build (documented rejection): the schema ships no test-mode
//     containment for matters and no keys-configuration naming the office/
//     lawyer defaults a direct matter creation would need. The intake path
//     is the shipped interface; the created-type enum retains 'matter' so
//     the row shape is ready when that decision is taken.
//   * The notification queued on creation awaits a recipient decision (no
//     shipped setting names an intake notification address); the outbound
//     queue writer is ready.

import { createHash, timingSafeEqual } from 'node:crypto'
import type { Principal, Tx } from '@/lib/db'
import { withPrincipal, emitRegister, OperationRefused } from '@/lib/db'
import { requireStaff } from '@/lib/ops/shared'
import { checkDuplicatesInTx } from '@/lib/ops/matters/duplicates'

export interface SubmissionRequest {
  keyDisplay: string
  secret: string
  idempotencyKey: string
  payloadVersion: string
  payload: unknown
  /** The firm whose register receives the work (request infrastructure). */
  firm: number
}

export type SubmissionOutcome =
  | { outcome: 'unauthenticated' }
  | { outcome: 'revoked' }
  | { outcome: 'rate_limited'; retryAfterSeconds: number }
  | { outcome: 'created'; submission: number; acknowledgement: unknown }
  | { outcome: 'duplicate_replayed'; submission: number; acknowledgement: unknown }
  | { outcome: 'rejected'; submission: number; acknowledgement: unknown }

interface IntakePayload {
  kind: 'intake'
  contact_phone: string
  contact_email?: string
  about: string
  notes?: string
  prospect: { kind?: 'person' | 'organisation'; full_name: string }
  extras?: Record<string, string>
}

interface KeyRow {
  id: number
  secret_hash: string
  revoked_at: string | null
  rate_limit: { per_minute?: number; per_day?: number }
  test_mode: boolean
  payload_versions: string[]
}

function safeHashEqual(a: string, b: string): boolean {
  const ha = Buffer.from(a, 'utf8')
  const hb = Buffer.from(b, 'utf8')
  return ha.length === hb.length && timingSafeEqual(ha, hb)
}

/** The whole request path. */
export async function handleInboundSubmission(req: SubmissionRequest): Promise<SubmissionOutcome> {
  // -- authenticate ---------------------------------------------------------
  // the lookup runs before any key identity is proven; the placeholder
  // principal reads only the key table (no row security there) and writes
  // nothing
  const lookup = await withPrincipal(
    { kind: 'integration_key', id: 0, firm: req.firm },
    async (tx) => {
      const r = await tx.query(
        `select id, secret_hash, revoked_at, rate_limit, test_mode, payload_versions
           from deedbox.integration_key where key_display = $1`,
        [req.keyDisplay],
      )
      return r.rowCount === 0 ? null : (r.rows[0] as unknown as KeyRow)
    },
    { readOnly: true },
  )
  if (lookup === null) return { outcome: 'unauthenticated' }
  const presented = createHash('sha256').update(req.secret).digest('hex')
  if (!safeHashEqual(presented, lookup.secret_hash)) {
    return { outcome: 'unauthenticated' }
  }
  const principal: Principal = { kind: 'integration_key', id: lookup.id, firm: req.firm }

  if (lookup.revoked_at !== null) {
    await withPrincipal(principal, async (tx) => {
      await emitRegister(tx, principal, {
        kind: 'key.used',
        subjectType: 'integration_key',
        subject: lookup.id,
        detail: { outcome: 'revoked_attempt' },
      })
    })
    return { outcome: 'revoked' }
  }

  // -- rate limit -----------------------------------------------------------
  const perMinute = lookup.rate_limit?.per_minute ?? 60
  const perDay = lookup.rate_limit?.per_day ?? 5000
  const limited = await withPrincipal(principal, async (tx) => {
    const c = await tx.query(
      `select count(*) filter (where received_at > now() - interval '1 minute')::int as m,
              count(*) filter (where received_at > now() - interval '1 day')::int as d
         from deedbox.inbound_submission where key = $1`,
      [lookup.id],
    )
    if ((c.rows[0].m as number) < perMinute && (c.rows[0].d as number) < perDay) return false
    // one aggregated register event per limiting episode (minute bucket)
    const bucket = await tx.query(`select to_char(now(), 'YYYY-MM-DD HH24:MI') as b`)
    const seen = await tx.query(
      `select 1 from deedbox.register_entry
        where event_kind = 'key.used' and subject_type = 'integration_key' and subject = $1
          and detail ->> 'outcome' = 'rate_limited' and detail ->> 'bucket' = $2`,
      [lookup.id, bucket.rows[0].b],
    )
    if (seen.rowCount === 0) {
      await emitRegister(tx, principal, {
        kind: 'key.used',
        subjectType: 'integration_key',
        subject: lookup.id,
        detail: { outcome: 'rate_limited', bucket: bucket.rows[0].b },
      })
    }
    return true
  })
  if (limited) return { outcome: 'rate_limited', retryAfterSeconds: 60 }

  // -- idempotency ----------------------------------------------------------
  const replay = await withPrincipal(principal, async (tx) => {
    const orig = await tx.query(
      `select id, acknowledgement from deedbox.inbound_submission
        where key = $1 and idempotency_key = $2 and outcome in ('created','rejected')`,
      [lookup.id, req.idempotencyKey],
    )
    if (orig.rowCount === 0) return null
    const r = await tx.query(
      `insert into deedbox.inbound_submission
         (key, idempotency_key, payload_version, payload_verbatim, outcome,
          created_type, acknowledgement, original, test)
       values ($1, $2, $3, $4, 'duplicate_replayed', 'none', $5, $6, $7)
       returning id`,
      [
        lookup.id,
        req.idempotencyKey,
        req.payloadVersion,
        JSON.stringify(req.payload ?? null),
        JSON.stringify(orig.rows[0].acknowledgement),
        orig.rows[0].id,
        lookup.test_mode,
      ],
    )
    await emitRegister(tx, principal, {
      kind: 'key.used',
      subjectType: 'integration_key',
      subject: lookup.id,
      detail: { outcome: 'duplicate_replayed', original: orig.rows[0].id },
    })
    return { submission: r.rows[0].id as number, acknowledgement: orig.rows[0].acknowledgement }
  })
  if (replay !== null) {
    return { outcome: 'duplicate_replayed', ...replay }
  }

  // -- payload version ------------------------------------------------------
  const versions = Array.isArray(lookup.payload_versions) ? lookup.payload_versions : []
  if (!versions.includes(req.payloadVersion)) {
    return reject(principal, req, lookup, 'unsupported_payload_version', {
      error: 'unsupported_payload_version',
      accepted_versions: versions,
    })
  }

  // -- schema validation ----------------------------------------------------
  const p = req.payload as Partial<IntakePayload> | null | undefined
  if (!p || typeof p !== 'object') {
    return reject(principal, req, lookup, 'schema_validation_failed: payload is not an object', {
      error: 'schema_validation_failed',
      detail: 'payload is not an object',
    })
  }
  if ((p as { kind?: string }).kind === 'matter') {
    return reject(principal, req, lookup, 'matter_creation_not_supported', {
      error: 'matter_creation_not_supported',
      detail: 'this interface creates intake records; matters are opened by staff',
    })
  }
  const problems: string[] = []
  if ((p as { kind?: string }).kind !== 'intake') problems.push('kind must be "intake"')
  if (!p.contact_phone?.trim()) problems.push('contact_phone is required')
  if (!p.about?.trim()) problems.push('about is required')
  if (!p.prospect?.full_name?.trim()) problems.push('prospect.full_name is required')
  if (problems.length > 0) {
    return reject(principal, req, lookup, `schema_validation_failed: ${problems.join('; ')}`, {
      error: 'schema_validation_failed',
      detail: problems,
    })
  }

  // -- creation through the ordinary domain path ----------------------------
  return withPrincipal(principal, async (tx) => {
    // the intake gate: refused with a documented code when disabled
    const enabled = await tx.query(
      `select coalesce(deedbox.current_setting_value('intake.enabled') #>> '{}', 'true') = 'true' as on`,
    )
    if (!enabled.rows[0].on) {
      return rejectInTx(tx, principal, req, lookup, 'intake_disabled', {
        error: 'intake_disabled',
        detail: 'this firm is not accepting intake submissions',
      })
    }

    // sender extras land ONLY as plain custom-field values against active
    // intake-scope definitions; an unknown key is a schema rejection —
    // nothing lands anywhere else, so inbound neutrality is structural
    const extras = p.extras ?? {}
    const extraDefs: { key: string; id: number }[] = []
    for (const key of Object.keys(extras)) {
      const d = await tx.query(
        `select id from deedbox.custom_field_definition
          where scope = 'intake' and key = $1 and active and data_type = 'text'`,
        [key],
      )
      if (d.rowCount === 0) {
        return rejectInTx(tx, principal, req, lookup, `unknown_custom_field: ${key}`, {
          error: 'unknown_custom_field',
          detail: key,
        })
      }
      extraDefs.push({ key, id: d.rows[0].id as number })
    }

    const fullName = p.prospect!.full_name!.trim()
    const candidates = await checkDuplicatesInTx(tx, {
      name: fullName,
      phone: p.contact_phone,
      email: p.contact_email,
    })
    const party = await tx.query(
      `insert into deedbox.party (kind, display_name, test) values ($1, $2, $3) returning id`,
      [p.prospect!.kind ?? 'person', fullName, lookup.test_mode],
    )
    const partyId = party.rows[0].id as number
    await tx.query(
      `insert into deedbox.party_name (party, name_kind, full_name) values ($1, 'current', $2)`,
      [partyId, fullName],
    )
    await tx.query(
      `insert into deedbox.contact_point (party, kind, value, is_primary)
       values ($1, 'phone', $2, true)`,
      [partyId, p.contact_phone!.trim()],
    )
    if (p.contact_email?.trim()) {
      await tx.query(
        `insert into deedbox.contact_point (party, kind, value, is_primary)
         values ($1, 'email', $2, true)`,
        [partyId, p.contact_email.trim()],
      )
    }
    if (candidates.length > 0) {
      // created verbatim, never auto-merged; the decision waits for staff
      await tx.query(
        `insert into deedbox.duplicate_decision
           (created_entity_type, created_entity, candidates_shown, decision_mode,
            test, decided_by_kind, decided_by)
         values ('party', $1, $2, 'integration_deferred', $3, 'integration_key', $4)`,
        [partyId, JSON.stringify(candidates), lookup.test_mode, lookup.id],
      )
    }
    const intake = await tx.query(
      `insert into deedbox.intake_record
         (prospect_party, contact_phone, contact_email, about, notes,
          source_integration_key, test_flag)
       values ($1, $2, $3, $4, $5, $6, $7) returning id`,
      [
        partyId,
        p.contact_phone!.trim(),
        p.contact_email?.trim() ?? null,
        p.about!.trim(),
        p.notes ?? null,
        lookup.id,
        lookup.test_mode,
      ],
    )
    const intakeId = intake.rows[0].id as number
    for (const d of extraDefs) {
      await tx.query(
        `insert into deedbox.custom_field_value (definition, owner_type, owner, text_value)
         values ($1, 'intake_record', $2, $3)`,
        [d.id, intakeId, String(extras[d.key])],
      )
    }

    const acknowledgement = {
      status: 'created',
      intake_record: intakeId,
      idempotency_key: req.idempotencyKey,
    }
    const sub = await tx.query(
      `insert into deedbox.inbound_submission
         (key, idempotency_key, payload_version, payload_verbatim, outcome,
          created_type, created, acknowledgement, test)
       values ($1, $2, $3, $4, 'created', 'intake_record', $5, $6, $7)
       returning id`,
      [
        lookup.id,
        req.idempotencyKey,
        req.payloadVersion,
        JSON.stringify(req.payload),
        intakeId,
        JSON.stringify(acknowledgement),
        lookup.test_mode,
      ],
    )
    await tx.query(`update deedbox.integration_key set last_used_at = now() where id = $1`, [
      lookup.id,
    ])
    await emitRegister(tx, principal, {
      kind: 'record.created',
      subjectType: 'party',
      subject: partyId,
      detail: { display_name: fullName, source: 'inbound_interface', test: lookup.test_mode },
    })
    await emitRegister(tx, principal, {
      kind: 'record.created',
      subjectType: 'intake_record',
      subject: intakeId,
      detail: { source_integration_key: lookup.id, test: lookup.test_mode },
    })
    await emitRegister(tx, principal, {
      kind: 'key.used',
      subjectType: 'integration_key',
      subject: lookup.id,
      detail: { outcome: 'created', created_type: 'intake_record', created: intakeId },
    })
    return {
      outcome: 'created' as const,
      submission: sub.rows[0].id as number,
      acknowledgement,
    }
  }).catch(async (err: unknown) => {
    // the unique idempotency index closes the race two concurrent identical
    // submissions open: the loser replays the winner's stored acknowledgement
    if (isUniqueViolation(err)) {
      const raced = await withPrincipal(principal, async (tx) => {
        const orig = await tx.query(
          `select id, acknowledgement from deedbox.inbound_submission
            where key = $1 and idempotency_key = $2 and outcome in ('created','rejected')`,
          [lookup.id, req.idempotencyKey],
        )
        const r = await tx.query(
          `insert into deedbox.inbound_submission
             (key, idempotency_key, payload_version, payload_verbatim, outcome,
              created_type, acknowledgement, original, test)
           values ($1, $2, $3, $4, 'duplicate_replayed', 'none', $5, $6, $7)
           returning id`,
          [
            lookup.id,
            req.idempotencyKey,
            req.payloadVersion,
            JSON.stringify(req.payload ?? null),
            JSON.stringify(orig.rows[0].acknowledgement),
            orig.rows[0].id,
            lookup.test_mode,
          ],
        )
        return { submission: r.rows[0].id as number, acknowledgement: orig.rows[0].acknowledgement }
      })
      return { outcome: 'duplicate_replayed' as const, ...raced }
    }
    throw err
  })
}

function isUniqueViolation(err: unknown): boolean {
  return (
    typeof err === 'object' &&
    err !== null &&
    (err as { code?: string }).code === '23505' &&
    String((err as { constraint?: string }).constraint ?? '').includes('inbound_submission_idempotent')
  )
}

/** A rejection in its own transaction (the checks before creation opened none). */
async function reject(
  principal: Principal,
  req: SubmissionRequest,
  key: KeyRow,
  reason: string,
  acknowledgement: unknown,
): Promise<SubmissionOutcome> {
  try {
    return await withPrincipal(principal, (tx) =>
      rejectInTx(tx, principal, req, key, reason, acknowledgement),
    )
  } catch (err) {
    // a concurrent identical submission won the idempotency slot between the
    // check and this insert: replay the winner's stored acknowledgement
    if (!isUniqueViolation(err)) throw err
    const raced = await withPrincipal(principal, async (tx) => {
      const orig = await tx.query(
        `select id, acknowledgement from deedbox.inbound_submission
          where key = $1 and idempotency_key = $2 and outcome in ('created','rejected')`,
        [key.id, req.idempotencyKey],
      )
      const r = await tx.query(
        `insert into deedbox.inbound_submission
           (key, idempotency_key, payload_version, payload_verbatim, outcome,
            created_type, acknowledgement, original, test)
         values ($1, $2, $3, $4, 'duplicate_replayed', 'none', $5, $6, $7)
         returning id`,
        [
          key.id,
          req.idempotencyKey,
          req.payloadVersion,
          JSON.stringify(req.payload ?? null),
          JSON.stringify(orig.rows[0].acknowledgement),
          orig.rows[0].id,
          key.test_mode,
        ],
      )
      return { submission: r.rows[0].id as number, acknowledgement: orig.rows[0].acknowledgement }
    })
    return { outcome: 'duplicate_replayed', ...raced }
  }
}

async function rejectInTx(
  tx: Tx,
  principal: Principal,
  req: SubmissionRequest,
  key: KeyRow,
  reason: string,
  acknowledgement: unknown,
): Promise<SubmissionOutcome> {
  const r = await tx.query(
    `insert into deedbox.inbound_submission
       (key, idempotency_key, payload_version, payload_verbatim, outcome,
        created_type, acknowledgement, rejection_reason, test)
     values ($1, $2, $3, $4, 'rejected', 'none', $5, $6, $7)
     returning id`,
    [
      key.id,
      req.idempotencyKey,
      req.payloadVersion,
      JSON.stringify(req.payload ?? null),
      JSON.stringify(acknowledgement),
      reason,
      key.test_mode,
    ],
  )
  await emitRegister(tx, principal, {
    kind: 'key.used',
    subjectType: 'integration_key',
    subject: key.id,
    detail: { outcome: 'rejected', reason },
  })
  return { outcome: 'rejected', submission: r.rows[0].id as number, acknowledgement }
}

/**
 * The deferred-decision review queue's single transition: unreviewed →
 * reviewed when a staff member confirms the record.
 */
export async function reviewDuplicateDecision(
  p: Principal,
  input: { decision: number },
): Promise<void> {
  requireStaff(p)
  await withPrincipal(p, async (tx) => {
    const cur = await tx.query(
      `select id, reviewed_at from deedbox.duplicate_decision where id = $1 for update`,
      [input.decision],
    )
    if (cur.rowCount === 0) {
      throw new OperationRefused('not_found', 'duplicate decision not found')
    }
    if (cur.rows[0].reviewed_at !== null) {
      throw new OperationRefused('already_reviewed', 'this decision is already reviewed')
    }
    await tx.query(
      `update deedbox.duplicate_decision set reviewed_by = $2, reviewed_at = now() where id = $1`,
      [input.decision, p.id],
    )
    await emitRegister(tx, p, {
      kind: 'record.changed',
      subjectType: 'duplicate_decision',
      subject: input.decision,
      detail: { before: { reviewed: false }, after: { reviewed: true } },
    })
  })
}
