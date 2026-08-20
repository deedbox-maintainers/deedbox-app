// Matter calendar events: created in the lawyer's own calendar
// through the seam and recorded on the matter.

import type { Principal } from '@/lib/db'
import { withPrincipal, emitRegister, OperationRefused } from '@/lib/db'
import { requireStaff } from '@/lib/ops/shared'
import { m365Service } from './seam'
import { freshConnectionInTx } from './connections'

export async function createMatterCalendarEvent(
  p: Principal,
  input: { matter: number; subject: string; startsAt: string; endsAt?: string; location?: string },
): Promise<{ event: number }> {
  requireStaff(p)
  const svc = m365Service()
  return withPrincipal(p, async (tx) => {
    const m = await tx.query(`select status from deedbox.matter where id = $1`, [input.matter])
    if (m.rowCount === 0) throw new OperationRefused('not_found', 'no matter by that id')
    if (m.rows[0].status === 'closed' || m.rows[0].status === 'archived') {
      throw new OperationRefused('matter_closed', 'the matter is closed')
    }
    const connection = await freshConnectionInTx(tx, p.id)
    const created = await svc.createEvent(connection.accessToken, {
      subject: input.subject,
      startsAt: input.startsAt,
      endsAt: input.endsAt,
      location: input.location,
    })
    const row = await tx.query(
      `insert into deedbox.matter_calendar_event
         (matter, staff, ms_event_id, subject, location, starts_at, ends_at, web_link)
       values ($1, $2, $3, $4, $5, $6, $7, $8) returning id`,
      [
        input.matter,
        p.id,
        created.msEventId,
        input.subject,
        input.location ?? null,
        input.startsAt,
        input.endsAt ?? null,
        created.webLink ?? null,
      ],
    )
    const eventId = row.rows[0].id as number
    await emitRegister(tx, p, {
      kind: 'record.created',
      subjectType: 'matter_calendar_event',
      subject: eventId,
      detail: { matter: input.matter, subject: input.subject, starts_at: input.startsAt },
    })
    return { event: eventId }
  })
}
