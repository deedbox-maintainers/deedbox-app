// Issue and revoke integration keys. The secret is generated here, returned
// ONCE, and only its hash is stored; the short public key_display names the
// key on screens and in logs and is never sufficient to authenticate.
// Revocation is checked live on every request — immediate by construction.

import { randomBytes, createHash } from 'node:crypto'
import type { Principal } from '@/lib/db'
import { withPrincipal, emitRegister, OperationRefused } from '@/lib/db'
import { requireCapability } from '@/lib/ops/shared'

export interface RateLimit {
  per_minute: number
  per_day: number
}

export function hashSecret(secret: string): string {
  return createHash('sha256').update(secret).digest('hex')
}

/** Issue a key. The returned secret exists nowhere after this call. */
export async function issueIntegrationKey(
  p: Principal,
  input: {
    label: string
    rateLimit?: RateLimit
    testMode?: boolean
    payloadVersions?: string[]
  },
): Promise<{ id: number; keyDisplay: string; secret: string }> {
  if (!input.label.trim()) throw new OperationRefused('label_required', 'a key needs a label')
  const secret = randomBytes(32).toString('base64url')
  const keyDisplay = `dbk_${randomBytes(6).toString('hex')}`
  const rateLimit = input.rateLimit ?? { per_minute: 60, per_day: 5000 }
  const payloadVersions = input.payloadVersions ?? ['1']
  return withPrincipal(p, async (tx) => {
    await requireCapability(tx, p, 'keys.manage')
    const r = await tx.query(
      `insert into deedbox.integration_key
         (label, secret_hash, issued_by, rate_limit, test_mode, payload_versions, key_display)
       values ($1, $2, $3, $4, $5, $6, $7) returning id`,
      [
        input.label.trim(),
        hashSecret(secret),
        p.id,
        JSON.stringify(rateLimit),
        input.testMode ?? false,
        JSON.stringify(payloadVersions),
        keyDisplay,
      ],
    )
    const id = r.rows[0].id as number
    await emitRegister(tx, p, {
      kind: 'key.issued',
      subjectType: 'integration_key',
      subject: id,
      privileged: true,
      detail: {
        before: null,
        after: {
          label: input.label.trim(),
          key_display: keyDisplay,
          rate_limit: rateLimit,
          test_mode: input.testMode ?? false,
          payload_versions: payloadVersions,
        },
      },
    })
    return { id, keyDisplay, secret }
  })
}

/** Revoke: immediate, checked live on every request. */
export async function revokeIntegrationKey(
  p: Principal,
  input: { key: number },
): Promise<void> {
  await withPrincipal(p, async (tx) => {
    await requireCapability(tx, p, 'keys.manage')
    const cur = await tx.query(
      `select id, label, key_display, revoked_at from deedbox.integration_key where id = $1 for update`,
      [input.key],
    )
    if (cur.rowCount === 0) throw new OperationRefused('not_found', 'integration key not found')
    if (cur.rows[0].revoked_at !== null) {
      throw new OperationRefused('already_revoked', 'this key is already revoked')
    }
    await tx.query(`update deedbox.integration_key set revoked_at = now() where id = $1`, [input.key])
    await emitRegister(tx, p, {
      kind: 'key.revoked',
      subjectType: 'integration_key',
      subject: input.key,
      privileged: true,
      detail: {
        before: { label: cur.rows[0].label, key_display: cur.rows[0].key_display, revoked: false },
        after: { label: cur.rows[0].label, key_display: cur.rows[0].key_display, revoked: true },
      },
    })
  })
}

/**
 * The template-reading switch (0062): per key, off by default, templates
 * only. Flipping it is a recorded, privileged change on the key — the keys
 * screens are its only home, and the register carries every flip.
 */
export async function setKeyTemplatesRead(
  p: Principal,
  input: { key: number; enabled: boolean },
): Promise<void> {
  await withPrincipal(p, async (tx) => {
    await requireCapability(tx, p, 'keys.manage')
    const cur = await tx.query(
      `select id, label, key_display, revoked_at, templates_read
         from deedbox.integration_key where id = $1 for update`,
      [input.key],
    )
    if (cur.rowCount === 0) throw new OperationRefused('not_found', 'integration key not found')
    if (cur.rows[0].revoked_at !== null) {
      throw new OperationRefused('revoked', 'a revoked key is immutable')
    }
    if (Boolean(cur.rows[0].templates_read) === input.enabled) return
    await tx.query(`update deedbox.integration_key set templates_read = $2 where id = $1`, [
      input.key,
      input.enabled,
    ])
    await emitRegister(tx, p, {
      kind: 'record.changed',
      subjectType: 'integration_key',
      subject: input.key,
      privileged: true,
      detail: {
        before: { label: cur.rows[0].label, templates_read: Boolean(cur.rows[0].templates_read) },
        after: { label: cur.rows[0].label, templates_read: input.enabled },
      },
    })
  })
}
