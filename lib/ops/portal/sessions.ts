// Portal sessions: portal clients ride the SAME terminal session machinery
// the schema shipped in 0003 (principal_kind portal_client, the party as
// the principal, device recognition by fingerprint). Returning sign-ins
// resolve the hosted login through the ACCEPTED, unrevoked invite — the
// identity binding acceptance wrote. Portal sessions have no step-up rung
// (recorded: the staff auth policy is staff-scoped; the portal's
// protection is the hosted service's own factors); idle and absolute
// windows are the shared settings, evaluated by resolveSessionPrincipal
// like every other session.

import type { Principal, Tx } from '@/lib/db'
import { withPrincipal, emitRegister, OperationRefused } from '@/lib/db'
import { signInService } from '@/lib/auth/seam'

export async function establishPortalSessionInTx(
  tx: Tx,
  firm: number,
  party: number,
  device: { fingerprint: string; label?: string },
): Promise<number> {
  const existing = await tx.query(
    `select id, revoked_at from deedbox.device
      where owner_kind = 'portal_client' and owner = $1 and fingerprint = $2`,
    [party, device.fingerprint],
  )
  let deviceId: number
  if (existing.rowCount === 0) {
    const d = await tx.query(
      `insert into deedbox.device (owner_kind, owner, fingerprint, label)
       values ('portal_client', $1, $2, $3) returning id`,
      [party, device.fingerprint, device.label ?? null],
    )
    deviceId = d.rows[0].id as number
  } else {
    if (existing.rows[0].revoked_at !== null) {
      throw new OperationRefused('device_revoked', 'this device has been revoked')
    }
    await tx.query(`update deedbox.device set last_seen = now() where id = $1`, [existing.rows[0].id])
    deviceId = existing.rows[0].id as number
  }
  const sess = await tx.query(
    `insert into deedbox.session (principal_kind, principal, device)
     values ('portal_client', $1, $2) returning id`,
    [party, deviceId],
  )
  const sessionId = sess.rows[0].id as number
  const actor: Principal = { kind: 'portal_client', id: party, firm, session: sessionId }
  await emitRegister(tx, actor, {
    kind: 'signin.succeeded',
    subjectType: 'session',
    subject: sessionId,
    detail: { device: deviceId, portal: true },
  })
  return sessionId
}

/** A returning portal sign-in: hosted authentication → the invite binding → a session. */
export async function establishPortalSession(
  firm: number,
  input: { login: string; secret: string; device: { fingerprint: string; label?: string } },
): Promise<{ session: number; party: number }> {
  const auth = await signInService().authenticate(input.login.trim(), input.secret)
  if (!auth.authenticated) {
    throw new OperationRefused('sign_in_failed', 'those sign-in details were not accepted')
  }
  const door: Principal = { kind: 'system_job', id: 0, firm }
  return withPrincipal(door, async (tx) => {
    const inv = await tx.query(
      `select id, party from deedbox.portal_invite
        where lower(login) = lower($1) and accepted_at is not null and revoked_at is null
        order by accepted_at desc limit 1`,
      [input.login.trim()],
    )
    if (inv.rowCount === 0) {
      throw new OperationRefused('no_portal_access', 'that identity has no portal access here')
    }
    await tx.query(`update deedbox.portal_invite set last_login_at = now() where id = $1`, [
      inv.rows[0].id,
    ])
    const session = await establishPortalSessionInTx(tx, firm, inv.rows[0].party as number, input.device)
    return { session, party: inv.rows[0].party as number }
  })
}

/** Portal sign-out: the portal principal ends its own session. */
export async function endPortalSession(firm: number, sessionId: number): Promise<void> {
  const door: Principal = { kind: 'system_job', id: 0, firm }
  await withPrincipal(door, async (tx) => {
    const s = await tx.query(
      `update deedbox.session set ended_at = now(), end_reason = 'logout'
        where id = $1 and principal_kind = 'portal_client' and ended_at is null
        returning principal`,
      [sessionId],
    )
    if ((s.rowCount ?? 0) === 0) return
    await emitRegister(
      tx,
      { kind: 'portal_client', id: s.rows[0].principal as number, firm, session: sessionId },
      {
        kind: 'session.ended',
        subjectType: 'session',
        subject: sessionId,
        detail: { reason: 'logout' },
      },
    )
  })
}
