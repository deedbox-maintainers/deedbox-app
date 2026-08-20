// Microsoft 365 connections: one per staff member, upserted at
// consent, deactivated at disconnect, tokens kept fresh through the seam.
// Register detail NEVER carries a token.

import type { Principal, Tx } from '@/lib/db'
import { withPrincipal, emitRegister, OperationRefused } from '@/lib/db'
import { requireStaff } from '@/lib/ops/shared'
import { m365Service } from './seam'

export async function connectM365Account(p: Principal, input: { code: string }): Promise<void> {
  requireStaff(p)
  const identity = await m365Service().exchangeCode(input.code)
  await withPrincipal(p, async (tx) => {
    await tx.query(
      `insert into deedbox.m365_connection
         (staff, ms_user_id, email, display_name, scopes, access_token, refresh_token, token_expires_at, active)
       values ($1, $2, $3, $4, $5, $6, $7, $8, true)
       on conflict (staff) do update
         set ms_user_id = excluded.ms_user_id, email = excluded.email,
             display_name = excluded.display_name, scopes = excluded.scopes,
             access_token = excluded.access_token, refresh_token = excluded.refresh_token,
             token_expires_at = excluded.token_expires_at, active = true,
             connected_at = now()`,
      [
        p.id,
        identity.msUserId,
        identity.email,
        identity.displayName ?? null,
        identity.scopes ?? null,
        identity.accessToken,
        identity.refreshToken,
        identity.expiresAt,
      ],
    )
    await emitRegister(tx, p, {
      kind: 'record.changed',
      subjectType: 'm365_connection',
      subject: p.id,
      detail: { before: {}, after: { connected: true, email: identity.email } },
    })
  })
}

export async function disconnectM365Account(p: Principal): Promise<void> {
  requireStaff(p)
  await withPrincipal(p, async (tx) => {
    const r = await tx.query(
      `update deedbox.m365_connection set active = false where staff = $1 and active returning email`,
      [p.id],
    )
    if ((r.rowCount ?? 0) === 0) return
    await emitRegister(tx, p, {
      kind: 'record.changed',
      subjectType: 'm365_connection',
      subject: p.id,
      detail: { before: { connected: true }, after: { connected: false } },
    })
  })
}

export interface LiveConnection {
  id: number
  staff: number
  email: string
  accessToken: string
}

/** The staff member's active connection with a fresh access token. */
export async function freshConnectionInTx(tx: Tx, staff: number): Promise<LiveConnection> {
  const r = await tx.query(
    `select id, staff, email, access_token, refresh_token, token_expires_at
       from deedbox.m365_connection where staff = $1 and active`,
    [staff],
  )
  if (r.rowCount === 0) {
    throw new OperationRefused('no_connection', 'no active Microsoft 365 connection for this account')
  }
  const row = r.rows[0]
  if (new Date(row.token_expires_at as string).getTime() - Date.now() > 60_000) {
    return { id: row.id as number, staff, email: row.email as string, accessToken: row.access_token as string }
  }
  const fresh = await m365Service().refresh(row.refresh_token as string)
  await tx.query(
    `update deedbox.m365_connection
        set access_token = $2, refresh_token = $3, token_expires_at = $4
      where id = $1`,
    [row.id, fresh.accessToken, fresh.refreshToken, fresh.expiresAt],
  )
  return { id: row.id as number, staff, email: row.email as string, accessToken: fresh.accessToken }
}
