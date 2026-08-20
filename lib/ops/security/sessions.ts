// Sign-in session establishment, step-up, termination, device revocation,
// and the timeout job.
//
// The architecture binds here: the hosted platform's auth service
// AUTHENTICATES (passwords, identity provider, factors); this layer
// resolves the authenticated identity to a staff row, maintains the
// terminal session and device records, applies the auth policy's gates,
// and AUTHORISES every subsequent request. The seam-facing contract:
// establishStaffSession is called only after the auth service has
// verified the person; mfaSatisfied carries the seam's factor assertion.
//
// Implementation notes:
//   * The auth-policy row is per firm; absent (a firm provisioned before
//     the policy screen) the shipped defaults apply: mfa off, step-up on
//     unrecognised devices ON, email fallback ON.
//   * The four auth timing values (idle 60m, absolute 24h, step-up
//     freshness 10m, device trust 90d) read the settings catalogue first
//     and fall back to the shipped defaults where the closed catalogue
//     carries no row.
//   * Failed sign-ins register in their OWN committed transaction (there
//     is no business transaction to preserve); an unknown login is
//     recorded as the system actor with the attempted string in the
//     detail, so failures can never smear the wrong person.

import type { Principal, Tx } from '@/lib/db'
import { withPrincipal, emitRegister, OperationRefused } from '@/lib/db'
import { requireStaff, hasCapability, settingText } from '@/lib/ops/shared'
import { queueOutboundMessageInTx } from '@/lib/ops/outbound'

async function authNumber(tx: Tx, key: string, fallback: number): Promise<number> {
  const v = await settingText(tx, key)
  return v === null ? fallback : Number(v)
}

interface AuthPolicy {
  mfa_scope: 'off' | 'named_roles' | 'all_users'
  mfa_roles: number[] | null
  step_up_on_unrecognised: boolean
  step_up_email_fallback: boolean
}

async function policyFor(tx: Tx, firm: number): Promise<AuthPolicy> {
  const r = await tx.query(
    `select mfa_scope, mfa_roles, step_up_on_unrecognised, step_up_email_fallback
       from deedbox.auth_policy where firm = $1`,
    [firm],
  )
  if (r.rowCount === 0) {
    return {
      mfa_scope: 'off',
      mfa_roles: null,
      step_up_on_unrecognised: true,
      step_up_email_fallback: true,
    }
  }
  return r.rows[0] as unknown as AuthPolicy
}

export interface SignInInput {
  login: string
  firm: number
  /** The auth seam's factor assertion for this sign-in. */
  mfaSatisfied?: boolean
  device: { fingerprint: string; label?: string; networkHint?: string }
}

export interface SignInOutcome {
  session: number
  staff: number
  stepUpRequired: boolean
}

/**
 * Establish a session for an authenticated identity. Refusals
 * write signin.failed in their own committed transaction and rethrow.
 */
