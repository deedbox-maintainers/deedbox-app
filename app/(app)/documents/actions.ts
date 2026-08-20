'use server'

// Documents-area server actions: thin parsers over the documents
// operations. Uploads read the browser file into a buffer here — bytes go
// to the store inside the operation, bytes-first, rows in the same
// transaction.

import { act } from '@/lib/screens/action'
import { parse } from '@/components/forms'
import {
  uploadDocument,
  addDocumentVersion,
  fileArrival,
  editDocument,
  checkoutDocument,
  checkinDocument,
  setDocumentLock,
  setLegalHold,
  softDeleteDocument,
  createFolder,
  renameFolder,
  deleteEmptyFolder,
  uploadDocumentTemplate,
  editDocumentTemplate,
  softDeleteDocumentTemplate,
  generateFromTemplate,
  createDocumentShare,
  revokeDocumentShare,
  createSigningRequest,
  revokeSigningRequest,
} from '@/lib/ops/documents'
import { restoreSoftDeleted } from '@/lib/ops/security/restore'

async function fileBuffer(formData: FormData): Promise<{ filename: string; bytes: Buffer }> {
  const f = formData.get('file')
  if (!(f instanceof File) || f.size === 0) throw new Error('choose a file')
  return { filename: f.name, bytes: Buffer.from(await f.arrayBuffer()) }
}

export async function uploadDocumentAction(formData: FormData): Promise<void> {
  const matter = parse.num(formData, 'matter')
  await act(`/matters/${matter}/documents`, async (p) => {
    // multi-select: shared folder/description/confidentiality per batch, one
    // transactional upload per file, per-file failures collected honestly
    const files = formData.getAll('file').filter((f): f is File => f instanceof File && f.size > 0)
    if (files.length === 0) throw new Error('choose at least one file')
    const failures: string[] = []
    let uploaded = 0
    for (const f of files) {
      try {
        await uploadDocument(p, {
          matter,
          folder: parse.numOrNull(formData, 'folder'),
          filename: f.name,
          bytes: Buffer.from(await f.arrayBuffer()),
          title: files.length === 1 ? ((formData.get('title') as string) || undefined) : undefined,
          description: (formData.get('description') as string) || undefined,
          confidential: formData.get('confidential') === 'on',
        })
        uploaded++
      } catch (e) {
        failures.push(`${f.name}: ${e instanceof Error ? e.message : String(e)}`)
      }
    }
    if (failures.length > 0) {
      throw new Error(
        `${uploaded} of ${files.length} uploaded — failed: ${failures.join(' · ')}`,
      )
    }
    return files.length === 1 ? undefined : `${uploaded} documents uploaded.`
  })
}

export async function addVersionAction(formData: FormData): Promise<void> {
  const document = parse.num(formData, 'document')
  await act(`/documents/${document}`, async (p) => {
    const { filename, bytes } = await fileBuffer(formData)
    await addDocumentVersion(p, {
      document,
      filename,
      bytes,
      comment: (formData.get('comment') as string) || undefined,
    })
  })
}

export async function fileArrivalAction(formData: FormData): Promise<void> {
  const matter = parse.num(formData, 'matter')
  await act(`/matters/${matter}/documents`, async (p) => {
    await fileArrival(p, {
      file: parse.num(formData, 'file'),
      title: (formData.get('title') as string) || undefined,
    })
  })
}

export async function editDocumentAction(formData: FormData): Promise<void> {
  const document = parse.num(formData, 'document')
  await act(`/documents/${document}`, async (p) => {
    await editDocument(p, {
      document,
      title: parse.str(formData, 'title'),
      description: (formData.get('description') as string) || null,
      documentDate: (formData.get('document_date') as string) || null,
      confidential: formData.get('confidential') === 'on',
    })
  })
}

export async function checkoutDocumentAction(formData: FormData): Promise<void> {
  const document = parse.num(formData, 'document')
  await act(`/documents/${document}`, async (p) => {
    await checkoutDocument(p, {
      document,
      purpose: (formData.get('purpose') as string) || undefined,
    })
  })
}

export async function checkinDocumentAction(formData: FormData): Promise<void> {
  const document = parse.num(formData, 'document')
  await act(`/documents/${document}`, async (p) => {
    await checkinDocument(p, { document })
  })
}

export async function setDocumentLockAction(formData: FormData): Promise<void> {
  const document = parse.num(formData, 'document')
  await act(`/documents/${document}`, async (p) => {
    await setDocumentLock(p, { document, locked: formData.get('locked') === 'true' })
  })
}

export async function setLegalHoldAction(formData: FormData): Promise<void> {
  const document = parse.num(formData, 'document')
  await act(`/documents/${document}`, async (p) => {
    await setLegalHold(p, { document, hold: formData.get('hold') === 'true' })
  })
}

export async function softDeleteDocumentAction(formData: FormData): Promise<void> {
  const document = parse.num(formData, 'document')
  const matter = parse.num(formData, 'matter')
  await act(`/matters/${matter}/documents`, async (p) => {
    await softDeleteDocument(p, { document })
  })
}

export async function restoreDocumentAction(formData: FormData): Promise<void> {
  const document = parse.num(formData, 'document')
  await act(`/documents/${document}`, async (p) => {
    await restoreSoftDeleted(p, { entityType: 'document', id: document })
  })
}

export async function createFolderAction(formData: FormData): Promise<void> {
  const matter = parse.num(formData, 'matter')
  await act(`/matters/${matter}/documents`, async (p) => {
    await createFolder(p, {
      matter,
      parent: parse.numOrNull(formData, 'parent'),
      name: parse.str(formData, 'name'),
    })
  })
}

