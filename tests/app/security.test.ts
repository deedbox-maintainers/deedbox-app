// Security: session establishment through the auth seam, step-up, the
// request-layer resolver, termination in all its forms, staff
// administration, MFA discipline, examiner grants and the examination
// pack.
//
// Cross-suite contract: runs after reports, before workflow. The MFA test
// writes this firm's auth_policy row and resets it inside the same test.
// The last-administrator refusals are proven by the schema suite (0003) —
// on the shared scratch other suites' administrators always exist, so the
// refusal branch is unreachable here by construction.

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import type { Pool } from 'pg'
import { closePool, withPrincipal, emitRegister } from '@/lib/db'
import type { Principal } from '@/lib/db'
import {
  runAnomalyEvaluation,
  runChainVerification,
  establishStaffSession,
  completeStepUp,
  resolveSessionPrincipal,
  endSession,
  endAllSessionsFor,
  revokeDevice,
  runSessionTimeouts,
  createStaffMember,
  changeStaffRole,
  deactivateStaff,
  reactivateStaff,
  enrolMfaCredential,
  removeMfaCredential,
  grantExaminer,
  revokeExaminer,
  examinerSignIn,
  runExaminerExpiry,
  exportExaminationPack,
} from '@/lib/ops/security'
import { makeAdminPool, buildFixture, type Fixture } from './helpers'

let admin: Pool
let fx: Fixture
let P: Principal
const JOBP = (): Principal => ({ kind: 'system_job', id: 16, firm: fx.firm })

async function signIn(login: string, fingerprint: string, extra: object = {}) {
  return establishStaffSession({
    login,
    firm: fx.firm,
    device: { fingerprint, ...extra },
  })
}

beforeAll(async () => {
  admin = makeAdminPool()
  fx = await buildFixture(admin, 'secu')
  P = { kind: 'staff', id: fx.staff, firm: fx.firm }
})

afterAll(async () => {
  await closePool()
  await admin.end()
})

describe('sign-in and step-up', () => {
  it('an unrecognised first device requires step-up; trusting it makes the next sign-in clean', async () => {
    const first = await signIn('pat.secu', 'fp-laptop-1')
    expect(first.stepUpRequired).toBe(true)
    // unusable until the challenge
    await expect(resolveSessionPrincipal(first.session, fx.firm)).rejects.toMatchObject({
      code: 'step_up_required',
    })
    // the notification queued to the recorded email
    const note = await admin.query(
      `select count(*)::int as n from deedbox.outbound_message
        where purpose = 'unrecognised_sign_in' and recipient = 'pat.secu@example.test'`,
    )
    expect(note.rows[0].n).toBe(1)

    await completeStepUp({ session: first.session, firm: fx.firm, trustDevice: true })
    const resolved = await resolveSessionPrincipal(first.session, fx.firm)
    expect(resolved.kind).toBe('staff')
    expect(resolved.id).toBe(fx.staff)
    expect(resolved.session).toBe(first.session)

    const second = await signIn('pat.secu', 'fp-laptop-1')
    expect(second.stepUpRequired).toBe(false)
    const evt = await admin.query(
      `select detail ->> 'recognition' as r from deedbox.register_entry
        where event_kind = 'signin.succeeded' and subject = $1`,
      [second.session],
    )
    expect(evt.rows[0].r).toBe('recognised')
  })

  it('unknown logins fail as the system actor with the attempt in detail', async () => {
    await expect(signIn('nobody.secu', 'fp-x')).rejects.toMatchObject({ code: 'unknown_login' })
    const evt = await admin.query(
      `select actor_kind, detail ->> 'attempted_login' as l from deedbox.register_entry
        where event_kind = 'signin.failed' and detail ->> 'attempted_login' = 'nobody.secu'`,
    )
    expect(evt.rowCount).toBe(1)
    expect(evt.rows[0].actor_kind).toBe('system_job')
  })

  it('the MFA policy gates sign-in: enrolment demanded, then the factor', async () => {
    await admin.query(
      `insert into deedbox.auth_policy (firm, mfa_scope) values ($1, 'all_users')
       on conflict (firm) do update set mfa_scope = 'all_users'`,
      [fx.firm],
    )
    try {
      await expect(signIn('pat.secu', 'fp-laptop-1')).rejects.toMatchObject({
        code: 'mfa_enrolment_required',
      })
      await enrolMfaCredential(P, { factorKind: 'totp', secretRef: 'vault:secu-totp-1' })
      const mirrored = await admin.query(
        `select mfa_enrolled from deedbox.staff_member where id = $1`,
        [fx.staff],
      )
      expect(mirrored.rows[0].mfa_enrolled).toBe(true)
      await expect(signIn('pat.secu', 'fp-laptop-1')).rejects.toMatchObject({ code: 'mfa_required' })
      const ok = await establishStaffSession({
        login: 'pat.secu',
        firm: fx.firm,
        mfaSatisfied: true,
        device: { fingerprint: 'fp-laptop-1' },
      })
      expect(ok.stepUpRequired).toBe(false)
    } finally {
      await admin.query(`update deedbox.auth_policy set mfa_scope = 'off' where firm = $1`, [fx.firm])
    }
  })

  it('removing your own factor needs a fresh step-up; the mirror follows', async () => {
    const cred = await admin.query(
      `select id from deedbox.mfa_credential where staff = $1 and revoked_at is null`,
      [fx.staff],
    )
    await expect(
      removeMfaCredential(P, { credential: cred.rows[0].id as number }),
    ).rejects.toMatchObject({ code: 'step_up_required' })
    await removeMfaCredential(P, { credential: cred.rows[0].id as number, stepUpFresh: true })
    const mirrored = await admin.query(
      `select mfa_enrolled from deedbox.staff_member where id = $1`,
      [fx.staff],
    )
    expect(mirrored.rows[0].mfa_enrolled).toBe(false)
  })
})