export async function establishStaffSession(input: SignInInput): Promise<SignInOutcome> {
  const system: Principal = { kind: 'system_job', id: 0, firm: input.firm }
  try {
    return await withPrincipal(system, async (tx) => {
      const staff = await tx.query(
        `select s.id, s.role, s.email, s.active, s.mfa_enrolled, r.active as role_active
           from deedbox.staff_member s join deedbox.role r on r.id = s.role
          where lower(s.login) = lower($1)`,
        [input.login],
      )
      if (staff.rowCount === 0) {
        throw new SignInRefused('unknown_login', 'no staff member with that login', null)
      }
      const row = staff.rows[0]
      const staffId = row.id as number
      if (!row.active) throw new SignInRefused('inactive_account', 'this account is deactivated', staffId)
      if (!row.role_active) {
        throw new SignInRefused('inactive_role', "this account's role is deactivated", staffId)
      }
      const policy = await policyFor(tx, input.firm)
      const mfaRequired =
        policy.mfa_scope === 'all_users' ||
        (policy.mfa_scope === 'named_roles' && (policy.mfa_roles ?? []).includes(row.role as number))
      if (mfaRequired) {
        if (!row.mfa_enrolled) {
          throw new SignInRefused(
            'mfa_enrolment_required',
            'policy requires a second factor — enrol one to sign in',
            staffId,
          )
        }
        if (!input.mfaSatisfied) {
          throw new SignInRefused('mfa_required', 'the second factor was not satisfied', staffId)
        }
      }

      // device recognition: upsert by (owner, fingerprint); a new row or a
      // novel network hint is unrecognised
      const existing = await tx.query(
        `select id, revoked_at, network_hint, trusted,
                trust_expires_at is not null and trust_expires_at < now() as trust_lapsed
           from deedbox.device
          where owner_kind = 'staff' and owner = $1 and fingerprint = $2`,
        [staffId, input.device.fingerprint],
      )
      let deviceId: number
      let unrecognised: boolean
      if (existing.rowCount === 0) {
        const d = await tx.query(
          `insert into deedbox.device (owner_kind, owner, fingerprint, label, network_hint)
           values ('staff', $1, $2, $3, $4) returning id`,
          [staffId, input.device.fingerprint, input.device.label ?? null, input.device.networkHint ?? null],
        )
        deviceId = d.rows[0].id as number
        unrecognised = true
      } else {
        if (existing.rows[0].revoked_at !== null) {
          throw new SignInRefused('device_revoked', 'this device has been revoked', staffId)
        }
        // a known, unrevoked fingerprint is recognised; only a novel network
        // hint re-opens the question
        unrecognised =
          input.device.networkHint !== undefined &&
          existing.rows[0].network_hint !== null &&
          existing.rows[0].network_hint !== input.device.networkHint
        await tx.query(
          `update deedbox.device set last_seen = now(), network_hint = coalesce($2, network_hint)
            where id = $1`,
          [existing.rows[0].id, input.device.networkHint ?? null],
        )
        deviceId = existing.rows[0].id as number
      }
      const stepUpRequired = unrecognised && policy.step_up_on_unrecognised

      const actor: Principal = { kind: 'staff', id: staffId, firm: input.firm }
      const sess = await tx.query(
        `insert into deedbox.session (principal_kind, principal, device, step_up_required)
         values ('staff', $1, $2, $3) returning id`,
        [staffId, deviceId, stepUpRequired],
      )
      const sessionId = sess.rows[0].id as number
      await emitRegister(tx, { ...actor, session: sessionId }, {
        kind: 'signin.succeeded',
        subjectType: 'session',
        subject: sessionId,
        detail: {
          device: deviceId,
          recognition: unrecognised ? 'unrecognised' : 'recognised',
          step_up_required: stepUpRequired,
        },
      })
      if (stepUpRequired) {
        await queueOutboundMessageInTx(tx, actor, {
          channel: 'email',
          recipient: row.email as string,
          purpose: 'unrecognised_sign_in',
          content: `A sign-in to your account from an unrecognised device or location is awaiting verification (session ${sessionId}).`,
        })
      }
      return { session: sessionId, staff: staffId, stepUpRequired }
    })
  } catch (err) {
    if (err instanceof SignInRefused) {
      await recordFailedSignIn(input.firm, input.login, err)
      throw new OperationRefused(err.code, err.message)
    }
    throw err
  }
}

class SignInRefused extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly staffId: number | null,
  ) {
    super(message)
  }
}

/** Failure path: its own committed transaction; unknown logins never smear a person. */
async function recordFailedSignIn(firm: number, login: string, refusal: SignInRefused): Promise<void> {
  const principal: Principal =
    refusal.staffId === null
      ? { kind: 'system_job', id: 0, firm }
      : { kind: 'staff', id: refusal.staffId, firm }
  await withPrincipal(principal, async (tx) => {
    await emitRegister(tx, principal, {
      kind: 'signin.failed',
      subjectType: 'staff_member',
      subject: refusal.staffId ?? 0,
      detail: {
        reason: refusal.code,
        attempted_login: refusal.staffId === null ? login : undefined,
      },
    })
  })
}

/**
 * The wrong-credentials failure, recorded on the auth seam's verdict
 * (the seam verifies secrets; this layer records). A staff actor is bound
 * only on an exact login match — anything else records as the system actor
 * with the attempted string, so failures never smear the wrong person.
 */
