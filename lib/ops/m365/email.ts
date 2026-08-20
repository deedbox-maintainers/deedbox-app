// Matter email: send as the lawyer with the matter number stamped into
// the subject and the sent copy filed in the same transaction; the
// poll job files subject-tagged inbound mail onto its matter, deduped
// on the internet message id, and advances each connection's
// watermark.

import type { Principal } from '@/lib/db'
import { withPrincipal, emitRegister, OperationRefused } from '@/lib/db'
import { requireStaff } from '@/lib/ops/shared'
import { m365Service } from './seam'
import { freshConnectionInTx } from './connections'

const TAG_RE = /\[([A-Za-z0-9][A-Za-z0-9 _/.-]{1,40})\]/g

export async function sendMatterEmail(
  p: Principal,
  input: { matter: number; to: string[]; cc?: string[]; subject: string; bodyHtml: string },
): Promise<{ email: number }> {
  requireStaff(p)
  const svc = m365Service()
  if (input.to.length === 0) throw new OperationRefused('recipients_required', 'name at least one recipient')
  return withPrincipal(p, async (tx) => {
    const m = await tx.query(`select matter_number, status from deedbox.matter where id = $1`, [
      input.matter,
    ])
    if (m.rowCount === 0) throw new OperationRefused('not_found', 'no matter by that id')
    if (m.rows[0].status === 'closed' || m.rows[0].status === 'archived') {
      throw new OperationRefused('matter_closed', 'the matter is closed')
    }
    const connection = await freshConnectionInTx(tx, p.id)
    const matterNumber = m.rows[0].matter_number as string
    const subject = input.subject.includes(`[${matterNumber}]`)
      ? input.subject
      : `${input.subject} [${matterNumber}]`
    const sent = await svc.sendMail(connection.accessToken, {
      to: input.to,
      cc: input.cc,
      subject,
      bodyHtml: input.bodyHtml,
    })
    const row = await tx.query(
      `insert into deedbox.matter_email
         (matter, staff, direction, from_address, to_addresses, cc_addresses, subject,
          body_preview, body_html, ms_message_id, ms_internet_message_id, occurred_at)
       values ($1, $2, 'sent', $3, $4, $5, $6, $7, $8, $9, $10, now()) returning id`,
      [
        input.matter,
        p.id,
        connection.email,
        input.to,
        input.cc ?? [],
        subject,
        input.bodyHtml.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 240),
        input.bodyHtml,
        sent.msMessageId ?? null,
        sent.internetMessageId ?? null,
      ],
    )
    const emailId = row.rows[0].id as number
    await tx.query(
      `insert into deedbox.activity_signal
         (source_module, signal_kind, source_ref, occurred_at, staff, matter_hint, detail)
       values ('email', 'email_sent', $1, now(), $2, $3, $4)
       on conflict (source_module, source_ref) do nothing`,
      [
        `matter_email:${emailId}`,
        p.id,
        JSON.stringify({ matter: input.matter }),
        JSON.stringify({ matter: input.matter, subject }),
      ],
    )
    await emitRegister(tx, p, {
      kind: 'record.created',
      subjectType: 'matter_email',
      subject: emailId,
      detail: { matter: input.matter, direction: 'sent', to: input.to, subject },
    })
    return { email: emailId }
  })
}

/**
 * The inbound poll (job id 22): per active connection, inbox messages
 * since the watermark (minus a five-minute overlap) whose subject carries
 * a bracketed matter number file onto that matter, deduped by the schema.
 */
export async function runMailPoll(
  p: Principal,
): Promise<{ connections: number; scanned: number; filed: number }> {
  const svc = m365Service()
  return withPrincipal(p, async (tx) => {
    const conns = await tx.query(
      `select staff from deedbox.m365_connection where active order by id`,
    )
    let scanned = 0
    let filed = 0
    for (const c of conns.rows) {
      const live = await freshConnectionInTx(tx, c.staff as number)
      const watermark = await tx.query(
        `select coalesce(last_polled_at, now() - interval '7 days') as since
           from deedbox.m365_connection where id = $1`,
        [live.id],
      )
      const since = new Date(
        new Date(watermark.rows[0].since as string).getTime() - 5 * 60_000,
      ).toISOString()
      const messages = await svc.listInboxSince(live.accessToken, since)
      scanned += messages.length
      for (const msg of messages) {
        const tags = [...(msg.subject ?? '').matchAll(TAG_RE)].map((t) => t[1])
        if (tags.length === 0) continue
        const matter = await tx.query(
          `select id from deedbox.matter where matter_number = any($1::text[]) limit 1`,
          [tags],
        )
        if (matter.rowCount === 0) continue
        const inserted = await tx.query(
          `insert into deedbox.matter_email
             (matter, staff, direction, from_address, to_addresses, cc_addresses, subject,
              body_preview, body_html, ms_message_id, ms_internet_message_id, occurred_at)
           values ($1, $2, 'received', $3, $4, $5, $6, $7, $8, $9, $10, $11)
           on conflict (matter, ms_internet_message_id) do nothing
           returning id`,
          [
            matter.rows[0].id,
            live.staff,
            msg.from ?? null,
            msg.to,
            msg.cc,
            msg.subject,
            msg.bodyPreview?.slice(0, 240) ?? null,
            msg.bodyHtml ?? null,
            msg.msMessageId,
            msg.internetMessageId,
            msg.receivedAt,
          ],
        )
        if ((inserted.rowCount ?? 0) > 0) {
          filed++
          await emitRegister(tx, p, {
            kind: 'record.created',
            subjectType: 'matter_email',
            subject: inserted.rows[0].id as number,
            detail: {
              matter: matter.rows[0].id,
              direction: 'received',
              from: msg.from ?? null,
              subject: msg.subject,
            },
          })
        }
      }
      await tx.query(`update deedbox.m365_connection set last_polled_at = now() where id = $1`, [
        live.id,
      ])
    }
    return { connections: conns.rowCount ?? 0, scanned, filed }
  })
}
