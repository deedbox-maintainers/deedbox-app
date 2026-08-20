// The Microsoft 365 email module (schema change 0035): the seam refuses
// typed when unbound; connect stores the identity with NO token in the
// register; send refuses without a connection, stamps the matter number
// into the subject, files the sent copy + activity signal; the poll files
// EXACTLY the tagged inbound message, ignores untagged, DEDUPES on the
// second run and advances the watermark; stale tokens refresh through the
// seam and persist; calendar events record; disconnect removes the account
// from the poll.
//
// Cross-suite contract: binds its OWN fake M365 service and unbinds in
// afterAll. Flips no settings. Fixture tag 'm36' (first-three unique).

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import type { Pool } from 'pg'
import { closePool } from '@/lib/db'
import type { Principal } from '@/lib/db'
import {
  setM365Service,
  connectM365Account,
  disconnectM365Account,
  sendMatterEmail,
  runMailPoll,
  createMatterCalendarEvent,
  type InboundMessage,
} from '@/lib/ops/m365'
import { matterEmailTab, myM365Connection } from '@/lib/reads/m365'
import { makeAdminPool, buildFixture, type Fixture } from './helpers'

let admin: Pool
let fx: Fixture
let P: Principal
let P2: Principal
let matterNumber = ''
const sends: { to: string[]; subject: string }[] = []
let inbox: InboundMessage[] = []
let refreshes = 0

beforeAll(async () => {
  admin = makeAdminPool()
  fx = await buildFixture(admin, 'm36')
  P = { kind: 'staff', id: fx.staff, firm: fx.firm }
  const s2 = await admin.query(
    `insert into deedbox.staff_member (person_name, login, role, office, email)
     values ('{"given":"No","family":"Connection"}','nocon.m36', $1, $2, 'nocon.m36@example.test')
     returning id`,
    [fx.adminRole, fx.office],
  )
  P2 = { kind: 'staff', id: s2.rows[0].id as number, firm: fx.firm }
  const num = await admin.query(`select matter_number from deedbox.matter where id = $1`, [fx.matter])
  matterNumber = num.rows[0].matter_number as string
})

afterAll(async () => {
  setM365Service(null)
  await closePool()
  await admin.end()
})