export async function renameFolderAction(formData: FormData): Promise<void> {
  const matter = parse.num(formData, 'matter')
  await act(`/matters/${matter}/documents`, async (p) => {
    await renameFolder(p, { folder: parse.num(formData, 'folder'), name: parse.str(formData, 'name') })
  })
}

export async function deleteFolderAction(formData: FormData): Promise<void> {
  const matter = parse.num(formData, 'matter')
  await act(`/matters/${matter}/documents`, async (p) => {
    await deleteEmptyFolder(p, { folder: parse.num(formData, 'folder') })
  })
}

// --- document templates ---

export async function uploadDocumentTemplateAction(formData: FormData): Promise<void> {
  await act('/settings/document-templates', async (p) => {
    const { filename, bytes } = await fileBuffer(formData)
    await uploadDocumentTemplate(p, {
      name: parse.str(formData, 'name'),
      filename,
      bytes,
      category: (formData.get('category') as string) || undefined,
      description: (formData.get('description') as string) || undefined,
      practiceArea: parse.numOrNull(formData, 'practice_area'),
      jurisdiction: (formData.get('jurisdiction') as string) || null,
    })
  })
}

export async function setTemplateActiveAction(formData: FormData): Promise<void> {
  await act('/settings/document-templates', async (p) => {
    await editDocumentTemplate(p, {
      template: parse.num(formData, 'template'),
      active: formData.get('active') === 'true',
    })
  })
}

export async function editDocumentTemplateAction(formData: FormData): Promise<void> {
  await act('/settings/document-templates', async (p) => {
    await editDocumentTemplate(p, {
      template: parse.num(formData, 'template'),
      name: parse.str(formData, 'name'),
      category: (formData.get('category') as string) || 'General',
      description: (formData.get('description') as string) || null,
      jurisdiction: (formData.get('jurisdiction') as string) || null,
    })
  })
}

export async function deleteDocumentTemplateAction(formData: FormData): Promise<void> {
  await act('/settings/document-templates', async (p) => {
    await softDeleteDocumentTemplate(p, { template: parse.num(formData, 'template') })
  })
}

export async function generateFromTemplateAction(formData: FormData): Promise<void> {
  const matter = parse.num(formData, 'matter')
  await act(`/matters/${matter}/documents`, async (p) => {
    const r = await generateFromTemplate(p, {
      template: parse.num(formData, 'template'),
      matter,
    })
    return `goto:/documents/${r.document}`
  })
}

// --- sharing + e-signature ---

async function appOrigin(): Promise<string> {
  const { headers } = await import('next/headers')
  const h = await headers()
  const proto = h.get('x-forwarded-proto') ?? 'https'
  const host = h.get('x-forwarded-host') ?? h.get('host') ?? ''
  return host ? `${proto}://${host}` : ''
}

export async function createShareAction(formData: FormData): Promise<void> {
  const document = parse.num(formData, 'document')
  await act(`/documents/${document}`, async (p) => {
    const r = await createDocumentShare(p, {
      document,
      recipientName: (formData.get('recipient_name') as string) || undefined,
      recipientEmail: (formData.get('recipient_email') as string) || undefined,
      expiresDays: parse.numOrNull(formData, 'expires_days') ?? undefined,
      maxViews: parse.numOrNull(formData, 'max_views'),
      password: (formData.get('password') as string) || undefined,
      allowDownload: formData.get('allow_download') !== null ? formData.get('allow_download') === 'on' : true,
      watermark: formData.get('watermark') !== null ? formData.get('watermark') === 'on' : true,
    })
    const origin = await appOrigin()
    return `Share link created. COPY IT NOW — it is shown once and never again: ${origin}/share/${r.token}`
  })
}

export async function revokeShareAction(formData: FormData): Promise<void> {
  const document = parse.num(formData, 'document')
  await act(`/documents/${document}`, async (p) => {
    await revokeDocumentShare(p, { share: parse.num(formData, 'share') })
    return 'Share revoked — the very next visit with that link is refused.'
  })
}

export async function createSigningRequestAction(formData: FormData): Promise<void> {
  const document = parse.num(formData, 'document')
  await act(`/documents/${document}`, async (p) => {
    const r = await createSigningRequest(p, {
      document,
      signerName: parse.str(formData, 'signer_name'),
      signerEmail: parse.str(formData, 'signer_email'),
      expiresDays: parse.numOrNull(formData, 'expires_days') ?? undefined,
    })
    const origin = await appOrigin()
    return `Signing link created for ${parse.str(formData, 'signer_name')}. COPY IT NOW — shown once: ${origin}/sign/${r.token}`
  })
}

export async function revokeSigningRequestAction(formData: FormData): Promise<void> {
  const document = parse.num(formData, 'document')
  await act(`/documents/${document}`, async (p) => {
    await revokeSigningRequest(p, { request: parse.num(formData, 'request') })
    return 'Signing request revoked.'
  })
}

/** The OCR panel's write-back: value-returning (the panel shows progress
 * and errors in place), never a redirect. */
export async function recordOcrTextAction(
  documentId: number,
  content: string,
): Promise<{ ok: true; chars: number } | { ok: false; error: string }> {
  try {
    const { requirePrincipal } = await import('@/lib/auth')
    const { recordOcrText } = await import('@/lib/ops/documents')
    const p = await requirePrincipal()
    const r = await recordOcrText(p, { document: documentId, content })
    return { ok: true, chars: r.chars }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) }
  }
}
