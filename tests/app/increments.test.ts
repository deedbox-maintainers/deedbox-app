// Three small increments (schema changes 0039 + 0040): the browser OCR
// write-back (method 'ocr' landing in the version-text home and feeding
// the same search the embedded path feeds), the Open-in-Word door's token
// discipline and save-releases-checkout semantics, and the shared
// filing-mailbox leg (dark until both settings are set; reader connection
// required; body + attachments filed as documents exactly once per message
// through the receipt ledger; unmatched mail left alone; the cursor
// advancing).
//
// Cross-suite contract: flips ONLY the m365.filing_* settings (no other
// suite reads them; rows stamped 45/40 minutes back). Binds its OWN byte
// store and M365 fakes and restores both to null in afterAll. Fixture tag
// 'inc' (first-three unique). The closed-matter skip path is exercised by
// the shared refuseClosed machinery, not re-proven here (recorded).

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import type { Pool } from 'pg'
import { closePool } from '@/lib/db'
import type { Principal } from '@/lib/db'
import {
  setDocumentByteStore,
  uploadDocument,
  recordOcrText,
  checkoutDocument,
  addDocumentVersion,
} from '@/lib/ops/documents'
import { signDavToken, verifyDavToken, officeOpenLink } from '@/lib/ops/documents/dav'
import { documentDetail } from '@/lib/reads/documents'
import {
  setM365Service,
  connectM365Account,
  disconnectM365Account,
  ensureFilingToken,
  runFilingMailboxPoll,
} from '@/lib/ops/m365'
import type { InboundMessage, InboundAttachment } from '@/lib/ops/m365'
import { matterFilingAddress } from '@/lib/reads/m365'
import { makeAdminPool, buildFixture, setFirmSetting, type Fixture } from './helpers'

let admin: Pool
let fx: Fixture
let P: Principal
let P2: Principal
let SYS: Principal

const readIds: string[] = []
let mailboxScript: InboundMessage[] = []

function contentTypeFor(filename: string): string {
  if (/\.html$/i.test(filename)) return 'text/html'
  if (/\.txt$/i.test(filename)) return 'text/plain'
  if (/\.png$/i.test(filename)) return 'image/png'
  if (/\.docx$/i.test(filename)) return 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
  return 'application/pdf'
}

const ATT_SMALL: InboundAttachment = {
  id: 'att-1',
  name: 'engagement letter.pdf',
  contentType: 'application/pdf',
  sizeBytes: 10,
  bytesBase64: Buffer.from('SMALLPDF').toString('base64'),
}
const ATT_LARGE: InboundAttachment = {
  id: 'att-2',
  name: 'bundle.pdf',
  contentType: 'application/pdf',
  sizeBytes: 20,
  // no bytesBase64 — the poll must fetch the raw bytes
}

beforeAll(async () => {
  admin = makeAdminPool()
  fx = await buildFixture(admin, 'inc')
  P = { kind: 'staff', id: fx.staff, firm: fx.firm }
  SYS = { kind: 'system_job', id: 24, firm: fx.firm }
  const adminRole = await admin.query(`select id from deedbox.role where system_key = 'administrator'`)
  const s2 = await admin.query(
    `insert into deedbox.staff_member (person_name, login, role, office, email)
     values ('{"given":"Second","family":"Editor"}','second.inc', $1, $2, 'second.inc@example.test')
     returning id`,
    [adminRole.rows[0].id, fx.office],
  )
  P2 = { kind: 'staff', id: s2.rows[0].id as number, firm: fx.firm }
  setM365Service(null)
  let puts = 0
  setDocumentByteStore(async ({ matter, filename }) => ({
    storageRef: `${matter ?? 'tpl'}/inc-${++puts}-${filename}`,
    contentType: contentTypeFor(filename),
  }))
})

