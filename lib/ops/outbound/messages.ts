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
import { createDocumentWithFileInTx } from '@/lib/ops/documents/documents'
import { requireByteStore } from '@/lib/ops/documents/store'

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

/** A document the transport actually attached to the delivered message —
 *  reported back so the product can file the exact copy the recipient got. */
export interface DeliveredAttachment {
  filename: string
  contentType: string
  /** base64 — the shape the mail API carries. */
  contentBase64: string
}

/** What a transport may report about a completed delivery. A transport that
 *  reports nothing (returns void) delivers exactly as before. */
export interface DeliveryReport {
  attachments?: DeliveredAttachment[]
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
}) => Promise<void | DeliveryReport>

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
        `select m.id, m.channel, m.recipient, m.rendered_artefact, m.purpose,
                m.related_type, m.related
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
        const report = await deliver({
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
        return {
          outcome: 'sent' as const,
          message: row.id as number,
          purpose: row.purpose as string,
          recipient: row.recipient as string,
          relatedType: (row.related_type as string) ?? null,
          related: (row.related as number) ?? null,
          renderedArtefact: ref,
          attachments: report && typeof report === 'object' ? (report.attachments ?? []) : [],
        }
      } catch (err) {
        await tx.query(
          `update deedbox.outbound_message set state = 'failed', failed_reason = $2 where id = $1`,
          [row.id, err instanceof Error ? err.message : String(err)],
        )
        return { outcome: 'failed' as const }
      }
    })
    if (advanced === null) break
    if (advanced.outcome === 'sent') {
      sent++
      // the despatched copy belongs on the matter's file — filed AFTER the
      // send is committed, in its own transactions, so a filing problem can
      // never unsend a message (a rolled-back send mark would redeliver)
      if (
        advanced.purpose === 'bill_despatch' &&
        advanced.relatedType === 'bill' &&
        advanced.related !== null &&
        advanced.attachments.length > 0
      ) {
        await fileDespatchedBillCopy(p, {
          message: advanced.message,
          bill: advanced.related,
          recipient: advanced.recipient,
          renderedArtefact: advanced.renderedArtefact,
          attachments: advanced.attachments,
        })
      }
    } else failed++
  }
  return { sent, failed }
}

/**
 * File the exact copy a bill despatch delivered onto the bill's matter:
 * bytes first through the documents byte store, then the ordinary document
 * creation (landing row, head, version, register) attributed to the staff
 * member who ran the send ceremony. Exactly once per despatched message.
 * Failure is recorded on the register and never disturbs the sent message.
 */
async function fileDespatchedBillCopy(
  p: Principal,
  d: {
    message: number
    bill: number
    recipient: string
    renderedArtefact: string
    attachments: DeliveredAttachment[]
  },
): Promise<void> {
  try {
    const target = await withPrincipal(
      p,
      async (tx) => {
        const dup = await tx.query(`select 1 from deedbox.document_file where external_ref = $1`, [
          `outbound_despatch:${d.message}`,
        ])
        if (dup.rowCount! > 0) return null
        const b = await tx.query(`select matter from deedbox.bill where id = $1`, [d.bill])
        if (b.rowCount === 0) {
          throw new OperationRefused('bill_missing', 'the despatched bill no longer resolves')
        }
        // the send ceremony registered this despatch with its exact artefact —
        // that entry names the staff member the filed copy is attributed to
        const sender = await tx.query(
          `select actor from deedbox.register_entry
            where subject_type = 'bill' and subject = $1 and event_kind = 'record.changed'
              and artefact = $2 and actor_kind = 'staff'
            order by id desc limit 1`,
          [d.bill, d.renderedArtefact],
        )
        if (sender.rowCount === 0) {
          throw new OperationRefused(
            'sender_unknown',
            'no send ceremony names a staff sender for this despatch',
          )
        }
        return { matter: b.rows[0].matter as number, sender: sender.rows[0].actor as number }
      },
      { readOnly: true },
    )
    if (target === null) return
    // bytes first, all of them, outside the row transaction
    const store = requireByteStore()
    const filed: { att: DeliveredAttachment; bytes: Buffer; storageRef: string; contentType: string }[] = []
    for (const att of d.attachments) {
      const bytes = Buffer.from(att.contentBase64, 'base64')
      const stored = await store({ matter: target.matter, filename: att.filename, bytes })
      filed.push({ att, bytes, storageRef: stored.storageRef, contentType: stored.contentType })
    }
    await withPrincipal(p, async (tx) => {
      for (const f of filed) {
        await createDocumentWithFileInTx(tx, p, {
          matter: target.matter,
          filename: f.att.filename,
          contentType: f.contentType,
          sizeBytes: f.bytes.length,
          storageRef: f.storageRef,
          source: 'outbound_despatch',
          title: f.att.filename.replace(/\.[a-z0-9]+$/i, ''),
          description: `Despatched to ${d.recipient}`,
          createdBy: target.sender,
          externalRef: `outbound_despatch:${d.message}`,
        })
      }
    })
  } catch (e) {
    const reason = e instanceof Error ? e.message : String(e)
    await withPrincipal(p, async (tx) => {
      await emitRegister(tx, p, {
        kind: 'record.changed',
        subjectType: 'outbound_message',
        subject: d.message,
        detail: { despatch_filing_failed: reason },
      })
    }).catch(() => {
      // the register note is best-effort: the send already stands
    })
  }
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