describe('termination in all its forms', () => {
  it('sign-out, admin end-all, and the timeout job each end with the honest reason', async () => {
    const s1 = await signIn('pat.secu', 'fp-laptop-1')
    await endSession(P, { session: s1.session })
    const ended = await admin.query(
      `select end_reason from deedbox.session where id = $1`,
      [s1.session],
    )
    expect(ended.rows[0].end_reason).toBe('logout')
    await endSession(P, { session: s1.session }) // idempotent no-op

    const s2 = await signIn('pat.secu', 'fp-laptop-1')
    const s3 = await signIn('pat.secu', 'fp-laptop-1')
    const all = await endAllSessionsFor(P, { staff: fx.staff })
    expect(all.ended).toBeGreaterThanOrEqual(2)
    const events = await admin.query(
      `select count(*)::int as n from deedbox.register_entry
        where event_kind = 'session.ended' and subject in ($1, $2)`,
      [s2.session, s3.session],
    )
    expect(events.rows[0].n).toBe(2) // one ordinary entry per session

    const s4 = await signIn('pat.secu', 'fp-laptop-1')
    await admin.query(
      `update deedbox.session set last_seen_at = now() - interval '2 hours' where id = $1`,
      [s4.session],
    )
    const swept = await runSessionTimeouts(JOBP())
    expect(swept.ended).toBeGreaterThanOrEqual(1)
    const t = await admin.query(`select end_reason from deedbox.session where id = $1`, [s4.session])
    expect(t.rows[0].end_reason).toBe('timeout')
  })

  it('device revocation cascades to its sessions in one transaction', async () => {
    const s = await signIn('pat.secu', 'fp-phone-9')
    await completeStepUp({ session: s.session, firm: fx.firm })
    const device = await admin.query(
      `select device from deedbox.session where id = $1`,
      [s.session],
    )
    const r = await revokeDevice(P, { device: device.rows[0].device as number })
    expect(r.endedSessions).toBe(1)
    const row = await admin.query(
      `select end_reason from deedbox.session where id = $1`,
      [s.session],
    )
    expect(row.rows[0].end_reason).toBe('device_revoked')
    // a revoked device refuses the next sign-in
    await expect(signIn('pat.secu', 'fp-phone-9')).rejects.toMatchObject({ code: 'device_revoked' })
  })
})

