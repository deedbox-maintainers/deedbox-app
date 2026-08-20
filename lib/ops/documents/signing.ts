// E-signature (schema change 0032). A signing request pins the exact PDF
// version sent for signature; the public door stamps the signature image
// and an audit block onto the PDF (laid out via pdf-lib), files the
// signed copy as its OWN document (source 'signing', created under the
// requesting staff member's name while the door acts as the system
// principal), and settles the request with the full forensic set —
// signature, time, address, browser — in ONE transaction. Settled
// requests are frozen by the schema.

import { randomBytes } from 'node:crypto'
import { PDFDocument, StandardFonts, rgb } from 'pdf-lib'
import type { Principal } from '@/lib/db'
import { withPrincipal, emitRegister, OperationRefused } from '@/lib/db'
import { requireStaff } from '@/lib/ops/shared'
import { readBrand } from '@/lib/brand'
import { requireByteStore, requireByteFetch } from './store'
import { createDocumentWithFileInTx } from './documents'
import { sha256Hex, SHARE_SIGN_DOOR_ACTOR } from './sharing'

export async function createSigningRequest(
  p: Principal,
  input: {
    document: number
    version?: number | null
    signerName: string
    signerEmail: string
    expiresDays?: number
  },
): Promise<{ request: number; token: string }> {
  requireStaff(p)
  return withPrincipal(p, async (tx) => {
    const d = await tx.query(
      `select d.id, d.current_version, m.status
         from deedbox.document d join deedbox.matter m on m.id = d.matter
        where d.id = $1 and d.soft_deleted_at is null`,
      [input.document],
    )
    if (d.rowCount === 0) throw new OperationRefused('not_found', 'no document by that id')
    const versionNo = input.version ?? (d.rows[0].current_version as number)
    const v = await tx.query(
      `select v.id, df.content_type from deedbox.document_version v
         join deedbox.document_file df on df.id = v.file
        where v.document = $1 and v.version_no = $2`,
      [input.document, versionNo],
    )
    if (v.rowCount === 0) throw new OperationRefused('not_found', 'no such version')
    if ((v.rows[0].content_type as string) !== 'application/pdf') {
      throw new OperationRefused('pdf_required', 'signing works on PDF versions — finalise to PDF first')
    }
    const token = `sig_${randomBytes(24).toString('hex')}`
    const days = input.expiresDays && input.expiresDays > 0 ? input.expiresDays : 14
    const row = await tx.query(
      `insert into deedbox.document_signing_request
         (document, version, signer_name, signer_email, token_hash, expires_at, created_by)
       values ($1, $2, $3, $4, $5, now() + make_interval(days => $6), $7) returning id`,
      [
        input.document,
        v.rows[0].id,
        input.signerName.trim(),
        input.signerEmail.trim(),
        sha256Hex(token),
        days,
        p.id,
      ],
    )
    const request = row.rows[0].id as number
    await emitRegister(tx, p, {
      kind: 'record.created',
      subjectType: 'document_signing_request',
      subject: request,
      detail: {
        document: input.document,
        version: versionNo,
        signer: input.signerEmail.trim(),
        expires_days: days,
      },
    })
    return { request, token }
  })
}

export async function revokeSigningRequest(p: Principal, input: { request: number }): Promise<void> {
  requireStaff(p)
  await withPrincipal(p, async (tx) => {
    const r = await tx.query(
      `select s.status from deedbox.document_signing_request s
         join deedbox.document d on d.id = s.document
         join deedbox.matter m on m.id = d.matter
        where s.id = $1`,
      [input.request],
    )
    if (r.rowCount === 0) throw new OperationRefused('not_found', 'no signing request by that id')
    if (r.rows[0].status !== 'pending') {
      throw new OperationRefused('not_pending', 'only a pending request revokes')
    }
    await tx.query(
      `update deedbox.document_signing_request
          set status = 'revoked', revoked_at = now(), revoked_by = $2 where id = $1`,
      [input.request, p.id],
    )
    await emitRegister(tx, p, {
      kind: 'record.changed',
      subjectType: 'document_signing_request',
      subject: input.request,
      detail: { before: { status: 'pending' }, after: { status: 'revoked' } },
    })
  })
}

/** The sign page's metadata look. */
export async function peekSigningRequest(
  firm: number,
  token: string,
): Promise<{ title: string; filename: string; signerName: string }> {
  const door: Principal = { kind: 'system_job', id: SHARE_SIGN_DOOR_ACTOR, firm }
  return withPrincipal(
    door,
    async (tx) => {
      const r = await tx.query(
        `select s.status, s.expires_at, s.signer_name, d.title, df.filename
           from deedbox.document_signing_request s
           join deedbox.document d on d.id = s.document
           join deedbox.document_version v on v.id = s.version
           join deedbox.document_file df on df.id = v.file
          where s.token_hash = $1`,
        [sha256Hex(token)],
      )
      if (r.rowCount === 0) throw new OperationRefused('share_not_found', 'no such link')
      if (r.rows[0].status !== 'pending') {
        throw new OperationRefused('not_pending', 'this request has already been settled')
      }
      if (new Date(r.rows[0].expires_at as string).getTime() < Date.now()) {
        throw new OperationRefused('share_expired', 'this link has expired')
      }
      return {
        title: r.rows[0].title as string,
        filename: r.rows[0].filename as string,
        signerName: r.rows[0].signer_name as string,
      }
    },
    { readOnly: true },
  )
}

/**
 * The public door's completion: stamp, file the signed copy, settle the
 * request — one transaction (bytes stored first, the door's own ordering).
 */
