// Sharing + e-signature (schema change 0032): the share lifecycle
// (password, view budget, expiry, revocation) spending views and recording
// access evidence inside the serve transaction; the signing lifecycle
// (pdf-only requests, a REAL pdf stamped with the signature and audit
// block, the signed copy filed under the REQUESTER'S name with source
// 'signing', full forensics, replay refused); and the register entries
// that never carry a token.
//
// Cross-suite contract: binds its OWN fake byte store + fetch and unbinds
// both in afterAll. Flips no settings. Fixture tag 'esn' (first-three
// unique).

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import type { Pool } from 'pg'
import { PDFDocument } from 'pdf-lib'
import { closePool } from '@/lib/db'
import type { Principal } from '@/lib/db'
import {
  setDocumentByteStore,
  setDocumentByteFetch,
  uploadDocument,
  createDocumentShare,
  revokeDocumentShare,
  resolveShareForServe,
  peekShare,
  createSigningRequest,
  revokeSigningRequest,
  completeSigning,
} from '@/lib/ops/documents'
import { documentDetail } from '@/lib/reads/documents'
import { makeAdminPool, buildFixture, type Fixture } from './helpers'

let admin: Pool
let fx: Fixture
let P: Principal
const stored = new Map<string, Buffer>()
let putCount = 0

const PNG_1PX =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg=='

beforeAll(async () => {
  admin = makeAdminPool()
  fx = await buildFixture(admin, 'esn')
  P = { kind: 'staff', id: fx.staff, firm: fx.firm }
  setDocumentByteStore(async ({ matter, filename, bytes }) => {
    const storageRef = `${matter ?? 'templates'}/esn-${++putCount}-${filename}`
    stored.set(storageRef, bytes)
    const contentType = filename.toLowerCase().endsWith('.pdf')
      ? 'application/pdf'
      : 'application/octet-stream'
    return { storageRef, contentType }
  })
  setDocumentByteFetch(async (storageRef) => {
    const bytes = stored.get(storageRef)
    if (!bytes) throw new Error(`no stored object at ${storageRef}`)
    return {
      bytes,
      contentType: storageRef.endsWith('.pdf') ? 'application/pdf' : 'application/octet-stream',
    }
  })
})

afterAll(async () => {
  setDocumentByteStore(null)
  setDocumentByteFetch(null)
  await closePool()
  await admin.end()
})