describe('staff administration', () => {
  let paralegalRole: number
  let member: number

  it('creates staff, changes role with the privileged entry, deactivates ending sessions', async () => {
    const role = await admin.query(
      `insert into deedbox.role (name) values ('Paralegal secu') returning id`,
    )
    paralegalRole = role.rows[0].id as number
    member = (
      await createStaffMember(P, {
        personName: { given: 'Nel', family: 'Newstaff', display: 'Nel Newstaff' },
        login: 'nel.secu',
        role: fx.adminRole,
        office: fx.office,
        email: 'nel.secu@example.test',
      })
    ).id
    await expect(
      createStaffMember(P, {
        personName: { display: 'Dup' },
        login: 'NEL.SECU',
        role: fx.adminRole,
        office: fx.office,
        email: 'dup@example.test',
      }),
    ).rejects.toMatchObject({ code: 'login_taken' })

    await changeStaffRole(P, { staff: member, role: paralegalRole })
    const evt = await admin.query(
      `select privileged, detail from deedbox.register_entry
        where event_kind = 'permission.changed' and subject_type = 'staff_member' and subject = $1`,
      [member],
    )
    expect(evt.rows[0].privileged).toBe(true)
    expect((evt.rows[0].detail as { after: { role: number } }).after.role).toBe(paralegalRole)

    // an open session dies inside the deactivating transaction (schema guard)
    const s = await signIn('nel.secu', 'fp-nel-1')
    await deactivateStaff(P, { staff: member })
    const sess = await admin.query(`select end_reason from deedbox.session where id = $1`, [s.session])
    expect(sess.rows[0].end_reason).toBe('deactivation')
    const dEvt = await admin.query(
      `select privileged, detail -> 'after' ->> 'sessions_ended' as n from deedbox.register_entry
        where event_kind = 'staff.deactivated' and subject = $1`,
      [member],
    )
    expect(dEvt.rows[0].privileged).toBe(true)
    expect(Number(dEvt.rows[0].n)).toBeGreaterThanOrEqual(1)
    await expect(signIn('nel.secu', 'fp-nel-1')).rejects.toMatchObject({ code: 'inactive_account' })

    await reactivateStaff(P, { staff: member })
    const back = await signIn('nel.secu', 'fp-nel-1')
    expect(back.staff).toBe(member)
  })
})

