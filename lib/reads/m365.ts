// Microsoft 365 reads: the viewer's connection state and the
// matter email tab — the filed thread and calendar events, matter joins
// carrying the predicate as everywhere.

import type { Principal } from '@/lib/db'
import { withPrincipal } from '@/lib/db'

export async function myM365Connection(p: Principal): Promise<{
  connected: boolean
  email: string | null
  connectedAt: string | null
  lastPolledAt: string | null
}> {
  return withPrincipal(
    p,
    async (tx) => {
      const r = await tx.query(
        `select email, connected_at, last_polled_at from deedbox.m365_connection
          where staff = $1 and active`,
        [p.id],
      )
      if (r.rowCount === 0) {
        return { connected: false, email: null, connectedAt: null, lastPolledAt: null }
      }
      return {
        connected: true,
        email: r.rows[0].email as string,
        connectedAt: String(r.rows[0].connected_at),
        lastPolledAt: r.rows[0].last_polled_at ? String(r.rows[0].last_polled_at) : null,
      }
    },
    { readOnly: true },
  )
}

/**
 * The matter's email-filing address: configured when the firm
 * has named a shared filing mailbox; the address itself exists once the
 * matter's token is minted. filing@firm.example + token abc → the
 * plus-address filing+abc@firm.example.
 */
export async function matterFilingAddress(
  p: Principal,
  matterId: number,
): Promise<{ configured: boolean; address: string | null }> {
  return withPrincipal(
    p,
    async (tx) => {
      const cfg = await tx.query(
        `select deedbox.current_setting_value('m365.filing_mailbox_address') #>> '{}' as mailbox`,
      )
      const mailbox = ((cfg.rows[0]?.mailbox as string | null) ?? '').trim()
      if (!mailbox || !mailbox.includes('@')) return { configured: false, address: null }
      const m = await tx.query(`select filing_token from deedbox.matter where id = $1`, [matterId])
      const token = (m.rows[0]?.filing_token as string | null) ?? null
      if (!token) return { configured: true, address: null }
      const [local, domain] = mailbox.split('@')
      return { configured: true, address: `${local}+${token}@${domain}` }
    },
    { readOnly: true },
  )
}

export interface MatterEmailRow {
  id: number
  direction: string
  fromAddress: string | null
  toAddresses: string[]
  subject: string | null
  bodyPreview: string | null
  occurredAt: string
}

export async function matterEmailTab(
  p: Principal,
  matterId: number,
): Promise<{
  matter: { id: number; matterNumber: string; title: string; status: string }
  emails: MatterEmailRow[]
  events: { id: number; subject: string; location: string | null; startsAt: string; endsAt: string | null; webLink: string | null }[]
}> {
  return withPrincipal(
    p,
    async (tx) => {
      const m = await tx.query(
        `select id, matter_number, title, status from deedbox.matter where id = $1`,
        [matterId],
      )
      if (m.rowCount === 0) throw new Error('not_found')
      const emails = await tx.query(
        `select e.id, e.direction, e.from_address, e.to_addresses, e.subject, e.body_preview, e.occurred_at
           from deedbox.matter_email e
           join deedbox.matter mm on mm.id = e.matter
          where e.matter = $1
          order by e.occurred_at desc
          limit 200`,
        [matterId],
      )
      const events = await tx.query(
        `select ev.id, ev.subject, ev.location, ev.starts_at, ev.ends_at, ev.web_link
           from deedbox.matter_calendar_event ev
           join deedbox.matter mm on mm.id = ev.matter
          where ev.matter = $1
          order by ev.starts_at desc
          limit 50`,
        [matterId],
      )
      return {
        matter: {
          id: m.rows[0].id as number,
          matterNumber: m.rows[0].matter_number as string,
          title: m.rows[0].title as string,
          status: m.rows[0].status as string,
        },
        emails: emails.rows.map((e) => ({
          id: e.id as number,
          direction: e.direction as string,
          fromAddress: e.from_address as string | null,
          toAddresses: (e.to_addresses as string[] | null) ?? [],
          subject: e.subject as string | null,
          bodyPreview: e.body_preview as string | null,
          occurredAt: String(e.occurred_at),
        })),
        events: events.rows.map((ev) => ({
          id: ev.id as number,
          subject: ev.subject as string,
          location: ev.location as string | null,
          startsAt: String(ev.starts_at),
          endsAt: ev.ends_at ? String(ev.ends_at) : null,
          webLink: ev.web_link as string | null,
        })),
      }
    },
    { readOnly: true },
  )
}
