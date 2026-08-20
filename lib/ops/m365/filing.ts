// The shared filing-mailbox leg — the earlier recorded deferral. Mail
// addressed to filing+<matter token>@<the firm's shared filing mailbox>
// files onto the matter whose token matches: the body and every file
// attachment land as documents (the arrival evidence table, source
// email_filing), exactly once per (matter, message) through the receipt
// ledger, then the message is marked read. Mail with no recognisable
// token, an unknown token, or a CLOSED matter's token is left unread for a
// human — a closed matter is read-only with no carve-outs.
//
// The poll runs as the SYSTEM job and the register carries that actor
// honestly (the gl-sync/dishonour posture); the reader staff member —
// whose delegated connection actually reads the mailbox — is attributed on
// each document row (created_by/uploaded_by are data, the actor is the
// register's business). Network calls sit OUTSIDE every transaction; bytes
// are stored before the rows that name them.

import { randomBytes } from 'node:crypto'
import type { Principal, Tx } from '@/lib/db'
import { withPrincipal, emitRegister, OperationRefused } from '@/lib/db'
import { requireStaff } from '@/lib/ops/shared'
import { requireByteStore } from '@/lib/ops/documents/store'
import { extractText } from '@/lib/ops/documents/extract'
import { writeVersionTextInTx } from '@/lib/ops/documents/documents'
import { m365Service, type InboundMessage } from './seam'
import { freshConnectionInTx } from './connections'

// filing+<token>@ is the canonical address shape; matter-<token>@ is also
// accepted.
const FILING_TOKEN_RE = /(?:filing\+|matter-)([a-z0-9]+)@/i

const TOKEN_ALPHABET = 'abcdefghijklmnopqrstuvwxyz0123456789'

function mintToken(): string {
  const bytes = randomBytes(12)
  let out = ''
  for (const b of bytes) out += TOKEN_ALPHABET[b % TOKEN_ALPHABET.length]
  return out
}

function extractFilingToken(addresses: string[]): string | null {
  for (const a of addresses) {
    const m = String(a || '').match(FILING_TOKEN_RE)
    if (m) return m[1].toLowerCase()
  }
  return null
}

function safeFileName(name: string): string {
  return (name || 'attachment').replace(/[^\w.\-() ]+/g, '_').slice(0, 180)
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c] ?? c))
}

function stripHtml(html: string): string {
  return html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim()
}

/** The matter's filing address parts, minting the token on first ask. */
export async function ensureFilingToken(
  p: Principal,
  input: { matter: number },
): Promise<{ token: string }> {
  requireStaff(p)
  return withPrincipal(p, async (tx) => {
    const m = await tx.query(`select status, filing_token from deedbox.matter where id = $1`, [
      input.matter,
    ])
    if (m.rowCount === 0) throw new OperationRefused('not_found', 'no matter by that id')
    if (m.rows[0].status === 'closed' || m.rows[0].status === 'archived') {
      throw new OperationRefused('matter_closed', 'the matter is closed')
    }
    const existing = m.rows[0].filing_token as string | null
    if (existing) return { token: existing }
    const token = mintToken()
    await tx.query(`update deedbox.matter set filing_token = $2 where id = $1`, [
      input.matter,
      token,
    ])
    await emitRegister(tx, p, {
      kind: 'record.changed',
      subjectType: 'matter',
      subject: input.matter,
      detail: { filing_token_minted: true },
    })
    return { token }
  })
}

export interface FilingConfig {
  mailbox: string | null
  readerEmail: string | null
}

export async function filingConfigInTx(tx: Tx): Promise<FilingConfig> {
  const r = await tx.query(
    `select deedbox.current_setting_value('m365.filing_mailbox_address') #>> '{}' as mailbox,
            deedbox.current_setting_value('m365.filing_reader_email') #>> '{}' as reader`,
  )
  const row = r.rows[0] as { mailbox: string | null; reader: string | null }
  return {
    mailbox: (row.mailbox ?? '').trim() || null,
    readerEmail: (row.reader ?? '').trim() || null,
  }
}

export interface FilingPollResult {
  configured: boolean
  ok: boolean
  reason?: string
  mailbox?: string
  reader?: string
  scanned: number
  filed: number
  documentsCreated: number
  duplicates: number
  unmatched: number
  skippedClosed: number
  errors: string[]
}

/**
 * The poll (job id 24). One listing sweep; each filed message is its own
 * transaction, so one bad message never blocks the rest of the mailbox.
 */