describe('examiners', () => {
  let grant: { id: number; secret: string }

  it('grants, signs in within the window, revokes ending the session', async () => {
    grant = await grantExaminer(P, {
      examinerName: 'Iris Inspector',
      login: 'iris.examiner.secu',
      periodStart: '2020-01-01',
      periodEnd: '2020-12-31',
      startsAt: new Date(Date.now() - 3600_000).toISOString(),
      expiresAt: new Date(Date.now() + 3600_000).toISOString(),
    })
    expect(grant.secret.length).toBeGreaterThan(20)
    const gEvt = await admin.query(
      `select privileged from deedbox.register_entry
        where event_kind = 'examiner.granted' and subject = $1`,
      [grant.id],
    )
    expect(gEvt.rows[0].privileged).toBe(true)

    await expect(
      examinerSignIn({
        login: 'iris.examiner.secu',
        secret: 'wrong',
        firm: fx.firm,
        device: { fingerprint: 'fp-iris-1' },
      }),
    ).rejects.toMatchObject({ code: 'unauthenticated' })
    const session = await examinerSignIn({
      login: 'iris.examiner.secu',
      secret: grant.secret,
      firm: fx.firm,
      device: { fingerprint: 'fp-iris-1' },
    })
    expect(session.grant).toBe(grant.id)

    const revoked = await revokeExaminer(P, { grant: grant.id, reason: 'engagement concluded' })
    expect(revoked.endedSessions).toBe(1)
    const s = await admin.query(`select end_reason from deedbox.session where id = $1`, [
      session.session,
    ])
    expect(s.rows[0].end_reason).toBe('grant_expired')
    await expect(
      examinerSignIn({
        login: 'iris.examiner.secu',
        secret: grant.secret,
        firm: fx.firm,
        device: { fingerprint: 'fp-iris-1' },
      }),
    ).rejects.toMatchObject({ code: 'unauthenticated' })
  })

  it('the expiry job ends sessions of grants past their window', async () => {
    const g = await admin.query(
      `insert into deedbox.examiner_grant
         (examiner_name, login, secret_hash, period_start, period_end,
          starts_at, expires_at, granted_by)
       values ('Old Examiner', 'old.examiner.secu', 'x', '2019-01-01', '2019-12-31',
               now() - interval '3 hours', now() - interval '1 hour', $1) returning id`,
      [fx.staff],
    )
    const d = await admin.query(
      `insert into deedbox.device (owner_kind, owner, fingerprint)
       values ('examiner', $1, 'fp-old-1') returning id`,
      [g.rows[0].id],
    )
    const s = await admin.query(
      `insert into deedbox.session (principal_kind, principal, device, examiner_grant)
       values ('examiner', $1, $2, $1) returning id`,
      [g.rows[0].id, d.rows[0].id],
    )
    const swept = await runExaminerExpiry({ kind: 'system_job', id: 17, firm: fx.firm })
    expect(swept.ended).toBeGreaterThanOrEqual(1)
    const row = await admin.query(`select end_reason from deedbox.session where id = $1`, [
      s.rows[0].id,
    ])
    expect(row.rows[0].end_reason).toBe('grant_expired')
  })

  it('exports the examination pack for a period as staff; the examiner path refuses honestly', async () => {
    // the bkim suite's imported 2020 history is in this scratch — the pack
    // for that year carries its ledgers under the fixed minimal header
    const pack = await exportExaminationPack(P, {
      periodStart: '2020-01-01',
      periodEnd: '2020-12-31',
    })
    expect(pack.transactions).toBeGreaterThanOrEqual(3)
    const artefact = await admin.query(
      `select content_ref from deedbox.stored_artefact where id = $1`,
      [pack.artefact],
    )
    const content = artefact.rows[0].content_ref as string
    expect(content).toMatch(/ledger_number/)
    expect(content).toMatch(/client_display_name/)
    expect(content).toMatch(/matter_reference/)
    const k21 = await admin.query(
      `select exported_by_kind from deedbox.examination_pack_export where artefact = $1`,
      [String(pack.artefact)],
    )
    expect(k21.rows[0].exported_by_kind).toBe('staff')
    const evt = await admin.query(
      `select privileged from deedbox.register_entry
        where event_kind = 'export.performed' and subject_type = 'examination_pack_export'
          and subject = $1`,
      [pack.artefact],
    )
    expect(evt.rows[0].privileged).toBe(true)

    // the examiner path is live since schema change 0025 and the
    // examiner-screens suite proves it end-to-end; here the REVOKED grant
    // from the earlier test proves the branch demands a live one
    await expect(
      exportExaminationPack(
        { kind: 'examiner', id: grant.id, firm: fx.firm },
        { periodStart: '2020-01-01', periodEnd: '2020-12-31' },
      ),
    ).rejects.toMatchObject({ code: 'grant_inactive' })
  })
})

