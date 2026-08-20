// The WebDAV door: lets desktop Word/Excel/PowerPoint open a document
// straight from the app via ms-word:ofe|u|<url> — edit, save, and the save
// lands as a new version through the ordinary version-add discipline
// (checkout released on save, extraction re-run, register written). The
// signed token IS the authority: bound to one (document, staff) pair,
// four-hour life, and every verb re-resolves that staff member's own
// visibility through the predicate before bytes move.
//
// Verbs: OPTIONS, HEAD, GET, PROPFIND, PUT, LOCK, UNLOCK. LOCK rides the
// document checkout; UNLOCK checks in without a version; PUT adds the
// version (which releases the caller's own checkout). The display filename
// in the URL exists so Office names the local file sensibly — the document
// id comes from the token alone.

import type { Principal } from '@/lib/db'
import { withPrincipal, OperationRefused } from '@/lib/db'
import {
  requireByteFetch,
  recordDocumentAccess,
  addDocumentVersion,
  checkoutDocument,
  checkinDocument,
} from '@/lib/ops/documents'
import { verifyDavToken, davSecret } from '@/lib/ops/documents/dav'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const DAV_HEADERS = {
  DAV: '1,2',
  'MS-Author-Via': 'DAV',
  Allow: 'OPTIONS, HEAD, GET, PUT, PROPFIND, LOCK, UNLOCK',
  Public: 'OPTIONS, HEAD, GET, PUT, PROPFIND, LOCK, UNLOCK',
}

type Params = Promise<{ token: string; path: string[] }>

interface Located {
  p: Principal
  doc: {
    id: number
    versionId: number
    versionNo: number
    filename: string
    contentType: string
    sizeBytes: number
    storageRef: string
    modifiedAt: string
    checkedOutBy: number | null
    locked: boolean
  }
}

async function authed(params: Params): Promise<Located | Response> {
  const secret = davSecret()
  if (!secret) return new Response('WebDAV is not configured', { status: 503, headers: DAV_HEADERS })
  const { token } = await params
  const payload = verifyDavToken(token, secret)
  if (!payload) return new Response('Unauthorized', { status: 401, headers: DAV_HEADERS })
  const p: Principal = { kind: 'staff', id: payload.uid, firm: payload.firm }
  const located = await withPrincipal(
    p,
    async (tx) => {
      const r = await tx.query(
        `select d.id, d.checked_out_by, d.locked, v.id as version_id, v.version_no,
                v.created_at, df.filename, df.content_type, df.size_bytes, df.storage_ref
           from deedbox.document d
           join deedbox.document_version v on v.document = d.id and v.version_no = d.current_version
           join deedbox.document_file df on df.id = v.file
          where d.id = $1 and d.soft_deleted_at is null`,
        [payload.doc],
      )
      if (r.rowCount === 0) return null
      const row = r.rows[0]
      return {
        id: row.id as number,
        versionId: row.version_id as number,
        versionNo: row.version_no as number,
        filename: row.filename as string,
        contentType: (row.content_type as string | null) ?? 'application/octet-stream',
        sizeBytes: Number(row.size_bytes),
        storageRef: row.storage_ref as string,
        modifiedAt: String(row.created_at),
        checkedOutBy: row.checked_out_by as number | null,
        locked: row.locked as boolean,
      }
    },
    { readOnly: true },
  )
  if (!located) return new Response('Not Found', { status: 404, headers: DAV_HEADERS })
  return { p, doc: located }
}

function refusalStatus(e: unknown): Response | null {
  if (e instanceof OperationRefused) {
    const code = e.code
    if (code === 'checked_out_elsewhere' || code === 'document_locked' || code === 'matter_closed') {
      return new Response(e.message, { status: 423, headers: DAV_HEADERS })
    }
    if (code === 'not_found') return new Response('Not Found', { status: 404, headers: DAV_HEADERS })
    return new Response(e.message, { status: 409, headers: DAV_HEADERS })
  }
  return null
}

function encodeXml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' }[c] ?? c))
}

// ─── OPTIONS ────────────────────────────────────────────────────────────
export async function OPTIONS() {
  return new Response(null, { status: 200, headers: DAV_HEADERS })
}

// ─── HEAD ───────────────────────────────────────────────────────────────
export async function HEAD(_req: Request, { params }: { params: Params }) {
  const ctx = await authed(params)
  if (ctx instanceof Response) return ctx
  const { doc } = ctx
  return new Response(null, {
    status: 200,
    headers: {
      ...DAV_HEADERS,
      'Content-Type': doc.contentType,
      'Content-Length': String(doc.sizeBytes),
      'Last-Modified': new Date(doc.modifiedAt).toUTCString(),
      ETag: `"v${doc.versionNo}-${doc.id}"`,
    },
  })
}

// ─── GET ────────────────────────────────────────────────────────────────
export async function GET(_req: Request, { params }: { params: Params }) {
  const ctx = await authed(params)
  if (ctx instanceof Response) return ctx
  const { p, doc } = ctx
  let fetched: { bytes: Buffer }
  try {
    fetched = await requireByteFetch()(doc.storageRef)
  } catch {
    return new Response('document storage is not bound', { status: 503, headers: DAV_HEADERS })
  }
  await recordDocumentAccess(p, { document: doc.id, version: doc.versionId, action: 'opened_in_word' })
  return new Response(new Uint8Array(fetched.bytes), {
    status: 200,
    headers: {
      ...DAV_HEADERS,
      'Content-Type': doc.contentType,
      'Content-Length': String(fetched.bytes.length),
      'Last-Modified': new Date(doc.modifiedAt).toUTCString(),
      ETag: `"v${doc.versionNo}-${doc.id}"`,
      'Cache-Control': 'private, no-cache',
    },
  })
}