export async function completeSigning(
  firm: number,
  token: string,
  input: { signatureDataUrl: string; signerIp?: string | null; signerUserAgent?: string | null },
): Promise<{ signedDocument: number }> {
  const fetcher = requireByteFetch()
  const store = requireByteStore()
  if (!/^data:image\/(png|jpeg|jpg);base64,/.test(input.signatureDataUrl)) {
    throw new OperationRefused('signature_shape', 'the signature must be a PNG or JPEG image')
  }
  const door: Principal = { kind: 'system_job', id: SHARE_SIGN_DOOR_ACTOR, firm }
  return withPrincipal(door, async (tx) => {
    const r = await tx.query(
      `select s.id, s.status, s.expires_at, s.signer_name, s.signer_email, s.created_by,
              s.document, s.version, d.matter, d.title, d.folder,
              df.filename, df.storage_ref
         from deedbox.document_signing_request s
         join deedbox.document d on d.id = s.document
         join deedbox.document_version v on v.id = s.version
         join deedbox.document_file df on df.id = v.file
        where s.token_hash = $1
        for update of s`,
      [sha256Hex(token)],
    )
    if (r.rowCount === 0) throw new OperationRefused('share_not_found', 'no such link')
    const req = r.rows[0]
    if (req.status !== 'pending') {
      throw new OperationRefused('not_pending', 'this request has already been settled')
    }
    if (new Date(req.expires_at as string).getTime() < Date.now()) {
      throw new OperationRefused('share_expired', 'this link has expired')
    }

    const original = await fetcher(req.storage_ref as string)
    let signedBytes: Buffer
    try {
      const pdf = await PDFDocument.load(new Uint8Array(original.bytes), { ignoreEncryption: true })
      const font = await pdf.embedFont(StandardFonts.Helvetica)
      const boldFont = await pdf.embedFont(StandardFonts.HelveticaBold)
      const base64 = input.signatureDataUrl.replace(/^data:image\/(png|jpeg|jpg);base64,/, '')
      const sigBytes = Buffer.from(base64, 'base64')
      const sigImg = input.signatureDataUrl.startsWith('data:image/png')
        ? await pdf.embedPng(new Uint8Array(sigBytes))
        : await pdf.embedJpg(new Uint8Array(sigBytes))
      const sigDims = sigImg.scale(0.5)
      const lastPage = pdf.getPage(pdf.getPageCount() - 1)
      const { width: pw } = lastPage.getSize()
      lastPage.drawImage(sigImg, {
        x: pw - sigDims.width - 50,
        y: 100,
        width: Math.min(sigDims.width, 200),
        height: Math.min(sigDims.height, 80),
      })
      const when = new Date().toISOString()
      const brand = await readBrand()
      lastPage.drawText(`Signed by ${req.signer_name}`, { x: pw - 250, y: 90, size: 9, font: boldFont, color: rgb(0, 0, 0) })
      lastPage.drawText(when, { x: pw - 250, y: 78, size: 8, font })
      lastPage.drawText(String(req.signer_email), { x: pw - 250, y: 67, size: 8, font })
      if (input.signerIp) {
        lastPage.drawText(`IP ${input.signerIp}`, { x: pw - 250, y: 56, size: 7, font, color: rgb(0.4, 0.4, 0.4) })
      }
      for (const page of pdf.getPages()) {
        const { width } = page.getSize()
        page.drawText(`Electronically signed via ${brand.name} — ${when}`, {
          x: 30, y: 20, size: 7, font, color: rgb(0.4, 0.4, 0.4),
        })
        page.drawText('Integrity verifiable against the signing request and audit register', {
          x: width - 300, y: 20, size: 7, font, color: rgb(0.4, 0.4, 0.4),
        })
      }
      signedBytes = Buffer.from(await pdf.save())
    } catch (e) {
      throw new OperationRefused(
        'signature_stamp_failed',
        `the signature could not be stamped: ${String((e as Error).message ?? e).slice(0, 200)}`,
      )
    }

    const outName = `SIGNED-${String(req.filename).replace(/[^a-zA-Z0-9 ._-]/g, '_')}`
    const stored = await store({ matter: req.matter as number, filename: outName, bytes: signedBytes })
    const created = await createDocumentWithFileInTx(tx, door, {
      matter: req.matter as number,
      folder: (req.folder as number | null) ?? null,
      filename: outName,
      contentType: 'application/pdf',
      sizeBytes: signedBytes.length,
      storageRef: stored.storageRef,
      source: 'signing',
      title: `SIGNED — ${req.title}`,
      description: `Signed by ${req.signer_name} <${req.signer_email}>`,
      createdBy: req.created_by as number,
    })
    await tx.query(
      `update deedbox.document_signing_request
          set status = 'signed', signed_at = now(), signature_data = $2,
              signer_ip = $3, signer_user_agent = $4, signed_document = $5
        where id = $1`,
      [req.id, input.signatureDataUrl, input.signerIp ?? null, input.signerUserAgent ?? null, created.document],
    )
    await tx.query(
      `insert into deedbox.document_access (document, version, actor_kind, actor, action, detail)
       values ($1, $2, 'signer', $3, 'viewed', $4)`,
      [req.document, req.version, req.id, JSON.stringify({ act: 'signed' })],
    )
    await emitRegister(tx, door, {
      kind: 'record.changed',
      subjectType: 'document_signing_request',
      subject: req.id as number,
      detail: {
        before: { status: 'pending' },
        after: { status: 'signed', signed_document: created.document, signer_ip: input.signerIp ?? null },
      },
    })
    return { signedDocument: created.document }
  })
}

