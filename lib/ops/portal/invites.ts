// Portal invites (schema change 0034): a staff-issued invitation
// binding a party to a hosted sign-in identity. The token is shown once at
// creation (only its fingerprint is stored); acceptance authenticates
// against the hosted seam and writes the binding exactly once (the schema
// guards it); revocation ends every live portal session for the party in
// the same transaction (the staff-deactivation precedent).

import { randomBytes } from 'node:crypto'
import type { Principal, Tx } from '@/lib/db'
import { withPrincipal, emitRegister, OperationRefused } from '@/lib/db'
import { requireStaff } from '@/lib/ops/shared'
import { signInService } from '@/lib/auth/seam'
import { sha256Hex } from '@/lib/ops/documents/sharing'
import { establishPortalSessionInTx } from './sessions'

export async function createPortalInvite(
  p: Principal,
  input: { party: number; email: string; expiresDays?: number },
): Promise<{ invite: number; token: string }> {
  requireStaff(p)
  return withPrincipal(p, async (tx) => {
    const party = await tx.query(
      `select pn.full_name from deedbox.party pt
         join deedbox.party_name pn on pn.party = pt.id and pn.name_kind = 'current'
        where pt.id = $1`,
      [input.party],
    )
    if (party.rowCount === 0) throw new OperationRefused('not_found', 'no party by that id')
    const token = `pin_${randomBytes(24).toString('hex')}`
    const days = input.expiresDays && input.expiresDays > 0 ? input.expiresDays : 14
    const row = await tx.query(
      `insert into deedbox.portal_invite (party, email, token_hash, invited_by, expires_at)
       values ($1, $2, $3, $4, now() + make_interval(days => $5)) returning id`,
      [input.party, input.email.trim(), sha256Hex(token), p.id, days],
    )
    const invite = row.rows[0].id as number
    await emitRegister(tx, p, {
      kind: 'record.created',
      subjectType: 'portal_invite',
      subject: invite,
      detail: { party: input.party, email: input.email.trim(), expires_days: days },
    })
    return { invite, token }
  })
}

/** Revocation ends every live portal session for the party, in-transaction. */
export async function revokePortalInvite(p: Principal, input: { invite: number }): Promise<void> {
  requireStaff(p)
  await withPrincipal(p, async (tx) => {
    const inv = await tx.query(
      `select party, revoked_at from deedbox.portal_invite where id = $1`,
      [input.invite],
    )
    if (inv.rowCount === 0) throw new OperationRefused('not_found', 'no invite by that id')
    if (inv.rows[0].revoked_at) return
    await tx.query(
      `update deedbox.portal_invite set revoked_at = now(), revoked_by = $2 where id = $1`,
      [input.invite, p.id],
    )
    const ended = await tx.query(
      `update deedbox.session set ended_at = now(), end_reason = 'admin_end'
        where principal_kind = 'portal_client' and principal = $1 and ended_at is null
        returning id`,
      [inv.rows[0].party],
    )
    await emitRegister(tx, p, {
      kind: 'record.changed',
      subjectType: 'portal_invite',
      subject: input.invite,
      detail: {
        before: { revoked: false },
        after: { revoked: true, sessions_ended: ended.rowCount ?? 0 },
      },
    })
  })
}

/**
 * The public acceptance door: the invited person proves the hosted
 * identity they will use (the seam authenticates), the binding is written
 * exactly once, and their first portal session opens — one transaction.
 */
export async function acceptPortalInvite(
  firm: number,
  token: string,
  input: { login: string; secret: string; device: { fingerprint: string; label?: string } },
): Promise<{ session: number; party: number }> {
  const auth = await signInService().authenticate(input.login.trim(), input.secret)
  if (!auth.authenticated) {
    throw new OperationRefused('sign_in_failed', 'those sign-in details were not accepted')
  }
  const door: Principal = { kind: 'system_job', id: 0, firm }
  return withPrincipal(door, async (tx) => {
    const inv = await tx.query(
      `select id, party, accepted_at, revoked_at, expires_at
         from deedbox.portal_invite where token_hash = $1 for update`,
      [sha256Hex(token)],
    )
    if (inv.rowCount === 0) throw new OperationRefused('share_not_found', 'no such invitation')
    const row = inv.rows[0]
    if (row.revoked_at) throw new OperationRefused('share_revoked', 'this invitation has been revoked')
    if (row.accepted_at) {
      throw new OperationRefused('already_accepted', 'this invitation has already been used — sign in instead')
    }
    if (new Date(row.expires_at as string).getTime() < Date.now()) {
      throw new OperationRefused('share_expired', 'this invitation has expired')
    }
    await tx.query(
      `update deedbox.portal_invite set accepted_at = now(), login = $2 where id = $1`,
      [row.id, input.login.trim()],
    )
    await emitRegister(tx, door, {
      kind: 'record.changed',
      subjectType: 'portal_invite',
      subject: row.id as number,
      detail: { before: { accepted: false }, after: { accepted: true } },
    })
    const session = await establishPortalSessionInTx(tx, firm, row.party as number, input.device)
    return { session, party: row.party as number }
  })
}

/** The staff panel's list for one party. */
export async function listPortalInvites(
  tx: Tx,
  partyId: number,
): Promise<
  {
    id: number
    email: string
    expiresAt: string
    acceptedAt: string | null
    lastLoginAt: string | null
    revoked: boolean
  }[]
> {
  const r = await tx.query(
    `select id, email, expires_at, accepted_at, last_login_at, revoked_at
       from deedbox.portal_invite where party = $1 order by id desc`,
    [partyId],
  )
  return r.rows.map((i) => ({
    id: i.id as number,
    email: i.email as string,
    expiresAt: String(i.expires_at),
    acceptedAt: i.accepted_at ? String(i.accepted_at) : null,
    lastLoginAt: i.last_login_at ? String(i.last_login_at) : null,
    revoked: Boolean(i.revoked_at),
  }))
}
