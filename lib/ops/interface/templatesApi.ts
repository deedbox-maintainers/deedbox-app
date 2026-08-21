// The templates read door: the ONE opt-in read an integration key can be
// granted — list the firm's ACTIVE document templates, fetch one file.
// Scope is templates and nothing else: the switch (integration_key.
// templates_read, 0062) never widens to matters, clients, money, staff or
// matter documents, and the door reads only the template registry and its
// stored bytes.
//
// Door discipline mirrors the intake door: the same x-api-key secret and
// hashed lookup (authenticateIntegrationKey), revoked keys refused with
// evidence, the key's own rate limits enforced (reads are counted from
// their own evidence trail — a read creates no submission row), and every
// call an evidenced key.used register event carrying door 'templates'.
// Reads write nothing but their evidence. The evidence rows are written as
// the KEY's identity; the template read itself runs as the platform actor,
// exactly as the creation side of the intake door does — the key's own
// context stays structurally write-only.
//
// The merge grammar is declared authoritatively: every template in this
// product renders through the merge module's double-angle dotted tags
// (lib/ops/documents/merge.ts), so the list names it per template and a
// consumer never has to sniff.

import type { Principal } from '@/lib/db'
import { withPrincipal, emitRegister } from '@/lib/db'
import { requireByteFetch } from '@/lib/ops/documents/store'
import {
  authenticateIntegrationKey,
  INTAKE_API_SYSTEM_ACTOR,
  type AuthedKey,
} from './intakeApi'

/** The one grammar this product's templates carry (see merge.ts). */
export const TEMPLATE_MERGE_GRAMMAR = 'double_angle_dotted'
export const TEMPLATE_MERGE_DELIMITERS = { start: '<<', end: '>>' }

export interface TemplateListEntry {
  id: number
  name: string
  category: string
  description: string | null
  practice_area: string | null
  jurisdiction: string | null
  filename: string
  size_bytes: number
  updated_at: string
  merge_grammar: string
  merge_delimiters: { start: string; end: string }
}

export interface TemplateFile {
  id: number
  name: string
  filename: string
  content_type: string
  size_bytes: number
  file_base64: string
  merge_grammar: string
  merge_delimiters: { start: string; end: string }
}

export type TemplatesOutcome<T> =
  | { outcome: 'unauthenticated' }
  | { outcome: 'revoked' }
  | { outcome: 'not_enabled' }
  | { outcome: 'rate_limited'; retryAfterSeconds: number }
  | { outcome: 'not_found' }
  | { outcome: 'ok'; result: T }

/** The shared front half: authenticate, refuse revoked/unenabled with
 *  evidence, enforce the key's own rate limits from the read trail. */
async function templatesFront(
  firm: number,
  secret: string,
): Promise<{ key: AuthedKey; principal: Principal } | TemplatesOutcome<never>> {
  const key = await authenticateIntegrationKey(firm, secret)
  if (key === null) return { outcome: 'unauthenticated' }
  const principal: Principal = { kind: 'integration_key', id: key.id, firm }

  if (key.revoked) {
    await withPrincipal(principal, async (tx) => {
      await emitRegister(tx, principal, {
        kind: 'key.used',
        subjectType: 'integration_key',
        subject: key.id,
        detail: { outcome: 'revoked_attempt', door: 'templates' },
      })
    })
    return { outcome: 'revoked' }
  }

  if (!key.templates_read) {
    await withPrincipal(principal, async (tx) => {
      await emitRegister(tx, principal, {
        kind: 'key.used',
        subjectType: 'integration_key',
        subject: key.id,
        detail: { outcome: 'templates_read_not_enabled', door: 'templates' },
      })
    })
    return { outcome: 'not_enabled' }
  }

  const perMinute = key.rate_limit?.per_minute ?? 60
  const perDay = key.rate_limit?.per_day ?? 5000
  const limited = await withPrincipal(principal, async (tx) => {
    const c = await tx.query(
      `select count(*) filter (where occurred_at > now() - interval '1 minute')::int as m,
              count(*) filter (where occurred_at > now() - interval '1 day')::int as d
         from deedbox.register_entry
        where event_kind = 'key.used' and subject_type = 'integration_key' and subject = $1
          and detail ->> 'door' = 'templates'
          and detail ->> 'outcome' in ('list', 'fetch')`,
      [key.id],
    )
    if ((c.rows[0].m as number) < perMinute && (c.rows[0].d as number) < perDay) return false
    const bucket = await tx.query(`select to_char(now(), 'YYYY-MM-DD HH24:MI') as b`)
    const seen = await tx.query(
      `select 1 from deedbox.register_entry
        where event_kind = 'key.used' and subject_type = 'integration_key' and subject = $1
          and detail ->> 'outcome' = 'rate_limited' and detail ->> 'door' = 'templates'
          and detail ->> 'bucket' = $2`,
      [key.id, bucket.rows[0].b],
    )
    if (seen.rowCount === 0) {
      await emitRegister(tx, principal, {
        kind: 'key.used',
        subjectType: 'integration_key',
        subject: key.id,
        detail: { outcome: 'rate_limited', door: 'templates', bucket: bucket.rows[0].b },
      })
    }
    return true
  })
  if (limited) return { outcome: 'rate_limited', retryAfterSeconds: 60 }

  return { key, principal }
}