export async function runFilingMailboxPoll(p: Principal): Promise<FilingPollResult> {
  const svc = m365Service()
  const none: Omit<FilingPollResult, 'configured' | 'ok' | 'reason'> = {
    scanned: 0,
    filed: 0,
    documentsCreated: 0,
    duplicates: 0,
    unmatched: 0,
    skippedClosed: 0,
    errors: [],
  }

  // Sweep setup in one transaction: the switch settings, the reader's
  // connection (tokens refreshed and PERSISTED), the watermark.
  const setup = await withPrincipal(p, async (tx) => {
    const cfg = await filingConfigInTx(tx)
    if (!cfg.mailbox || !cfg.readerEmail) return { configured: false as const }
    const reader = await tx.query(
      `select staff from deedbox.m365_connection where active and lower(email) = lower($1)`,
      [cfg.readerEmail],
    )
    if (reader.rowCount === 0) {
      return {
        configured: true as const,
        ready: false as const,
        mailbox: cfg.mailbox,
        readerEmail: cfg.readerEmail,
      }
    }
    const live = await freshConnectionInTx(tx, reader.rows[0].staff as number)
    const cursor = await tx.query(
      `select last_polled_at from deedbox.m365_filing_cursor where only_row`,
    )
    const since = cursor.rowCount
      ? new Date(new Date(cursor.rows[0].last_polled_at as string).getTime() - 2 * 60_000)
      : new Date(Date.now() - 7 * 24 * 3600_000)
    return {
      configured: true as const,
      ready: true as const,
      mailbox: cfg.mailbox,
      readerEmail: cfg.readerEmail,
      readerStaff: live.staff,
      accessToken: live.accessToken,
      sinceIso: since.toISOString(),
    }
  })

  if (!setup.configured) return { configured: false, ok: true, reason: 'not_configured', ...none }
  if (!setup.ready) {
    return {
      configured: true,
      ok: false,
      reason: 'reader_not_connected',
      mailbox: setup.mailbox,
      reader: setup.readerEmail,
      ...none,
    }
  }

  // The listing rides the network outside any transaction.
  const messages = await svc.listMailboxInboxSince(setup.accessToken, setup.mailbox, setup.sinceIso)

  const out: FilingPollResult = {
    configured: true,
    ok: true,
    mailbox: setup.mailbox,
    reader: setup.readerEmail,
    ...none,
    scanned: messages.length,
  }

  for (const msg of messages) {
    try {
      const outcome = await fileOneMessage(p, setup, msg)
      if (outcome.kind === 'filed') {
        out.filed += 1
        out.documentsCreated += outcome.documents
      } else if (outcome.kind === 'duplicate') out.duplicates += 1
      else if (outcome.kind === 'closed') out.skippedClosed += 1
      else out.unmatched += 1
      if (outcome.kind === 'filed' || outcome.kind === 'duplicate') {
        try {
          await svc.markRead(setup.accessToken, setup.mailbox, msg.msMessageId)
        } catch {
          // best-effort; the receipt ledger absorbs a re-scan
        }
      }
    } catch (e) {
      out.errors.push(
        `${(msg.subject ?? '').slice(0, 60)}: ${String((e as Error).message ?? e).slice(0, 160)}`,
      )
    }
  }

  await withPrincipal(p, async (tx) => {
    await tx.query(
      `insert into deedbox.m365_filing_cursor (only_row, last_polled_at) values (true, now())
       on conflict (only_row) do update set last_polled_at = excluded.last_polled_at`,
    )
  })

  return out
}

type FileOutcome =
  | { kind: 'filed'; documents: number }
  | { kind: 'duplicate' }
  | { kind: 'unmatched' }
  | { kind: 'closed' }