describe('anomaly evaluation and the chain verifier (0027)', () => {
  const SYS = (): Principal => ({ kind: 'system_job', id: 18, firm: fx.firm })

  it('evaluation raises on repeated failures exactly once, then on a large export', async () => {
    // five failed sign-ins aimed at one unknown login, as the platform
    await withPrincipal({ kind: 'system_job', id: 0, firm: fx.firm }, async (tx) => {
      for (let i = 0; i < 5; i++) {
        await emitRegister(tx, { kind: 'system_job', id: 0, firm: fx.firm }, {
          kind: 'signin.failed',
          subjectType: 'staff_member',
          subject: 0,
          detail: { reason: 'bad_credentials', attempted_login: 'evil.secu' },
        })
      }
    })
    const first = await runAnomalyEvaluation(SYS())
    expect(first.raised).toBeGreaterThanOrEqual(1)
    const alert = await admin.query(
      `select a.id, a.summary from deedbox.anomaly_alert a
        join deedbox.anomaly_rule r on r.id = a.rule
       where r.key = 'repeated_sign_in_failure' and a.summary like '%evil.secu%'`,
    )
    expect(alert.rowCount).toBe(1)
    const raisedEvt = await admin.query(
      `select 1 from deedbox.register_entry
        where event_kind = 'anomaly.raised' and subject_type = 'anomaly_alert' and subject = $1`,
      [alert.rows[0].id],
    )
    expect(raisedEvt.rowCount).toBe(1)
    // the administrator notification is queued in the same transaction
    const mail = await admin.query(
      `select 1 from deedbox.outbound_message
        where purpose = 'anomaly_alert' and related_type = 'anomaly_alert' and related = $1`,
      [alert.rows[0].id],
    )
    expect(mail.rowCount).toBeGreaterThanOrEqual(1)

    // exactly-once: the cursor advanced with the raise, a re-run raises nothing
    const second = await runAnomalyEvaluation(SYS())
    expect(second.raised).toBe(0)

    // a large export past the cursor raises independently
    await withPrincipal({ kind: 'system_job', id: 0, firm: fx.firm }, async (tx) => {
      await emitRegister(tx, { kind: 'system_job', id: 0, firm: fx.firm }, {
        kind: 'export.performed',
        subjectType: 'report_export',
        subject: 990001,
        privileged: true,
        detail: { before: null, after: { rows: 20000, restricted_matters: 0 } },
      })
    })
    const third = await runAnomalyEvaluation(SYS())
    expect(third.raised).toBeGreaterThanOrEqual(1)
    const big = await admin.query(
      `select 1 from deedbox.anomaly_alert a join deedbox.anomaly_rule r on r.id = a.rule
        where r.key = 'large_export' and a.summary like '%20000 rows%'`,
    )
    expect(big.rowCount).toBe(1)
  })

  it('the verifier checkpoints a clean chain, detects tampering, and recovers', async () => {
    const clean = await runChainVerification(SYS())
    expect(clean.breaks).toBe(0)
    const verified = await admin.query(
      `select (detail ->> 'checkpoint_seq')::bigint as c from deedbox.register_entry
        where firm = $1 and event_kind = 'chain.verified' order by seq desc limit 1`,
      [fx.firm],
    )
    expect(Number(verified.rows[0].c)).toBe(clean.to)

    // tamper with one historic entry via the deployment role (triggers off),
    // exactly the tampered shape — then restore it byte-for-byte
    const victim = await admin.query(
      `select id, seq, detail from deedbox.register_entry
        where firm = $1 and event_kind = 'signin.failed' order by seq limit 1`,
      [fx.firm],
    )
    const victimId = victim.rows[0].id as number
    await admin.query(`alter table deedbox.register_entry disable trigger register_entry_append_only`)
    try {
      await admin.query(`update deedbox.register_entry set detail = '{"forged":true}' where id = $1`, [
        victimId,
      ])
      const broken = await runChainVerification(SYS())
      expect(broken.breaks).toBeGreaterThanOrEqual(1)
      expect(broken.firstBadSeq).toBe(victim.rows[0].seq)
      const breakEvt = await admin.query(
        `select 1 from deedbox.register_entry
          where firm = $1 and event_kind = 'chain.break_detected'`,
        [fx.firm],
      )
      expect(breakEvt.rowCount).toBeGreaterThanOrEqual(1)
      const alert = await admin.query(
        `select 1 from deedbox.anomaly_alert a join deedbox.anomaly_rule r on r.id = a.rule
          where r.key = 'chain_break'`,
      )
      expect(alert.rowCount).toBeGreaterThanOrEqual(1)
      // restore the exact original payload
      await admin.query(`update deedbox.register_entry set detail = $2 where id = $1`, [
        victimId,
        victim.rows[0].detail,
      ])
    } finally {
      await admin.query(`alter table deedbox.register_entry enable trigger register_entry_append_only`)
    }
    // the checkpoint never advanced past the break; the next walk is clean
    const recovered = await runChainVerification(SYS())
    expect(recovered.breaks).toBe(0)
  })
})
