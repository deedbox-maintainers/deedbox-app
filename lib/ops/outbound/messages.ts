// The outbound message operations: queue a message, the dispatch job, and
// retrieve an artefact. The exact rendered copy exists BEFORE anything is
// sent (the queue row is born carrying its stored artefact); state moves
// only forward (queued → sent | failed, schema-enforced); a retry is a new
// row via retry_of, created by the owning domain's retry policy — here as
// the generic manual retry.
//
// The delivery integration is a seam: the dispatch job takes a deliver
// callback (the deployment binds the real transport). Marking rides the same
// transaction as the delivery attempt — at-least-once, honestly.

import { createHash } from 'node:crypto'
import type { Principal, Tx } from '@/lib/db'
import { withPrincipal, emitRegister, OperationRefused } from '@/lib/db'
import { requireStaff, hasCapability } from '@/lib/ops/shared'

export interface QueueMessageInput {
  channel: 'email' | 'text_message'
  recipient: string
  purpose: string
  content: string
  contentType?: string
  template?: number
  relatedType?: string
  related?: number
}

/**
 * The in-transaction queue writer every domain calls: stores the
 * exact rendered copy as an artefact, then the queue row carrying it.
 */
export async function queueOutboundMessageInTx(
  tx: Tx,
  _p: Principal,
  input: QueueMessageInput,
): Promise<{ message: number; artefact: number }> {
  if (!input.recipient.trim()) {
    throw new OperationRefused('recipient_required', 'a message needs a recipient')
  }
  const artefact = await tx.query(
    `insert into deedbox.stored_artefact (kind, content_ref, content_hash, content_type, size_bytes)
     values ('outbound_rendering', $1, $2, $3, $4) returning id`,
    [
      input.content,
      createHash('sha256').update(input.content).digest('hex'),
      input.contentType ?? 'text/plain',
      Buffer.byteLength(input.content),
    ],
  )
  const row = await tx.query(
    `insert into deedbox.outbound_message
       (channel, recipient, template, rendered_artefact, purpose, related_type, related)
     values ($1, $2, $3, $4, $5, $6, $7) returning id`,
    [
      input.channel,
      input.recipient.trim(),
      input.template ?? null,
      String(artefact.rows[0].id),
      input.purpose,
      input.relatedType ?? null,
      input.related ?? null,
    ],
  )
  return { message: row.rows[0].id as number, artefact: artefact.rows[0].id as number }
}

/** The queue writer as a standalone operation (jobs and screens). */
export async function queueOutboundMessage(
  p: Principal,
  input: QueueMessageInput,
): Promise<{ message: number; artefact: number }> {
  return withPrincipal(p, (tx) => queueOutboundMessageInTx(tx, p, input))
}

export type Deliverer = (message: {
  id: number
  channel: string
  recipient: string
  content: string
  /** The queue row's purpose key — a real transport derives its subject from it. */
  purpose: string
  /** The stored artefact's content type; null when the reference itself is the deliverable. */
  contentType: string | null
}) => Promise<void>

/**
 * The dispatch job: queued rows oldest-first, handed to the
 * delivery seam, marked sent or failed (terminal; a retry is a new row).
 * One transaction per message; concurrent dispatchers skip locked rows.
 */
export async function dispatchOutboundQueue(
  p: Principal,
  deliver: Deliverer,
  opts: { limit?: number } = {},
): Promise<{ sent: number; failed: number }> {
  const limit = opts.limit ?? 50
  let sent = 0
  let failed = 0
  for (let i = 0; i < limit; i++) {
    const advanced = await withPrincipal(p, async (tx) => {
      const next = await tx.query(
        `select m.id, m.channel, m.recipient, m.rendered_artefact, m.purpose
           from deedbox.outbound_message m
          where m.state = 'queued'
          order by m.queued_at, m.id
          limit 1
          for update skip locked`,
      )
      if (next.rowCount === 0) return null
      const row = next.rows[0]
      // rendered_artefact is a blob-ref: usually a stored_artefact id, but
      // some domains store named references (e.g. "top-up-TU-000001") — the
      // reference itself is then the deliverable identity
      const ref = row.rendered_artefact as string
      let content = ref
      let contentType: string | null = null
      if (/^\d+$/.test(ref)) {
        const art = await tx.query(
          `select content_ref, content_type from deedbox.stored_artefact where id = $1`,
          [Number(ref)],
        )
        content = (art.rows[0]?.content_ref as string) ?? ref
        contentType = (art.rows[0]?.content_type as string) ?? null
      }
      try {
        await deliver({
          id: row.id as number,
          channel: row.channel as string,
          recipient: row.recipient as string,
          content,
          purpose: row.purpose as string,
          contentType,
        })
        await tx.query(
          `update deedbox.outbound_message set state = 'sent', sent_at = now() where id = $1`,
          [row.id],
        )
        return 'sent' as const
      } catch (err) {
        await tx.query(
          `update deedbox.outbound_message set state = 'failed', failed_reason = $2 where id = $1`,
          [row.id, err instanceof Error ? err.message : String(err)],
        )
        return 'failed' as const
      }
    })
    if (advanced === null) break
    if (advanced === 'sent') sent++
    else failed++
  }
  return { sent, failed }
}