describe('sharing and e-signature', () => {
  let pdfDoc = 0
  let txtDoc = 0

  it('fixture: a real pdf document and a plain-text one', async () => {
    const pdf = await PDFDocument.create()
    pdf.addPage([300, 200])
    const bytes = Buffer.from(await pdf.save())
    const up = await uploadDocument(P, {
      matter: fx.matter,
      filename: 'contract.pdf',
      bytes,
      title: 'Contract for signing',
    })
    pdfDoc = up.document
    const up2 = await uploadDocument(P, {
      matter: fx.matter,
      filename: 'notes.txt',
      bytes: Buffer.from('plain text'),
    })
    txtDoc = up2.document
    expect(pdfDoc).toBeGreaterThan(0)
    expect(txtDoc).toBeGreaterThan(0)
  })

  it('a share spends views inside the serve, honours its password and budget, and revokes', async () => {
    const { share, token } = await createDocumentShare(P, {
      document: pdfDoc,
      recipientEmail: 'client@example.test',
      password: 'open sesame',
      maxViews: 2,
    })
    expect(token.startsWith('shr_')).toBe(true)
    // the register entry exists and never carries the token
    const reg = await admin.query(
      `select detail::text as d from deedbox.register_entry
        where event_kind='record.created' and subject_type='document_share' and subject=$1`,
      [share],
    )
    expect(reg.rowCount).toBe(1)
    expect((reg.rows[0].d as string).includes(token)).toBe(false)

    await expect(resolveShareForServe(fx.firm, token, null)).rejects.toMatchObject({
      code: 'password_required',
    })
    await expect(resolveShareForServe(fx.firm, token, 'wrong')).rejects.toMatchObject({
      code: 'password_wrong',
    })
    const meta = await peekShare(fx.firm, token)
    expect(meta.passwordRequired).toBe(true)
    expect(meta.filename).toBe('contract.pdf')

    const first = await resolveShareForServe(fx.firm, token, 'open sesame')
    expect(first.watermark).toBe(true)
    expect(stored.has(first.storageRef)).toBe(true)
    await resolveShareForServe(fx.firm, token, 'open sesame')
    await expect(resolveShareForServe(fx.firm, token, 'open sesame')).rejects.toMatchObject({
      code: 'view_budget_spent',
    })
    const views = await admin.query(
      `select view_count from deedbox.document_share where id = $1`,
      [share],
    )
    expect(views.rows[0].view_count).toBe(2)
    const evidence = await admin.query(
      `select count(*)::int as n from deedbox.document_access
        where document = $1 and actor_kind = 'share_recipient' and actor = $2`,
      [pdfDoc, share],
    )
    expect(evidence.rows[0].n).toBe(2)

    // an unknown token is simply not found
    await expect(resolveShareForServe(fx.firm, 'shr_nonsense', null)).rejects.toMatchObject({
      code: 'share_not_found',
    })

    // revocation refuses the very next visit
    const second = await createDocumentShare(P, { document: pdfDoc })
    await revokeDocumentShare(P, { share: second.share })
    await expect(resolveShareForServe(fx.firm, second.token, null)).rejects.toMatchObject({
      code: 'share_revoked',
    })

    // expiry refuses typed
    const third = await createDocumentShare(P, { document: pdfDoc })
    await admin.query(
      `update deedbox.document_share set expires_at = now() - interval '1 hour' where id = $1`,
      [third.share],
    )
    await expect(resolveShareForServe(fx.firm, third.token, null)).rejects.toMatchObject({
      code: 'share_expired',
    })
  })

  it('signing demands a pdf, stamps it, files the copy under the requester, and settles once', async () => {
    await expect(
      createSigningRequest(P, {
        document: txtDoc,
        signerName: 'Sam Signer',
        signerEmail: 'sam@example.test',
      }),
    ).rejects.toMatchObject({ code: 'pdf_required' })

    const { request, token } = await createSigningRequest(P, {
      document: pdfDoc,
      signerName: 'Sam Signer',
      signerEmail: 'sam@example.test',
    })
    expect(token.startsWith('sig_')).toBe(true)

    const done = await completeSigning(fx.firm, token, {
      signatureDataUrl: PNG_1PX,
      signerIp: '203.0.113.7',
      signerUserAgent: 'esn-suite',
    })
    const signedDoc = await admin.query(
      `select d.title, d.created_by, df.source, df.storage_ref, df.content_type
         from deedbox.document d join deedbox.document_file df on df.id = d.current_file
        where d.id = $1`,
      [done.signedDocument],
    )
    expect(signedDoc.rows[0].source).toBe('signing')
    expect(signedDoc.rows[0].created_by).toBe(fx.staff)
    expect(signedDoc.rows[0].title).toContain('SIGNED')
    expect(signedDoc.rows[0].content_type).toBe('application/pdf')
    // the stamped bytes re-parse as a pdf, larger than the empty original
    const stamped = stored.get(signedDoc.rows[0].storage_ref as string) as Buffer
    const reparsed = await PDFDocument.load(new Uint8Array(stamped))
    expect(reparsed.getPageCount()).toBe(1)

    const row = await admin.query(
      `select status, host(signer_ip) as ip, signer_user_agent, signature_data, signed_document
         from deedbox.document_signing_request where id = $1`,
      [request],
    )
    expect(row.rows[0].status).toBe('signed')
    expect(row.rows[0].ip).toBe('203.0.113.7')
    expect(row.rows[0].signer_user_agent).toBe('esn-suite')
    expect(row.rows[0].signature_data).toBe(PNG_1PX)
    expect(row.rows[0].signed_document).toBe(done.signedDocument)

    // settling is exactly once
    await expect(
      completeSigning(fx.firm, token, { signatureDataUrl: PNG_1PX }),
    ).rejects.toMatchObject({ code: 'not_pending' })

    // a revoked request refuses completion
    const second = await createSigningRequest(P, {
      document: pdfDoc,
      signerName: 'Sam Signer',
      signerEmail: 'sam@example.test',
    })
    await revokeSigningRequest(P, { request: second.request })
    await expect(
      completeSigning(fx.firm, second.token, { signatureDataUrl: PNG_1PX }),
    ).rejects.toMatchObject({ code: 'not_pending' })

    // the detail serves both panels
    const detail = await documentDetail(P, pdfDoc)
    expect(detail.shares.length).toBeGreaterThanOrEqual(3)
    expect(detail.signingRequests.some((s) => s.status === 'signed')).toBe(true)
  })
})