afterAll(async () => {
  // The shared scratch hosts every suite: the m365 suite COUNTS active
  // connections in its poll assertions, so this suite's reader connection
  // must not outlive it (paid for with one failed app-gate run — a leaked
  // active connection is a cross-suite global exactly like a setting).
  await disconnectM365Account(P).catch(() => {})
  setM365Service(null)
  setDocumentByteStore(null)
  delete process.env.DEEDBOX_DAV_SECRET
  delete process.env.DEEDBOX_APP_ORIGIN
  await admin.end()
  await closePool()
})

describe('the small increments', () => {
  let scanDoc = 0

  it('OCR: a scan with no embedded text takes recognised text and becomes searchable', async () => {
    const up = await uploadDocument(P, {
      matter: fx.matter,
      filename: 'letter scan.png',
      bytes: Buffer.from('not really an image, yields no text'),
      title: 'Scanned letter',
    })
    scanDoc = up.document
    let detail = await documentDetail(P, scanDoc)
    expect(detail.versions[0].textMethod).toBe('none')

    await expect(recordOcrText(P, { document: scanDoc, content: '   ' })).rejects.toMatchObject({
      code: 'text_required',
    })

    const r = await recordOcrText(P, {
      document: scanDoc,
      content: 'Dear Sir, the distinctive settlement token incocr9x appears here.',
    })
    expect(r.chars).toBeGreaterThan(20)
    detail = await documentDetail(P, scanDoc)
    expect(detail.versions[0].textMethod).toBe('ocr')
    expect(detail.versions[0].textChars).toBe(r.chars)

    const idx = await admin.query(
      `select body from deedbox.search_index where entry_type = 'document' and source = $1`,
      [scanDoc],
    )
    expect(idx.rowCount).toBe(1)
    expect(String(idx.rows[0].body)).toContain('incocr9x')

    // re-recognition upserts, never a second row
    await recordOcrText(P, { document: scanDoc, content: 'Second pass incocr9x refined.' })
    const rows = await admin.query(
      `select count(*)::int as n from deedbox.document_version_text t
        join deedbox.document_version v on v.id = t.version where v.document = $1`,
      [scanDoc],
    )
    expect(rows.rows[0].n).toBe(1)
  })

  it('DAV tokens: round-trip, expiry, tamper; the render-time link is honest about configuration', async () => {
    const secret = 'a-test-secret-well-over-thirty-two-characters-long'
    const payload = { doc: 12, uid: fx.staff, firm: fx.firm, exp: Math.floor(Date.now() / 1000) + 600 }
    const token = signDavToken(payload, secret)
    expect(verifyDavToken(token, secret)).toEqual(payload)
    expect(
      verifyDavToken(
        signDavToken({ ...payload, exp: Math.floor(Date.now() / 1000) - 5 }, secret),
        secret,
      ),
    ).toBeNull()
    const [head, sig] = token.split('.')
    const tampered = `${head}.${sig.slice(0, -2)}${sig.endsWith('AA') ? 'BB' : 'AA'}`
    expect(verifyDavToken(tampered, secret)).toBeNull()
    expect(verifyDavToken(token, secret + 'x')).toBeNull()

    // unconfigured = no link at all
    delete process.env.DEEDBOX_DAV_SECRET
    delete process.env.DEEDBOX_APP_ORIGIN
    expect(
      officeOpenLink({ document: 1, filename: 'advice.docx', staff: fx.staff, firm: fx.firm }),
    ).toBeNull()
    process.env.DEEDBOX_DAV_SECRET = secret
    process.env.DEEDBOX_APP_ORIGIN = 'https://firm.example'
    const link = officeOpenLink({ document: 1, filename: 'advice.docx', staff: fx.staff, firm: fx.firm })
    expect(link?.app).toBe('Word')
    expect(link?.href.startsWith('ms-word:ofe|u|https://firm.example/api/dav/')).toBe(true)
    // not an Office file = no link
    expect(
      officeOpenLink({ document: 1, filename: 'scan.png', staff: fx.staff, firm: fx.firm }),
    ).toBeNull()
  })

  it('DAV save semantics: the save rides version-add, releasing the holder and refusing strangers', async () => {
    const up = await uploadDocument(P, {
      matter: fx.matter,
      filename: 'deed.docx',
      bytes: Buffer.from('v1 of the deed'),
      title: 'The deed',
    })
    await checkoutDocument(P, { document: up.document, purpose: 'Office edit-in-place (WebDAV)' })
    await expect(
      addDocumentVersion(P2, { document: up.document, filename: 'deed.docx', bytes: Buffer.from('x') }),
    ).rejects.toMatchObject({ code: 'checked_out_elsewhere' })
    const saved = await addDocumentVersion(P, {
      document: up.document,
      filename: 'deed.docx',
      bytes: Buffer.from('v2 saved from Office'),
      comment: 'Saved from Office (WebDAV)',
    })
    expect(saved.version).toBe(2)
    const detail = await documentDetail(P, up.document)
    expect(detail.document.checkedOutBy).toBeNull()
    expect(detail.versions[0].comment).toBe('Saved from Office (WebDAV)')
  })

  it('filing: dark until both settings are set; a named reader must be connected', async () => {
    const dark = await runFilingMailboxPoll(SYS).catch((e) => e)
    // unbound M365 service refuses typed before configuration is even read
    expect(dark).toMatchObject({ code: 'm365_unbound' })

    setM365Service({
      consentUrl: (state) => `https://consent.example/${state}`,
      async exchangeCode() {
        return {
          msUserId: 'ms-user-inc',
          email: 'reader@inc.example',
          displayName: 'Inc Reader',
          scopes: 'mail',
          accessToken: 'INC-AT-1',
          refreshToken: 'INC-RT-1',
          expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
        }
      },
      async refresh() {
        return {
          accessToken: 'INC-AT-2',
          refreshToken: 'INC-RT-2',
          expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
        }
      },
      async listInboxSince() {
        return []
      },
      async sendMail() {
        return {}
      },
      async createEvent() {
        return { msEventId: 'ev-inc-1' }
      },
      async listMailboxInboxSince() {
        return mailboxScript
      },
      async listAttachments(_at, _mb, msMessageId) {
        return msMessageId === 'ms-a' ? [ATT_SMALL, ATT_LARGE] : []
      },
      async fetchAttachment(_at, _mb, _msg, attachmentId) {
        if (attachmentId !== 'att-2') throw new Error('unexpected attachment fetch')
        return Buffer.from('LARGE-PDF-RAW-BYTES')
      },
      async markRead(_at, _mb, msMessageId) {
        readIds.push(msMessageId)
      },
    })

    const off = await runFilingMailboxPoll(SYS)
    expect(off.configured).toBe(false)

    await setFirmSetting(admin, 'm365.filing_mailbox_address', 'filing@inc.example', 45)
    await setFirmSetting(admin, 'm365.filing_reader_email', 'reader@inc.example', 40)

    const unready = await runFilingMailboxPoll(SYS)
    expect(unready).toMatchObject({ configured: true, ok: false, reason: 'reader_not_connected' })
  })

  it('filing: the address exists once minted; the poll files body + attachments exactly once', async () => {
    await connectM365Account(P, { code: 'auth-code-inc' })

    const before = await matterFilingAddress(P, fx.matter)
    expect(before.configured).toBe(true)
    expect(before.address).toBeNull()
    const minted = await ensureFilingToken(P, { matter: fx.matter })
    expect(minted.token).toMatch(/^[a-z0-9]{8,32}$/)
    const again = await ensureFilingToken(P, { matter: fx.matter })
    expect(again.token).toBe(minted.token)
    const addr = await matterFilingAddress(P, fx.matter)
    expect(addr.address).toBe(`filing+${minted.token}@inc.example`)

    mailboxScript = [
      {
        msMessageId: 'ms-a',
        internetMessageId: '<msg-a@sender.example>',
        subject: 'Signed engagement inctokq7',
        bodyPreview: 'Please find attached',
        bodyHtml: '<p>Please find the signed engagement attached. inctokq7</p>',
        from: 'client@sender.example',
        to: [addr.address as string],
        cc: [],
        receivedAt: new Date().toISOString(),
        hasAttachments: true,
      },
      {
        msMessageId: 'ms-b',
        internetMessageId: '<msg-b@sender.example>',
        subject: 'No token here',
        bodyPreview: 'stray mail',
        bodyHtml: '<p>stray</p>',
        from: 'stranger@sender.example',
        to: ['filing@inc.example'],
        cc: [],
        receivedAt: new Date().toISOString(),
        hasAttachments: false,
      },
    ]

    const run = await runFilingMailboxPoll(SYS)
    expect(run).toMatchObject({ configured: true, ok: true, scanned: 2, filed: 1, unmatched: 1 })
    expect(run.documentsCreated).toBe(3)
    expect(readIds).toEqual(['ms-a'])

    const receipt = await admin.query(
      `select document_count from deedbox.m365_filing_receipt
        where matter = $1 and internet_message_id = '<msg-a@sender.example>'`,
      [fx.matter],
    )
    expect(receipt.rowCount).toBe(1)
    expect(receipt.rows[0].document_count).toBe(3)

    const files = await admin.query(
      `select df.filename, df.uploaded_by, d.created_by, d.title
         from deedbox.document_file df
         join deedbox.document d on d.current_file = df.id
        where df.matter = $1 and df.source = 'email_filing'
        order by df.id`,
      [fx.matter],
    )
    expect(files.rowCount).toBe(3)
    expect(files.rows.every((r) => r.uploaded_by === fx.staff && r.created_by === fx.staff)).toBe(true)
    expect(files.rows.map((r) => r.title)).toContain('Signed engagement inctokq7')
    expect(files.rows.map((r) => r.filename)).toContain('engagement letter.pdf')
    expect(files.rows.map((r) => r.filename)).toContain('bundle.pdf')

    // the body document's text is searchable, stored stripped of markup
    const bodyDoc = await admin.query(
      `select d.id from deedbox.document d
        join deedbox.document_file df on df.id = d.current_file
       where df.matter = $1 and df.source = 'email_filing' and df.filename like '%.html'`,
      [fx.matter],
    )
    const idx = await admin.query(
      `select body from deedbox.search_index where entry_type = 'document' and source = $1`,
      [bodyDoc.rows[0].id],
    )
    expect(String(idx.rows[0].body)).toContain('inctokq7')
    expect(String(idx.rows[0].body)).not.toContain('<p>')

    // register carries the filing evidence, actor = the system job
    const reg = await admin.query(
      `select count(*)::int as n from deedbox.register_entry
        where subject_type = 'document' and detail->>'source' = 'filing_mailbox'
          and detail->>'internet_message_id' = '<msg-a@sender.example>'`,
    )
    expect(reg.rows[0].n).toBe(3)

    // the cursor advanced
    const cur = await admin.query(`select last_polled_at from deedbox.m365_filing_cursor where only_row`)
    expect(cur.rowCount).toBe(1)
  })

  it('filing: a second sweep of the same mailbox files nothing new', async () => {
    const run = await runFilingMailboxPoll(SYS)
    expect(run.filed).toBe(0)
    expect(run.duplicates).toBe(1)
    expect(run.unmatched).toBe(1)
    const files = await admin.query(
      `select count(*)::int as n from deedbox.document_file where matter = $1 and source = 'email_filing'`,
      [fx.matter],
    )
    expect(files.rows[0].n).toBe(3)
    expect(readIds).toEqual(['ms-a', 'ms-a'])
  })
})