/** Evidence + the key's last-used stamp, in the key's own context. */
async function evidenceRead(
  principal: Principal,
  key: number,
  detail: Record<string, unknown>,
): Promise<void> {
  await withPrincipal(principal, async (tx) => {
    await tx.query(`update deedbox.integration_key set last_used_at = now() where id = $1`, [key])
    await emitRegister(tx, principal, {
      kind: 'key.used',
      subjectType: 'integration_key',
      subject: key,
      detail: { ...detail, door: 'templates' },
    })
  })
}

/** GET the firm's active template library — metadata only, grammar declared. */
export async function templatesList(
  firm: number,
  secret: string,
): Promise<TemplatesOutcome<{ templates: TemplateListEntry[] }>> {
  const front = await templatesFront(firm, secret)
  if (!('key' in front)) return front

  const platform: Principal = { kind: 'system_job', id: INTAKE_API_SYSTEM_ACTOR, firm }
  const rows = await withPrincipal(
    platform,
    async (tx) => {
      const r = await tx.query(
        `select t.id, t.name, t.category, t.description, pa.name as practice_area,
                t.jurisdiction, t.filename, t.size_bytes, t.updated_at
           from deedbox.document_template t
           left join deedbox.practice_area pa on pa.id = t.practice_area
          where t.active and t.soft_deleted_at is null
          order by t.category, t.name`,
      )
      return r.rows
    },
    { readOnly: true },
  )
  await evidenceRead(front.principal, front.key.id, { outcome: 'list', templates: rows.length })
  return {
    outcome: 'ok',
    result: {
      templates: rows.map((t) => ({
        id: t.id as number,
        name: t.name as string,
        category: t.category as string,
        description: (t.description as string) ?? null,
        practice_area: (t.practice_area as string) ?? null,
        jurisdiction: (t.jurisdiction as string) ?? null,
        filename: t.filename as string,
        size_bytes: Number(t.size_bytes),
        updated_at: new Date(t.updated_at as string).toISOString(),
        merge_grammar: TEMPLATE_MERGE_GRAMMAR,
        merge_delimiters: TEMPLATE_MERGE_DELIMITERS,
      })),
    },
  }
}

/** GET one active template's file, base64-in-JSON. */
export async function templatesFetch(
  firm: number,
  secret: string,
  templateId: number,
): Promise<TemplatesOutcome<TemplateFile>> {
  const front = await templatesFront(firm, secret)
  if (!('key' in front)) return front

  const platform: Principal = { kind: 'system_job', id: INTAKE_API_SYSTEM_ACTOR, firm }
  const row = await withPrincipal(
    platform,
    async (tx) => {
      const r = await tx.query(
        `select id, name, filename, storage_ref, size_bytes
           from deedbox.document_template
          where id = $1 and active and soft_deleted_at is null`,
        [templateId],
      )
      return r.rowCount === 0 ? null : r.rows[0]
    },
    { readOnly: true },
  )
  if (row === null) {
    await evidenceRead(front.principal, front.key.id, {
      outcome: 'fetch_not_found',
      template: templateId,
    })
    return { outcome: 'not_found' }
  }

  const fetched = await requireByteFetch()(row.storage_ref as string)
  await evidenceRead(front.principal, front.key.id, { outcome: 'fetch', template: row.id })
  return {
    outcome: 'ok',
    result: {
      id: row.id as number,
      name: row.name as string,
      filename: row.filename as string,
      content_type:
        fetched.contentType ||
        'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      size_bytes: fetched.bytes.length,
      file_base64: fetched.bytes.toString('base64'),
      merge_grammar: TEMPLATE_MERGE_GRAMMAR,
      merge_delimiters: TEMPLATE_MERGE_DELIMITERS,
    },
  }
}
