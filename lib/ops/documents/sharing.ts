// Secure document sharing (schema change 0032). A share pins the
// exact version disclosed, carries only the token's sha256 fingerprint
// (the link's secret is shown once at creation, never stored), and serves
// through the public door under a view budget, expiry, revocation and an
// optional password. Every serve lands on the access evidence log inside
// the same transaction that spends the view.

import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import type { Principal, Tx } from '@/lib/db'
import { withPrincipal, emitRegister, OperationRefused } from '@/lib/db'
import { requireStaff } from '@/lib/ops/shared'

/** The public share/sign doors' register actor (system principal). */
export const SHARE_SIGN_DOOR_ACTOR = 22

export function sha256Hex(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}

function hashesEqual(a: string, b: string): boolean {
  const ha = Buffer.from(a)
  const hb = Buffer.from(b)
  return ha.length === hb.length && timingSafeEqual(ha, hb)
}

export async function createDocumentShare(
  p: Principal,
  input: {
    document: number
    version?: number | null
    recipientName?: string
    recipientEmail?: string
    note?: string
    expiresDays?: number
    maxViews?: number | null
    password?: string
    allowDownload?: boolean
    watermark?: boolean
  },
): Promise<{ share: number; token: string }> {
  requireStaff(p)
  return withPrincipal(p, async (tx) => {
    const d = await tx.query(
      `select d.id, d.current_version, m.status
         from deedbox.document d join deedbox.matter m on m.id = d.matter
        where d.id = $1 and d.soft_deleted_at is null`,
      [input.document],
    )
    if (d.rowCount === 0) throw new OperationRefused('not_found', 'no document by that id')
    const versionNo = input.version ?? (d.rows[0].current_version as number)
    const v = await tx.query(
      `select id from deedbox.document_version where document = $1 and version_no = $2`,
      [input.document, versionNo],
    )
    if (v.rowCount === 0) throw new OperationRefused('not_found', 'no such version')
    const token = `shr_${randomBytes(24).toString('hex')}`
    const days = input.expiresDays && input.expiresDays > 0 ? input.expiresDays : 14
    const row = await tx.query(
      `insert into deedbox.document_share
         (document, version, recipient_name, recipient_email, note, token_hash, password_hash,
          expires_at, max_views, allow_download, watermark, created_by)
       values ($1, $2, $3, $4, $5, $6, $7, now() + make_interval(days => $8), $9, $10, $11, $12)
       returning id`,
      [
        input.document,
        v.rows[0].id,
        input.recipientName ?? null,
        input.recipientEmail ?? null,
        input.note ?? null,
        sha256Hex(token),
        input.password ? sha256Hex(input.password) : null,
        days,
        input.maxViews ?? null,
        input.allowDownload ?? true,
        input.watermark ?? true,
        p.id,
      ],
    )
    const share = row.rows[0].id as number
    await emitRegister(tx, p, {
      kind: 'record.created',
      subjectType: 'document_share',
      subject: share,
      detail: {
        document: input.document,
        version: versionNo,
        recipient: input.recipientEmail ?? input.recipientName ?? null,
        expires_days: days,
        max_views: input.maxViews ?? null,
        password_protected: Boolean(input.password),
      },
    })
    return { share, token }
  })
}

export async function revokeDocumentShare(p: Principal, input: { share: number }): Promise<void> {
  requireStaff(p)
  await withPrincipal(p, async (tx) => {
    const s = await tx.query(
      `select s.id, s.revoked_at
         from deedbox.document_share s
         join deedbox.document d on d.id = s.document
         join deedbox.matter m on m.id = d.matter
        where s.id = $1`,
      [input.share],
    )
    if (s.rowCount === 0) throw new OperationRefused('not_found', 'no share by that id')
    if (s.rows[0].revoked_at) return
    await tx.query(
      `update deedbox.document_share set revoked_at = now(), revoked_by = $2 where id = $1`,
      [input.share, p.id],
    )
    await emitRegister(tx, p, {
      kind: 'record.changed',
      subjectType: 'document_share',
      subject: input.share,
      detail: { before: { revoked: false }, after: { revoked: true } },
    })
  })
}

export interface ResolvedShare {
  share: number
  document: number
  versionId: number
  filename: string
  contentType: string
  storageRef: string
  title: string
  allowDownload: boolean
  watermark: boolean
}

/**
 * The public door's resolution: token → the pinned version's file, spending
 * one view and recording the access INSIDE the same transaction. Typed
 * refusals tell the recipient the honest state of their own link.
 */
