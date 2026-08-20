// The document download door: the signed-in principal's predicate governs
// (the matter join serves nothing on invisible matters), the requested
// version's bytes come back through the byte-fetch seam, and every
// download lands on the access evidence log before the bytes leave.
// ?version=N downloads a specific version; default is the current one.

import { requirePrincipal } from '@/lib/auth'
import { withPrincipal } from '@/lib/db'
import { requireByteFetch, recordDocumentAccess } from '@/lib/ops/documents'
import type { DocumentByteFetch } from '@/lib/ops/documents'

export async function GET(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  const p = await requirePrincipal()
  const { id } = await params
  const documentId = Number(id)
  const url = new URL(req.url)
  const versionParam = url.searchParams.get('version')

  let fetchSeam: DocumentByteFetch
  try {
    fetchSeam = requireByteFetch()
  } catch {
    return new Response('document storage is not bound on this installation', { status: 503 })
  }

  const located = await withPrincipal(
    p,
    async (tx) => {
      const d = await tx.query(
        `select d.id, d.current_version
           from deedbox.document d
           join deedbox.matter m on m.id = d.matter
          where d.id = $1 and d.soft_deleted_at is null`,
        [documentId],
      )
      if (d.rowCount === 0) return null
      const versionNo = versionParam ? Number(versionParam) : (d.rows[0].current_version as number)
      const v = await tx.query(
        `select v.id as version_id, df.filename, df.content_type, df.storage_ref
           from deedbox.document_version v
           join deedbox.document_file df on df.id = v.file
          where v.document = $1 and v.version_no = $2`,
        [documentId, versionNo],
      )
      if (v.rowCount === 0) return null
      return {
        versionId: v.rows[0].version_id as number,
        filename: v.rows[0].filename as string,
        contentType: v.rows[0].content_type as string,
        storageRef: v.rows[0].storage_ref as string,
      }
    },
    { readOnly: true },
  )
  if (!located) return new Response('not found', { status: 404 })

  const fetched = await fetchSeam(located.storageRef)
  await recordDocumentAccess(p, {
    document: documentId,
    version: located.versionId,
    action: 'downloaded',
  })
  const safe = located.filename.replace(/["\r\n]/g, '_')
  return new Response(new Uint8Array(fetched.bytes), {
    headers: {
      'Content-Type': located.contentType,
      'Content-Disposition': `attachment; filename="${safe}"`,
    },
  })
}