// ─── PROPFIND ───────────────────────────────────────────────────────────
export async function PROPFIND(_req: Request, { params }: { params: Params }) {
  const ctx = await authed(params)
  if (ctx instanceof Response) return ctx
  const { doc } = ctx
  const { token, path } = await params
  const href = `/api/dav/${token}/${(path ?? []).join('/')}`
  const xml = `<?xml version="1.0" encoding="utf-8"?>
<D:multistatus xmlns:D="DAV:">
  <D:response>
    <D:href>${encodeXml(href)}</D:href>
    <D:propstat>
      <D:prop>
        <D:displayname>${encodeXml(doc.filename)}</D:displayname>
        <D:resourcetype/>
        <D:getcontenttype>${encodeXml(doc.contentType)}</D:getcontenttype>
        <D:getcontentlength>${doc.sizeBytes}</D:getcontentlength>
        <D:creationdate>${new Date(doc.modifiedAt).toISOString()}</D:creationdate>
        <D:getlastmodified>${new Date(doc.modifiedAt).toUTCString()}</D:getlastmodified>
        <D:getetag>"v${doc.versionNo}-${doc.id}"</D:getetag>
        <D:supportedlock>
          <D:lockentry><D:lockscope><D:exclusive/></D:lockscope><D:locktype><D:write/></D:locktype></D:lockentry>
        </D:supportedlock>
      </D:prop>
      <D:status>HTTP/1.1 200 OK</D:status>
    </D:propstat>
  </D:response>
</D:multistatus>`
  return new Response(xml, {
    status: 207,
    headers: { ...DAV_HEADERS, 'Content-Type': 'application/xml; charset=utf-8' },
  })
}

// ─── PUT (save from Office → a new version) ─────────────────────────────
export async function PUT(req: Request, { params }: { params: Params }) {
  const ctx = await authed(params)
  if (ctx instanceof Response) return ctx
  const { p, doc } = ctx
  const body = Buffer.from(await req.arrayBuffer())
  if (body.length === 0) return new Response('Empty body', { status: 400, headers: DAV_HEADERS })
  try {
    const added = await addDocumentVersion(p, {
      document: doc.id,
      filename: doc.filename,
      bytes: body,
      comment: 'Saved from Office (WebDAV)',
    })
    return new Response(null, {
      status: 201,
      headers: { ...DAV_HEADERS, ETag: `"v${added.version}-${doc.id}"` },
    })
  } catch (e) {
    return refusalStatus(e) ?? new Response('Save failed', { status: 500, headers: DAV_HEADERS })
  }
}

// ─── LOCK (Office's edit lock → the document checkout) ──────────────────
export async function LOCK(_req: Request, { params }: { params: Params }) {
  const ctx = await authed(params)
  if (ctx instanceof Response) return ctx
  const { p, doc } = ctx
  if (doc.checkedOutBy === null || doc.checkedOutBy === p.id) {
    try {
      await checkoutDocument(p, { document: doc.id, purpose: 'Office edit-in-place (WebDAV)' })
    } catch (e) {
      const r = refusalStatus(e)
      if (r) return r
      return new Response('Checkout failed', { status: 500, headers: DAV_HEADERS })
    }
  } else {
    return new Response('Locked by another user', { status: 423, headers: DAV_HEADERS })
  }
  const { token, path } = await params
  const lockToken = `opaquelocktoken:${doc.id}-${p.id}`
  const xml = `<?xml version="1.0" encoding="utf-8"?>
<D:prop xmlns:D="DAV:">
  <D:lockdiscovery>
    <D:activelock>
      <D:locktype><D:write/></D:locktype>
      <D:lockscope><D:exclusive/></D:lockscope>
      <D:depth>0</D:depth>
      <D:owner><D:href>${encodeXml(String(p.id))}</D:href></D:owner>
      <D:timeout>Second-14400</D:timeout>
      <D:locktoken><D:href>${encodeXml(lockToken)}</D:href></D:locktoken>
      <D:lockroot><D:href>${encodeXml(`/api/dav/${token}/${(path ?? []).join('/')}`)}</D:href></D:lockroot>
    </D:activelock>
  </D:lockdiscovery>
</D:prop>`
  return new Response(xml, {
    status: 200,
    headers: { ...DAV_HEADERS, 'Content-Type': 'application/xml; charset=utf-8', 'Lock-Token': `<${lockToken}>` },
  })
}

// ─── UNLOCK (release without a save) ────────────────────────────────────
export async function UNLOCK(_req: Request, { params }: { params: Params }) {
  const ctx = await authed(params)
  if (ctx instanceof Response) return ctx
  const { p, doc } = ctx
  if (doc.checkedOutBy === p.id) {
    try {
      await checkinDocument(p, { document: doc.id })
    } catch {
      // releasing is best-effort from Office's side; the checkout screen remains
    }
  }
  return new Response(null, { status: 204, headers: DAV_HEADERS })
}