export async function resolveShareForServe(
  firm: number,
  token: string,
  password: string | null,
): Promise<ResolvedShare> {
  const door: Principal = { kind: 'system_job', id: SHARE_SIGN_DOOR_ACTOR, firm }
  return withPrincipal(door, async (tx) => {
    const s = await tx.query(
      `select s.id, s.document, s.version, s.password_hash, s.expires_at, s.max_views,
              s.view_count, s.allow_download, s.watermark, s.revoked_at,
              d.title, df.filename, df.content_type, df.storage_ref
         from deedbox.document_share s
         join deedbox.document d on d.id = s.document
         join deedbox.document_version v on v.id = s.version
         join deedbox.document_file df on df.id = v.file
        where s.token_hash = $1`,
      [sha256Hex(token)],
    )
    if (s.rowCount === 0) throw new OperationRefused('share_not_found', 'no such link')
    const row = s.rows[0]
    if (row.revoked_at) throw new OperationRefused('share_revoked', 'this link has been revoked')
    if (new Date(row.expires_at as string).getTime() < Date.now()) {
      throw new OperationRefused('share_expired', 'this link has expired')
    }
    if (row.password_hash) {
      if (!password) throw new OperationRefused('password_required', 'this link needs its password')
      if (!hashesEqual(row.password_hash as string, sha256Hex(password))) {
        throw new OperationRefused('password_wrong', 'that password is not right')
      }
    }
    if (row.max_views !== null && (row.view_count as number) >= (row.max_views as number)) {
      throw new OperationRefused('view_budget_spent', 'this link has reached its view limit')
    }
    await tx.query(`update deedbox.document_share set view_count = view_count + 1 where id = $1`, [
      row.id,
    ])
    await tx.query(
      `insert into deedbox.document_access (document, version, actor_kind, actor, action, detail)
       values ($1, $2, 'share_recipient', $3, 'viewed', $4)`,
      [row.document, row.version, row.id, JSON.stringify({ via: 'share_link' })],
    )
    return {
      share: row.id as number,
      document: row.document as number,
      versionId: row.version as number,
      filename: row.filename as string,
      contentType: row.content_type as string,
      storageRef: row.storage_ref as string,
      title: row.title as string,
      allowDownload: row.allow_download as boolean,
      watermark: row.watermark as boolean,
    }
  })
}

/** The share page's metadata look — no view spent, no bytes. */
export async function peekShare(
  firm: number,
  token: string,
): Promise<{ title: string; filename: string; passwordRequired: boolean }> {
  const door: Principal = { kind: 'system_job', id: SHARE_SIGN_DOOR_ACTOR, firm }
  return withPrincipal(
    door,
    async (tx) => {
      const s = await tx.query(
        `select s.password_hash, s.expires_at, s.revoked_at, s.max_views, s.view_count,
                d.title, df.filename
           from deedbox.document_share s
           join deedbox.document d on d.id = s.document
           join deedbox.document_version v on v.id = s.version
           join deedbox.document_file df on df.id = v.file
          where s.token_hash = $1`,
        [sha256Hex(token)],
      )
      if (s.rowCount === 0) throw new OperationRefused('share_not_found', 'no such link')
      const row = s.rows[0]
      if (row.revoked_at) throw new OperationRefused('share_revoked', 'this link has been revoked')
      if (new Date(row.expires_at as string).getTime() < Date.now()) {
        throw new OperationRefused('share_expired', 'this link has expired')
      }
      if (row.max_views !== null && (row.view_count as number) >= (row.max_views as number)) {
        throw new OperationRefused('view_budget_spent', 'this link has reached its view limit')
      }
      return {
        title: row.title as string,
        filename: row.filename as string,
        passwordRequired: Boolean(row.password_hash),
      }
    },
    { readOnly: true },
  )
}

/** The staff panel's list for one document. */
export async function listDocumentShares(
  tx: Tx,
  documentId: number,
): Promise<
  {
    id: number
    recipient: string | null
    expiresAt: string
    viewCount: number
    maxViews: number | null
    revoked: boolean
  }[]
> {
  const r = await tx.query(
    `select id, recipient_name, recipient_email, expires_at, view_count, max_views, revoked_at
       from deedbox.document_share where document = $1 order by id desc`,
    [documentId],
  )
  return r.rows.map((s) => ({
    id: s.id as number,
    recipient: (s.recipient_email ?? s.recipient_name) as string | null,
    expiresAt: String(s.expires_at),
    viewCount: s.view_count as number,
    maxViews: s.max_views as number | null,
    revoked: Boolean(s.revoked_at),
  }))
}