export async function recordCredentialFailure(firm: number, login: string): Promise<void> {
  const probe = await withPrincipal(
    { kind: 'system_job', id: 0, firm },
    async (tx) => {
      const r = await tx.query(
        `select id from deedbox.staff_member where lower(login) = lower($1)`,
        [login],
      )
      return (r.rows[0]?.id as number | undefined) ?? null
    },
    { readOnly: true },
  )
  await recordFailedSignIn(firm, login, new SignInRefused('bad_credentials', 'the credentials did not verify', probe))
}

/** Complete the step-up challenge; optionally trust the device. */
export async function completeStepUp(
  input: { session: number; firm: number; trustDevice?: boolean },
): Promise<void> {
  const probe = await withPrincipal(
    { kind: 'system_job', id: 0, firm: input.firm },
    async (tx) => {
      const s = await tx.query(
        `select id, principal_kind, principal, device, ended_at, step_up_required
           from deedbox.session where id = $1`,
        [input.session],
      )
      if (s.rowCount === 0) throw new OperationRefused('not_found', 'session not found')
      return s.rows[0]
    },
    { readOnly: true },
  )
  if (probe.ended_at !== null) throw new OperationRefused('session_ended', 'this session has ended')
  const actor: Principal = {
    kind: 'staff',
    id: probe.principal as number,
    firm: input.firm,
    session: input.session,
  }
  await withPrincipal(actor, async (tx) => {
    await tx.query(
      `update deedbox.session
          set step_up_passed = true, step_up_at = now(), step_up_required = false
        where id = $1`,
      [input.session],
    )
    if (input.trustDevice) {
      const days = await authNumber(tx, 'auth.device_trust_days', 90)
      await tx.query(
        `update deedbox.device
            set trusted = true, trusted_at = now(),
                trust_expires_at = now() + make_interval(days => $2)
          where id = $1`,
        [probe.device, days],
      )
      await emitRegister(tx, actor, {
        kind: 'record.changed',
        subjectType: 'device',
        subject: probe.device as number,
        detail: { before: { trusted: false }, after: { trusted: true } },
      })
    }
    await emitRegister(tx, actor, {
      kind: 'signin.step_up',
      subjectType: 'session',
      subject: input.session,
      detail: { device_trusted: input.trustDevice ?? false },
    })
  })
}

/** Step-up failure: its own transaction; the session stays unusable. */
export async function recordStepUpFailure(input: { session: number; firm: number }): Promise<void> {
  await withPrincipal({ kind: 'system_job', id: 0, firm: input.firm }, async (tx) => {
    const s = await tx.query(`select principal from deedbox.session where id = $1`, [input.session])
    const actor: Principal = {
      kind: 'staff',
      id: (s.rows[0]?.principal as number) ?? 0,
      firm: input.firm,
    }
    await emitRegister(tx, actor, {
      kind: 'signin.step_up_failed',
      subjectType: 'session',
      subject: input.session,
      detail: {},
    })
  })
}

/**
 * `session.assert_step_up` — the dual-control freshness interface the
 * money domain consumes. No writes; the CONSUMER's register entry records
 * that the assertion passed.
 */
export async function assertStepUpInTx(tx: Tx, sessionId: number): Promise<boolean> {
  const minutes = await authNumber(tx, 'auth.step_up_freshness_minutes', 10)
  const r = await tx.query(
    `select exists (
       select 1 from deedbox.session
        where id = $1 and ended_at is null and step_up_passed
          and step_up_at > now() - make_interval(mins => $2)
     ) as fresh`,
    [sessionId, minutes],
  )
  return r.rows[0].fresh as boolean
}

/**
 * The request layer's resolver: session → principal. The
 * step-up gate, the idle and absolute windows, and the staff active flag
 * are all evaluated here per request — no cached capability or visibility
 * exists anywhere.
 */
