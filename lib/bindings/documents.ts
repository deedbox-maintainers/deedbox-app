// The intake document store binding: file bytes go to the hosted platform's
// object storage — the architecture keeps that service for exactly this —
// and the arrival is recorded in the core's landing table (0028), inside the
// SAME transaction as the matter bundle, so the all-or-nothing promise
// holds: a 201 never names a document that didn't land.
//
// Ordering, deliberately the door's own: bytes FIRST (an outside call),
// then the row in the caller's transaction. If the transaction later aborts,
// the uploaded object is an unreferenced orphan — invisible, harmless, and a
// replay uploads under a fresh path (recorded). The reverse order would let
// a committed row point at bytes that never landed, which is the lie the
// design forbids.
//
// Failure posture: this module throws PLAIN errors, never typed refusals.
// A typed refusal would become a documented rejection holding the
// idempotency slot forever; a transient storage failure must instead abort
// the whole call unrecorded so the caller's retry can succeed.

import { randomUUID } from 'node:crypto'
import type { IntakeDocumentStore } from '@/lib/ops/interface'
import type { DocumentByteStore, DocumentByteFetch } from '@/lib/ops/documents/store'

/** Injectable HTTP PUT so the suite proves the store without a network. */
export type HttpPut = (
  url: string,
  headers: Record<string, string>,
  body: Buffer,
) => Promise<{ status: number; text: string }>

// the hosted storage protocol creates objects with POST; x-upsert 'false'
// makes an existing path refuse rather than silently overwrite
const realPut: HttpPut = async (url, headers, body) => {
  const r = await fetch(url, { method: 'POST', headers, body: new Uint8Array(body) })
  return { status: r.status, text: await r.text().catch(() => '') }
}

export interface HostedDocumentStoreConfig {
  /** The hosted platform's base URL (objects live under /storage/v1). */
  url: string
  /** The platform's privileged key — server-side only. */
  serviceKey: string
  bucket?: string
  put?: HttpPut
}

/** The visible name survives on the row; the storage key gets a safe form. */
function safeStorageName(filename: string): string {
  return filename.replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 180)
}

const CONTENT_TYPES: Record<string, string> = {
  pdf: 'application/pdf',
  doc: 'application/msword',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  txt: 'text/plain',
  html: 'text/html',
  csv: 'text/csv',
  json: 'application/json',
  eml: 'message/rfc822',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  svg: 'image/svg+xml',
  webp: 'image/webp',
  ico: 'image/x-icon',
  tif: 'image/tiff',
  tiff: 'image/tiff',
  zip: 'application/zip',
}

function contentTypeFor(filename: string): string {
  const ext = filename.split('.').pop()?.toLowerCase() ?? ''
  return CONTENT_TYPES[ext] ?? 'application/octet-stream'
}

/**
 * The raw byte-putter for the documents module (staff uploads and
 * version adds): same service, same bytes-first ordering, no landing row —
 * the documents operations write their own rows in the caller's
 * transaction. Returns the storage reference and resolved content type.
 */
export function hostedByteStore(cfg: HostedDocumentStoreConfig): DocumentByteStore {
  const bucket = cfg.bucket ?? 'matter-documents'
  const put = cfg.put ?? realPut
  const base = cfg.url.replace(/\/+$/, '')
  return async (input) => {
    if (input.bytes.length === 0) {
      throw new Error('document is empty — nothing to store')
    }
    const contentType = contentTypeFor(input.filename)
    const prefix = input.matter ?? 'templates'
    const storageRef = `${prefix}/${randomUUID()}-${safeStorageName(input.filename)}`
    const r = await put(
      `${base}/storage/v1/object/${bucket}/${storageRef}`,
      {
        Authorization: `Bearer ${cfg.serviceKey}`,
        'Content-Type': contentType,
        'x-upsert': 'false',
      },
      input.bytes,
    )
    if (r.status < 200 || r.status >= 300) {
      throw new Error(`document_storage_error: HTTP ${r.status} ${r.text.slice(0, 160)}`)
    }
    return { storageRef, contentType }
  }
}

/** The read half: authenticated GET of a stored object's bytes. */
export function hostedByteFetch(cfg: HostedDocumentStoreConfig): DocumentByteFetch {
  const bucket = cfg.bucket ?? 'matter-documents'
  const base = cfg.url.replace(/\/+$/, '')
  return async (storageRef) => {
    const r = await fetch(`${base}/storage/v1/object/${bucket}/${storageRef}`, {
      headers: { Authorization: `Bearer ${cfg.serviceKey}` },
    })
    if (!r.ok) {
      throw new Error(`document_storage_error: HTTP ${r.status} fetching ${storageRef}`)
    }
    return {
      bytes: Buffer.from(await r.arrayBuffer()),
      contentType: r.headers.get('content-type') ?? 'application/octet-stream',
    }
  }
}

export function hostedDocumentStore(cfg: HostedDocumentStoreConfig): IntakeDocumentStore {
  const bucket = cfg.bucket ?? 'matter-documents'
  const put = cfg.put ?? realPut
  const base = cfg.url.replace(/\/+$/, '')
  return async (tx, input) => {
    if (input.bytes.length === 0) {
      throw new Error('document is empty — nothing to store')
    }
    const contentType = contentTypeFor(input.filename)
    const storageRef = `${input.matter}/${randomUUID()}-${safeStorageName(input.filename)}`
    const r = await put(
      `${base}/storage/v1/object/${bucket}/${storageRef}`,
      {
        Authorization: `Bearer ${cfg.serviceKey}`,
        'Content-Type': contentType,
        'x-upsert': 'false',
      },
      input.bytes,
    )
    if (r.status < 200 || r.status >= 300) {
      throw new Error(`document_storage_error: HTTP ${r.status} ${r.text.slice(0, 160)}`)
    }
    const row = await tx.query(
      `insert into deedbox.document_file
         (matter, filename, content_type, size_bytes, storage_ref, source, integration_key, external_ref)
       values ($1, $2, $3, $4, $5, 'intake_api', $6, $7)
       returning id`,
      [
        input.matter,
        input.filename,
        contentType,
        input.bytes.length,
        storageRef,
        input.integrationKey,
        input.externalRef,
      ],
    )
    return row.rows[0].id as number
  }
}