async function fileOneMessage(
  p: Principal,
  setup: { mailbox: string; readerStaff: number; accessToken: string },
  msg: InboundMessage,
): Promise<FileOutcome> {
  const svc = m365Service()
  const token = extractFilingToken([...msg.to, ...msg.cc])
  if (!token) return { kind: 'unmatched' }

  // Resolve the matter and the dedup BEFORE any byte work.
  const target = await withPrincipal(
    p,
    async (tx) => {
      const m = await tx.query(
        `select id, status from deedbox.matter where filing_token = $1`,
        [token],
      )
      if (m.rowCount === 0) return { kind: 'unmatched' as const }
      if (m.rows[0].status === 'closed' || m.rows[0].status === 'archived') {
        return { kind: 'closed' as const }
      }
      const seen = await tx.query(
        `select 1 from deedbox.m365_filing_receipt where matter = $1 and internet_message_id = $2`,
        [m.rows[0].id, msg.internetMessageId],
      )
      if ((seen.rowCount ?? 0) > 0) return { kind: 'duplicate' as const }
      return { kind: 'file' as const, matter: m.rows[0].id as number }
    },
    { readOnly: true },
  )
  if (target.kind === 'unmatched') return { kind: 'unmatched' }
  if (target.kind === 'closed') return { kind: 'closed' }
  if (target.kind === 'duplicate') return { kind: 'duplicate' }

  const store = requireByteStore()
  const subject = (msg.subject ?? '').trim() || '(no subject)'
  const fromAddr = msg.from ?? '(unknown sender)'

  // Bytes first, all of them, outside the row transaction.
  const isHtml = Boolean(msg.bodyHtml)
  const bodyContent = msg.bodyHtml ?? msg.bodyPreview ?? ''
  const bodyBytes = Buffer.from(
    isHtml
      ? `<!doctype html><meta charset="utf-8"><title>${escapeHtml(subject)}</title>${bodyContent}`
      : bodyContent,
    'utf8',
  )
  const bodyName = `${safeFileName(subject)}.${isHtml ? 'html' : 'txt'}`
  const stored: {
    filename: string
    contentType: string
    bytes: Buffer
    storageRef: string
    title: string
    /** The body's text is stored stripped of markup;
     *  attachments ride ordinary extraction. */
    textOverride?: { content: string; method: 'embedded' }
  }[] = []
  const bodyStored = await store({ matter: target.matter, filename: bodyName, bytes: bodyBytes })
  const bodyText = (isHtml ? stripHtml(bodyContent) : bodyContent).trim().slice(0, 200_000)
  stored.push({
    filename: bodyName,
    contentType: bodyStored.contentType,
    bytes: bodyBytes,
    storageRef: bodyStored.storageRef,
    title: subject,
    textOverride: { content: bodyText, method: 'embedded' },
  })

  if (msg.hasAttachments) {
    const atts = await svc.listAttachments(setup.accessToken, setup.mailbox, msg.msMessageId)
    for (const att of atts) {
      const bytes = att.bytesBase64
        ? Buffer.from(att.bytesBase64, 'base64')
        : await svc.fetchAttachment(setup.accessToken, setup.mailbox, msg.msMessageId, att.id)
      const cleanName = safeFileName(att.name)
      const attStored = await store({ matter: target.matter, filename: cleanName, bytes })
      stored.push({
        filename: cleanName,
        contentType: attStored.contentType,
        bytes,
        storageRef: attStored.storageRef,
        title: cleanName,
      })
    }
  }

  // One transaction: the receipt (the exactly-once claim), every document,
  // its version, its extracted text, its register entry.
  await withPrincipal(p, async (tx) => {
    await tx.query(
      `insert into deedbox.m365_filing_receipt
         (matter, internet_message_id, subject, from_address, document_count)
       values ($1, $2, $3, $4, $5)`,
      [target.matter, msg.internetMessageId, subject.slice(0, 250), fromAddr.slice(0, 250), stored.length],
    )
    for (const item of stored) {
      const file = await tx.query(
        `insert into deedbox.document_file
           (matter, filename, content_type, size_bytes, storage_ref, source, uploaded_by)
         values ($1, $2, $3, $4, $5, 'email_filing', $6) returning id`,
        [target.matter, item.filename, item.contentType, item.bytes.length, item.storageRef, setup.readerStaff],
      )
      const fileId = file.rows[0].id as number
      const head = await tx.query(
        `insert into deedbox.document
           (matter, folder, title, description, current_file, current_version, created_by)
         values ($1, null, $2, $3, $4, 1, $5) returning id`,
        [
          target.matter,
          item.title.slice(0, 250),
          `Filed from the shared mailbox — from ${fromAddr}: ${subject}`.slice(0, 500),
          fileId,
          setup.readerStaff,
        ],
      )
      const docId = head.rows[0].id as number
      const version = await tx.query(
        `insert into deedbox.document_version (document, version_no, file, comment, created_by)
         values ($1, 1, $2, 'filed from the shared mailbox', $3) returning id`,
        [docId, fileId, setup.readerStaff],
      )
      await writeVersionTextInTx(
        tx,
        version.rows[0].id as number,
        docId,
        item.textOverride ?? (await extractText(item.bytes, item.filename, item.contentType)),
      )
      await emitRegister(tx, p, {
        kind: 'record.created',
        subjectType: 'document',
        subject: docId,
        detail: {
          matter: target.matter,
          source: 'filing_mailbox',
          from: fromAddr,
          subject,
          internet_message_id: msg.internetMessageId,
          filename: item.filename,
        },
      })
    }
  })
  return { kind: 'filed', documents: stored.length }
}