export async function resolveSessionPrincipal(
  sessionId: number,
  firm: number,
): Promise<Principal> {
  const system: Principal = { kind: 'system_job', id: 0, firm }
  return withPrincipal(system, async (tx) => {
    const idle = await authNumber(tx, 'auth.session_idle_minutes', 60)
    const absolute = await authNumber(tx, 'auth.session_absolute_hours', 24)
    const s = await tx.query(
      `select s.id, s.principal_kind, s.principal, s.ended_at, s.step_up_required,
              s.last_seen_at < now() - make_interval(mins => $2) as idle_expired,
              s.started_at < now() - make_interval(hours => $3) as absolute_expired,
              st.active as staff_active,
              (g.id is not null and g.revoked_at is null
               and now() >= g.starts_at and now() < g.expires_at) as grant_live
         from deedbox.session s
         left join deedbox.staff_member st
           on st.id = s.principal and s.principal_kind = 'staff'
         left join deedbox.examiner_grant g
           on g.id = s.examiner_grant and s.principal_kind = 'examiner'
        where s.id = $1`,
      [sessionId, idle, absolute],
    )
    if (s.rowCount === 0) throw new OperationRefused('not_found', 'session not found')
    const row = s.rows[0]
    // the session's own kind, exactly (portal_client sessions arrived with
    // The earlier two-way staff/examiner mapping was a latent defect this
    // slice fixed)
    const kind = row.principal_kind as 'staff' | 'portal_client' | 'examiner'
    if (row.ended_at !== null) throw new OperationRefused('session_ended', 'this session has ended')
    if (row.idle_expired || row.absolute_expired) {
      await endSessionInTx(tx, sessionId, 'timeout', {
        kind,
        id: row.principal as number,
        firm,
      })
      throw new OperationRefused('session_expired', 'this session has timed out')
    }
    if (row.step_up_required) {
      throw new OperationRefused('step_up_required', 'verify this sign-in to continue')
    }
    if (row.principal_kind === 'staff' && !row.staff_active) {
      throw new OperationRefused('inactive_account', 'this account is deactivated')
    }
    if (row.principal_kind === 'examiner' && !row.grant_live) {
      // reads after expires_at (or revocation) are refused — the
      // expiry job sweeps on schedule, but the request layer never waits
      await endSessionInTx(tx, sessionId, 'grant_expired', {
        kind: 'examiner',
        id: row.principal as number,
        firm,
      })
      throw new OperationRefused('session_ended', 'this examiner grant is no longer active')
    }
    await tx.query(`update deedbox.session set last_seen_at = now() where id = $1`, [sessionId])
    return {
      kind,
      id: row.principal as number,
      firm,
      session: sessionId,
    } as Principal
  })
}

async function endSessionInTx(
  tx: Tx,
  sessionId: number,
  reason: string,
  actor: Principal,
): Promise<boolean> {
  const r = await tx.query(
    `update deedbox.session set ended_at = now(), end_reason = $2
      where id = $1 and ended_at is null returning id`,
    [sessionId, reason],
  )
  if (r.rowCount === 0) return false // idempotent: ending an ended session is a no-op
  await emitRegister(tx, actor, {
    kind: 'session.ended',
    subjectType: 'session',
    subject: sessionId,
    detail: { reason },
  })
  return true
}

/** Sign-out (own session) or admin end-one. */
export async function endSession(
  p: Principal,
  input: { session: number },
): Promise<void> {
  requireStaff(p)
  await withPrincipal(p, async (tx) => {
    const s = await tx.query(
      `select principal_kind, principal, ended_at from deedbox.session where id = $1`,
      [input.session],
    )
    if (s.rowCount === 0) throw new OperationRefused('not_found', 'session not found')
    if (s.rows[0].ended_at !== null) return // idempotent
    const own = s.rows[0].principal_kind === 'staff' && s.rows[0].principal === p.id
    if (!own && !(await hasCapability(tx, p.id, 'session.terminate_others'))) {
      throw new OperationRefused('not_yours', "ending another person's session requires session.terminate_others")
    }
    await endSessionInTx(tx, input.session, own ? 'logout' : 'admin_end', p)
  })
}