describe('the Microsoft 365 email module', () => {
  it('unbound, every Microsoft-touching operation refuses typed', async () => {
    setM365Service(null)
    await expect(
      sendMatterEmail(P, { matter: fx.matter, to: ['x@example.test'], subject: 'hi', bodyHtml: 'x' }),
    ).rejects.toMatchObject({ code: 'm365_unbound' })
    setM365Service({
      consentUrl: (state) => `https://consent.example/${state}`,
      async exchangeCode() {
        return {
          msUserId: 'ms-user-m36',
          email: 'lawyer@hosted.test',
          displayName: 'M36 Lawyer',
          scopes: 'mail',
          accessToken: 'FAKE-AT-SECRET-1',
          refreshToken: 'FAKE-RT-SECRET-1',
          expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
        }
      },
      async refresh() {
        refreshes++
        return {
          accessToken: `FAKE-AT-SECRET-${refreshes + 1}`,
          refreshToken: `FAKE-RT-SECRET-${refreshes + 1}`,
          expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
        }
      },
      async listInboxSince() {
        return inbox
      },
      async sendMail(_at, input) {
        sends.push({ to: input.to, subject: input.subject })
        return {}
      },
      async createEvent() {
        return { msEventId: 'ev-m36-1', webLink: 'https://cal.example/ev-m36-1' }
      },
      // The shared-mailbox surface — this suite never uses it;
      // the increments suite exercises the filing leg with its own fake.
      async listMailboxInboxSince() {
        return []
      },
      async listAttachments() {
        return []
      },
      async fetchAttachment() {
        return Buffer.alloc(0)
      },
      async markRead() {},
    })
  })

  it('connect stores the identity; the register carries no token', async () => {
    await connectM365Account(P, { code: 'auth-code' })
    const mine = await myM365Connection(P)
    expect(mine.connected).toBe(true)
    expect(mine.email).toBe('lawyer@hosted.test')
    const reg = await admin.query(
      `select detail::text as d from deedbox.register_entry
        where subject_type = 'm365_connection' and subject = $1 order by id desc limit 1`,
      [fx.staff],
    )
    expect((reg.rows[0].d as string).includes('FAKE-AT-SECRET')).toBe(false)
    expect((reg.rows[0].d as string).includes('FAKE-RT-SECRET')).toBe(false)
  })

  it('send refuses without a connection, stamps the tag, files the copy and the signal', async () => {
    await expect(
      sendMatterEmail(P2, { matter: fx.matter, to: ['c@example.test'], subject: 'hi', bodyHtml: 'x' }),
    ).rejects.toMatchObject({ code: 'no_connection' })

    const r = await sendMatterEmail(P, {
      matter: fx.matter,
      to: ['client@example.test'],
      subject: 'Your engagement letter',
      bodyHtml: '<p>Please see attached.</p>',
    })
    expect(sends.length).toBe(1)
    expect(sends[0].subject).toBe(`Your engagement letter [${matterNumber}]`)
    const row = await admin.query(
      `select direction, subject, staff from deedbox.matter_email where id = $1`,
      [r.email],
    )
    expect(row.rows[0].direction).toBe('sent')
    expect(row.rows[0].staff).toBe(fx.staff)
    const sig = await admin.query(
      `select 1 from deedbox.activity_signal
        where source_module = 'email' and source_ref = $1 and signal_kind = 'email_sent'`,
      [`matter_email:${r.email}`],
    )
    expect(sig.rowCount).toBe(1)
  })

  it('the poll files exactly the tagged message, ignores untagged, and dedupes', async () => {
    inbox = [
      {
        msMessageId: 'g-1',
        internetMessageId: '<in-1@example>',
        subject: `Re: Your engagement letter [${matterNumber}]`,
        bodyPreview: 'Thanks, looks right.',
        bodyHtml: '<p>Thanks, looks right.</p>',
        from: 'client@example.test',
        to: ['lawyer@hosted.test'],
        cc: [],
        receivedAt: new Date().toISOString(),
      },
      {
        msMessageId: 'g-2',
        internetMessageId: '<in-2@example>',
        subject: 'Lunch on Friday?',
        bodyPreview: 'No tag here.',
        from: 'friend@example.test',
        to: ['lawyer@hosted.test'],
        cc: [],
        receivedAt: new Date().toISOString(),
      },
    ]
    const first = await runMailPoll(P)
    expect(first.connections).toBe(1)
    expect(first.filed).toBe(1)
    const again = await runMailPoll(P)
    expect(again.filed).toBe(0)
    const mine = await myM365Connection(P)
    expect(mine.lastPolledAt).not.toBeNull()
    const tab = await matterEmailTab(P, fx.matter)
    expect(tab.emails.some((e) => e.direction === 'received' && e.fromAddress === 'client@example.test')).toBe(true)
    expect(tab.emails.some((e) => e.subject === 'Lunch on Friday?')).toBe(false)
  })

  it('a stale token refreshes through the seam and persists', async () => {
    await admin.query(
      `update deedbox.m365_connection set token_expires_at = now() - interval '1 minute' where staff = $1`,
      [fx.staff],
    )
    await sendMatterEmail(P, {
      matter: fx.matter,
      to: ['client@example.test'],
      subject: 'Follow-up',
      bodyHtml: 'x',
    })
    expect(refreshes).toBe(1)
    const row = await admin.query(
      `select access_token from deedbox.m365_connection where staff = $1`,
      [fx.staff],
    )
    expect(row.rows[0].access_token).toBe('FAKE-AT-SECRET-2')
  })

  it('calendar events record on the matter', async () => {
    const ev = await createMatterCalendarEvent(P, {
      matter: fx.matter,
      subject: 'Conference with client',
      startsAt: new Date(Date.now() + 86_400_000).toISOString(),
      location: 'Office',
    })
    const row = await admin.query(
      `select ms_event_id, web_link from deedbox.matter_calendar_event where id = $1`,
      [ev.event],
    )
    expect(row.rows[0].ms_event_id).toBe('ev-m36-1')
    const tab = await matterEmailTab(P, fx.matter)
    expect(tab.events.some((e) => e.subject === 'Conference with client')).toBe(true)
  })

  it('disconnect removes the account from the poll', async () => {
    await disconnectM365Account(P)
    const mine = await myM365Connection(P)
    expect(mine.connected).toBe(false)
    const swept = await runMailPoll(P)
    expect(swept.connections).toBe(0)
  })
})