/** The generic manual retry: a NEW row via retry_of, content identical. */
export async function retryOutboundMessage(
  p: Principal,
  input: { message: number },
): Promise<{ message: number }> {
  requireStaff(p)
  return withPrincipal(p, async (tx) => {
    const cur = await tx.query(
      `select id, channel, recipient, template, rendered_artefact, purpose,
              related_type, related, state
         from deedbox.outbound_message where id = $1`,
      [input.message],
    )
    if (cur.rowCount === 0) throw new OperationRefused('not_found', 'message not found')
    if (cur.rows[0].state !== 'failed') {
      throw new OperationRefused('not_failed', 'only failed messages are retried')
    }
    const row = cur.rows[0]
    const r = await tx.query(
      `insert into deedbox.outbound_message
         (channel, recipient, template, rendered_artefact, purpose, related_type, related, retry_of)
       values ($1, $2, $3, $4, $5, $6, $7, $8) returning id`,
      [
        row.channel,
        row.recipient,
        row.template,
        row.rendered_artefact,
        row.purpose,
        row.related_type,
        row.related,
        row.id,
      ],
    )
    await emitRegister(tx, p, {
      kind: 'record.created',
      subjectType: 'outbound_message',
      subject: r.rows[0].id as number,
      detail: { retry_of: row.id, purpose: row.purpose },
    })
    return { message: r.rows[0].id as number }
  })
}

/**
 * Retrieve an artefact, gated by the visibility of its owning
 * record: a message artefact follows its message's related matter (the
 * predicate answers); an export artefact is an ordinary read for its
 * exporter or a register.read holder; anything else needs register.read.
 */
export async function retrieveArtefact(
  p: Principal,
  input: { artefact: number },
): Promise<{ content: string; contentType: string; kind: string }> {
  requireStaff(p)
  return withPrincipal(
    p,
    async (tx) => {
      const art = await tx.query(
        `select id, kind, content_ref, content_type from deedbox.stored_artefact where id = $1`,
        [input.artefact],
      )
      if (art.rowCount === 0) throw new OperationRefused('not_found', 'artefact not found')

      let allowed = false
      const viaMessage = await tx.query(
        `select related_type, related from deedbox.outbound_message
          where rendered_artefact = $1 limit 1`,
        [String(input.artefact)],
      )
      if (viaMessage.rowCount! > 0) {
        const rel = viaMessage.rows[0]
        if (rel.related_type === 'matter' && rel.related !== null) {
          const m = await tx.query(`select 1 from deedbox.matter where id = $1`, [rel.related])
          allowed = m.rowCount! > 0 // the predicate filtered it
        } else if (rel.related_type === 'bill' && rel.related !== null) {
          const m = await tx.query(
            `select 1 from deedbox.bill b join deedbox.matter mt on mt.id = b.matter where b.id = $1`,
            [rel.related],
          )
          allowed = m.rowCount! > 0
        } else {
          allowed = true // unrelated administrative message; staff read
        }
      } else {
        const viaRegister = await tx.query(
          `select actor, matter from deedbox.register_entry
            where artefact = $1 order by id limit 1`,
          [String(input.artefact)],
        )
        if (viaRegister.rowCount! > 0) {
          const e = viaRegister.rows[0]
          if (e.actor === p.id) {
            allowed = true // the exporter's ordinary read
          } else if (e.matter !== null) {
            const m = await tx.query(`select 1 from deedbox.matter where id = $1`, [e.matter])
            allowed = m.rowCount! > 0 && (await hasCapability(tx, p.id, 'register.read'))
          } else {
            allowed = await hasCapability(tx, p.id, 'register.read')
          }
        }
      }
      if (!allowed) {
        throw new OperationRefused('not_visible', 'this artefact belongs to a record you cannot see')
      }
      return {
        content: art.rows[0].content_ref as string,
        contentType: art.rows[0].content_type as string,
        kind: art.rows[0].kind as string,
      }
    },
    { readOnly: true },
  )
}