/** An examiner's own sign-out (the workspace's sign-out button). The
 *  session's own examiner is the acting principal for the logout, exactly as
 *  own-logout works for staff; the recording transaction runs as the system
 *  principal because the examiner's row policies admit only money reads. */
export async function endExaminerSession(sessionId: number, firm: number): Promise<void> {
  const system: Principal = { kind: 'system_job', id: 0, firm }
  await withPrincipal(system, async (tx) => {
    const s = await tx.query(
      `select principal_kind, principal, ended_at from deedbox.session where id = $1`,
      [sessionId],
    )
    if (s.rowCount === 0 || s.rows[0].ended_at !== null) return // idempotent
    if (s.rows[0].principal_kind !== 'examiner') return
    await endSessionInTx(tx, sessionId, 'logout', {
      kind: 'examiner',
      id: s.rows[0].principal as number,
      firm,
      session: sessionId,
    })
  })
}

/** Admin end-all for a person: one ordinary entry per session. */
export async function endAllSessionsFor(
  p: Principal,
  input: { staff: number },
): Promise<{ ended: number }> {
  requireStaff(p)
  return withPrincipal(p, async (tx) => {
    if (input.staff !== p.id && !(await hasCapability(tx, p.id, 'session.terminate_others'))) {
      throw new OperationRefused('not_yours', "ending another person's sessions requires session.terminate_others")
    }
    const sessions = await tx.query(
      `select id from deedbox.session
        where principal_kind = 'staff' and principal = $1 and ended_at is null order by id`,
      [input.staff],
    )
    let ended = 0
    for (const s of sessions.rows) {
      if (await endSessionInTx(tx, s.id as number, 'admin_end', p)) ended++
    }
    return { ended }
  })
}

/** Device revocation; active sessions on it end in the same transaction. */
export async function revokeDevice(
  p: Principal,
  input: { device: number },
): Promise<{ endedSessions: number }> {
  requireStaff(p)
  return withPrincipal(p, async (tx) => {
    const d = await tx.query(
      `select id, owner_kind, owner, revoked_at from deedbox.device where id = $1 for update`,
      [input.device],
    )
    if (d.rowCount === 0) throw new OperationRefused('not_found', 'device not found')
    if (d.rows[0].revoked_at !== null) {
      throw new OperationRefused('already_revoked', 'this device is already revoked')
    }
    const own = d.rows[0].owner_kind === 'staff' && d.rows[0].owner === p.id
    if (!own && !(await hasCapability(tx, p.id, 'session.terminate_others'))) {
      throw new OperationRefused('not_yours', "revoking another person's device requires session.terminate_others")
    }
    await tx.query(
      `update deedbox.device set revoked_at = now(), revoked_by = $2, trusted = false where id = $1`,
      [input.device, p.id],
    )
    const sessions = await tx.query(
      `select id from deedbox.session where device = $1 and ended_at is null order by id`,
      [input.device],
    )
    let endedSessions = 0
    for (const s of sessions.rows) {
      if (await endSessionInTx(tx, s.id as number, 'device_revoked', p)) endedSessions++
    }
    await emitRegister(tx, p, {
      kind: 'record.changed',
      subjectType: 'device',
      subject: input.device,
      detail: { before: { revoked: false }, after: { revoked: true, sessions_ended: endedSessions } },
    })
    return { endedSessions }
  })
}

/** The timeout job: idle and absolute windows from the settings. */
export async function runSessionTimeouts(p: Principal): Promise<{ ended: number }> {
  return withPrincipal(p, async (tx) => {
    const idle = await authNumber(tx, 'auth.session_idle_minutes', 60)
    const absolute = await authNumber(tx, 'auth.session_absolute_hours', 24)
    const stale = await tx.query(
      `select id from deedbox.session
        where ended_at is null
          and (last_seen_at < now() - make_interval(mins => $1)
            or started_at < now() - make_interval(hours => $2))
        order by id`,
      [idle, absolute],
    )
    let ended = 0
    for (const s of stale.rows) {
      if (await endSessionInTx(tx, s.id as number, 'timeout', p)) ended++
    }
    return { ended }
  })
}
