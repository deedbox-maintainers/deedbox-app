// Documents module — the document lifecycle over 0030: upload (bytes-first
// through the byte-store seam, then head + version + landing rows in one
// transaction), dense version adds under the checkout discipline, filing an
// intake-landed arrival into a head, metadata edits (corpus re-registered),
// checkout/checkin, the admin lock, legal hold, soft delete and restore,
// and the access evidence writer. The schema enforces the discipline
// (density, exclusivity, locked, hold, closed-matter ceremony); these
// operations sequence, refuse typed BEFORE bytes move, and register.

import type { Principal, Tx } from '@/lib/db'
import { withPrincipal, emitRegister, OperationRefused } from '@/lib/db'
import { requireStaff, requireCapability, settingText } from '@/lib/ops/shared'
import { requireByteStore } from './store'
import { extractText, EXTRACT_CAP } from './extract'

interface Head {
  id: number
  matter: number
  matter_status: string
  folder: number | null
  title: string
  description: string | null
  document_date: string | null
  confidential: boolean
  current_file: number
  current_version: number
  checked_out_by: number | null
  checkout_purpose: string | null
  locked: boolean
  legal_hold: boolean
  soft_deleted_at: string | null
}

async function loadHead(tx: Tx, id: number): Promise<Head> {
  const r = await tx.query(
    `select d.id, d.matter, m.status as matter_status, d.folder, d.title, d.description,
            d.document_date, d.confidential, d.current_file, d.current_version,
            d.checked_out_by, d.checkout_purpose, d.locked, d.legal_hold, d.soft_deleted_at
       from deedbox.document d
       join deedbox.matter m on m.id = d.matter
      where d.id = $1`,
    [id],
  )
  if (r.rowCount === 0) throw new OperationRefused('not_found', 'no document by that id')
  return r.rows[0] as Head
}

function refuseClosed(status: string): void {
  if (status === 'closed' || status === 'archived') {
    throw new OperationRefused('matter_closed', 'the matter is closed — documents are read-only')
  }
}

/**
 * One home for the document's searchable text: the corpus row (conflict
 * checks) and the search-index row (the search page) are rebuilt from
 * the head's current state — title + description + the current version's
 * extracted text.
 */
export async function syncDocumentText(tx: Tx, documentId: number): Promise<void> {
  const d = await tx.query(
    `select d.id, d.matter, d.title, d.description, d.soft_deleted_at,
            coalesce(t.content, '') as text
       from deedbox.document d
       left join deedbox.document_version v
         on v.document = d.id and v.version_no = d.current_version
       left join deedbox.document_version_text t on t.version = v.id
      where d.id = $1`,
    [documentId],
  )
  if (d.rowCount === 0) return
  const row = d.rows[0]
  if (row.soft_deleted_at) {
    await tx.query(`select deedbox.corpus_withdraw('documents','external_document',$1)`, [
      String(documentId),
    ])
    await tx.query(`delete from deedbox.search_index where entry_type = 'document' and source = $1`, [
      documentId,
    ])
    return
  }
  const content = [row.title, row.description ?? '', row.text]
    .filter(Boolean)
    .join(' ')
    .slice(0, 200_000)
  await tx.query(`select deedbox.corpus_upsert('documents','external_document',$1,$2,$3,null)`, [
    String(documentId),
    content,
    row.matter,
  ])
  await tx.query(
    `insert into deedbox.search_index (entry_type, source, matter, display_title, body)
     values ('document', $1, $2, $3, $4)
     on conflict (entry_type, source) do update
       set matter = excluded.matter, display_title = excluded.display_title,
           body = excluded.body, updated_at = now()`,
    [documentId, row.matter, row.title, (row.text as string).slice(0, 200_000)],
  )
}

/** Store one version's extracted text (insert or re-extract) and re-sync. */
export async function writeVersionTextInTx(
  tx: Tx,
  versionId: number,
  documentId: number,
  extracted: { content: string; method: 'embedded' | 'none' | 'ocr' },
): Promise<void> {
  await tx.query(
    `insert into deedbox.document_version_text (version, content, method, char_count)
     values ($1, $2, $3, $4)
     on conflict (version) do update
       set content = excluded.content, method = excluded.method, char_count = excluded.char_count`,
    [versionId, extracted.content, extracted.method, extracted.content.length],
  )
  await syncDocumentText(tx, documentId)
}

// ---------------------------------------------------------------------------
// Upload and versions.
// ---------------------------------------------------------------------------

/**
 * The shared creation core: landing row + head + version 1 + corpus +
 * register, in the CALLER's transaction. Bytes must already be stored.
 * Used by staff uploads (source staff_upload) and template generation
 * (source template_generation).
 */
export async function createDocumentWithFileInTx(
  tx: Tx,
  p: Principal,
  input: {
    matter: number
    folder?: number | null
    filename: string
    contentType: string
    sizeBytes: number
    storageRef: string
    source: 'staff_upload' | 'template_generation' | 'signing' | 'import' | 'outbound_despatch'
    title?: string
    description?: string | null
    documentDate?: string | null
    confidential?: boolean
    comment?: string | null
    /** The staff member the rows are attributed to; defaults to the principal
     *  (the signing door acts as system 22 but attributes to the requester). */
    createdBy?: number
    /** Extracted text when the caller had the bytes in hand. */
    extracted?: { content: string; method: 'embedded' | 'none' }
    /** Historical timestamps for the import path: when the source system says
     *  the file arrived / the record was made. Absent = now. */
    uploadedAt?: string
    createdAt?: string
    /** The import batch this creation belongs to — stamped into the register
     *  event so the repeat-safety exam knows an import wrote it. */
    importBatch?: number
    /** Machine provenance key (e.g. the despatch that produced this copy) —
     *  the caller's idempotency handle; a person's upload carries none. */
    externalRef?: string
  },
): Promise<{ document: number; file: number }> {
  const by = input.createdBy ?? p.id
  const file = await tx.query(
    `insert into deedbox.document_file
       (matter, filename, content_type, size_bytes, storage_ref, source, uploaded_by, uploaded_at, external_ref)
     values ($1, $2, $3, $4, $5, $6, $7, coalesce($8::timestamptz, now()), $9) returning id`,
    [
      input.matter,
      input.filename,
      input.contentType,
      input.sizeBytes,
      input.storageRef,
      input.source,
      by,
      input.uploadedAt ?? null,
      input.externalRef ?? null,
    ],
  )
  const fileId = file.rows[0].id as number
  const title = (input.title ?? input.filename).trim()
  const head = await tx.query(
    `insert into deedbox.document
       (matter, folder, title, description, document_date, confidential, current_file, current_version, created_by, created_at)
     values ($1, $2, $3, $4, $5, $6, $7, 1, $8, coalesce($9::timestamptz, now())) returning id`,
    [
      input.matter,
      input.folder ?? null,
      title,
      input.description ?? null,
      input.documentDate ?? null,
      input.confidential ?? false,
      fileId,
      by,
      input.createdAt ?? null,
    ],
  )
  const docId = head.rows[0].id as number
  const version = await tx.query(
    `insert into deedbox.document_version (document, version_no, file, comment, created_by, created_at)
     values ($1, 1, $2, $3, $4, coalesce($5::timestamptz, now())) returning id`,
    [docId, fileId, input.comment ?? null, by, input.createdAt ?? input.uploadedAt ?? null],
  )
  if (input.extracted) {
    await writeVersionTextInTx(tx, version.rows[0].id as number, docId, input.extracted)
  } else {
    await syncDocumentText(tx, docId)
  }
  await emitRegister(tx, p, {
    kind: 'record.created',
    subjectType: 'document',
    subject: docId,
    detail: {
      matter: input.matter,
      folder: input.folder ?? null,
      title,
      filename: input.filename,
      file: fileId,
      source: input.source,
      ...(input.importBatch !== undefined ? { import_batch: input.importBatch } : {}),
    },
  })
  return { document: docId, file: fileId }
}

export async function uploadDocument(
  p: Principal,
  input: {
    matter: number
    folder?: number | null
    filename: string
    bytes: Buffer
    title?: string
    description?: string
    documentDate?: string
    confidential?: boolean
    comment?: string
  },
): Promise<{ document: number; file: number }> {
  requireStaff(p)
  const store = requireByteStore()
  return withPrincipal(p, async (tx) => {
    const m = await tx.query(`select status from deedbox.matter where id = $1`, [input.matter])
    if (m.rowCount === 0) throw new OperationRefused('not_found', 'no matter by that id')
    refuseClosed(m.rows[0].status as string)
    const stored = await store({ matter: input.matter, filename: input.filename, bytes: input.bytes })
    const extracted = await extractText(input.bytes, input.filename, stored.contentType)
    return createDocumentWithFileInTx(tx, p, {
      matter: input.matter,
      folder: input.folder ?? null,
      filename: input.filename,
      contentType: stored.contentType,
      sizeBytes: input.bytes.length,
      storageRef: stored.storageRef,
      source: 'staff_upload',
      title: input.title,
      description: input.description ?? null,
      documentDate: input.documentDate ?? null,
      confidential: input.confidential ?? false,
      comment: input.comment ?? null,
      extracted,
    })
  })
}

export async function addDocumentVersion(
  p: Principal,
  input: { document: number; filename: string; bytes: Buffer; comment?: string },
): Promise<{ version: number; file: number }> {
  requireStaff(p)
  const store = requireByteStore()
  return withPrincipal(p, async (tx) => {
    const head = await loadHead(tx, input.document)
    refuseClosed(head.matter_status)
    if (head.soft_deleted_at) throw new OperationRefused('not_found', 'no document by that id')
    if (head.locked) throw new OperationRefused('document_locked', 'the document is locked')
    if (head.checked_out_by !== null && head.checked_out_by !== p.id) {
      throw new OperationRefused('checked_out_elsewhere', 'the document is checked out by someone else')
    }
    const stored = await store({ matter: head.matter, filename: input.filename, bytes: input.bytes })
    const file = await tx.query(
      `insert into deedbox.document_file
         (matter, filename, content_type, size_bytes, storage_ref, source, uploaded_by)
       values ($1, $2, $3, $4, $5, 'staff_upload', $6) returning id`,
      [head.matter, input.filename, stored.contentType, input.bytes.length, stored.storageRef, p.id],
    )
    const fileId = file.rows[0].id as number
    const nextVersion = head.current_version + 1
    const releasing = head.checked_out_by === p.id
    await tx.query(
      `update deedbox.document
          set current_file = $2, current_version = $3,
              checked_out_by = case when $4 then null else checked_out_by end,
              checked_out_at = case when $4 then null else checked_out_at end,
              checkout_purpose = case when $4 then null else checkout_purpose end
        where id = $1`,
      [input.document, fileId, nextVersion, releasing],
    )
    const newVersion = await tx.query(
      `insert into deedbox.document_version (document, version_no, file, comment, created_by)
       values ($1, $2, $3, $4, $5) returning id`,
      [input.document, nextVersion, fileId, input.comment ?? null, p.id],
    )
    await writeVersionTextInTx(
      tx,
      newVersion.rows[0].id as number,
      input.document,
      await extractText(input.bytes, input.filename, stored.contentType),
    )
    await tx.query(
      `insert into deedbox.activity_signal
         (source_module, signal_kind, source_ref, occurred_at, staff, matter_hint, detail)
       values ('documents', 'document_worked', $1, now(), $2, $3, $4)
       on conflict (source_module, source_ref) do nothing`,
      [
        `document:${input.document}:v${nextVersion}`,
        p.id,
        JSON.stringify({ matter: head.matter }),
        JSON.stringify({ document: input.document, version: nextVersion, filename: input.filename }),
      ],
    )
    await emitRegister(tx, p, {
      kind: 'record.changed',
      subjectType: 'document',
      subject: input.document,
      detail: {
        before: { current_version: head.current_version, current_file: head.current_file },
        after: { current_version: nextVersion, current_file: fileId, filename: input.filename, checkout_released: releasing },
      },
    })
    return { version: nextVersion, file: fileId }
  })
}

/** File an unfiled arrival (an 0028 landing row no version references). */
export async function fileArrival(
  p: Principal,
  input: { file: number; folder?: number | null; title?: string },
): Promise<{ document: number }> {
  requireStaff(p)
  return withPrincipal(p, async (tx) => {
    const f = await tx.query(
      `select df.id, df.matter, df.filename, m.status as matter_status
         from deedbox.document_file df
         join deedbox.matter m on m.id = df.matter
        where df.id = $1`,
      [input.file],
    )
    if (f.rowCount === 0) throw new OperationRefused('not_found', 'no stored file by that id')
    refuseClosed(f.rows[0].matter_status as string)
    const taken = await tx.query(`select 1 from deedbox.document_version where file = $1`, [input.file])
    if ((taken.rowCount ?? 0) > 0) {
      throw new OperationRefused('already_filed', 'that arrival already belongs to a document')
    }
    const title = (input.title ?? (f.rows[0].filename as string)).trim()
    const head = await tx.query(
      `insert into deedbox.document
         (matter, folder, title, current_file, current_version, created_by)
       values ($1, $2, $3, $4, 1, $5) returning id`,
      [f.rows[0].matter, input.folder ?? null, title, input.file, p.id],
    )
    const docId = head.rows[0].id as number
    await tx.query(
      `insert into deedbox.document_version (document, version_no, file, comment, created_by)
       values ($1, 1, $2, 'filed from arrivals', $3)`,
      [docId, input.file, p.id],
    )
    await syncDocumentText(tx, docId)
    await emitRegister(tx, p, {
      kind: 'record.created',
      subjectType: 'document',
      subject: docId,
      detail: { matter: f.rows[0].matter, file: input.file, title, filed_from_arrivals: true },
    })
    return { document: docId }
  })
}

/**
 * The browser OCR panel's write-back (schema change 0039): text
 * the reader's own browser recognised from a scanned current version lands
 * in the same derived-text home extraction fills, method 'ocr'. No
 * register entry — derived text, the extraction path's posture. Closed
 * matters refuse: read-only means the searchable text stands still too.
 */
export async function recordOcrText(
  p: Principal,
  input: { document: number; content: string },
): Promise<{ chars: number }> {
  requireStaff(p)
  const content = input.content.trim().slice(0, EXTRACT_CAP)
  if (!content) throw new OperationRefused('text_required', 'the recognition produced no text')
  return withPrincipal(p, async (tx) => {
    const head = await loadHead(tx, input.document)
    refuseClosed(head.matter_status)
    if (head.soft_deleted_at) throw new OperationRefused('not_found', 'no document by that id')
    const v = await tx.query(
      `select id from deedbox.document_version where document = $1 and version_no = $2`,
      [input.document, head.current_version],
    )
    await writeVersionTextInTx(tx, v.rows[0].id as number, input.document, {
      content,
      method: 'ocr',
    })
    return { chars: content.length }
  })
}

// ---------------------------------------------------------------------------
// Metadata, checkout, lock, hold.
// ---------------------------------------------------------------------------

export async function editDocument(
  p: Principal,
  input: {
    document: number
    title?: string
    description?: string | null
    documentDate?: string | null
    confidential?: boolean
    folder?: number | null
  },
): Promise<void> {
  requireStaff(p)
  await withPrincipal(p, async (tx) => {
    const head = await loadHead(tx, input.document)
    refuseClosed(head.matter_status)
    if (head.locked) throw new OperationRefused('document_locked', 'the document is locked')
    const title = input.title !== undefined ? input.title.trim() : head.title
    const description = input.description !== undefined ? input.description : head.description
    await tx.query(
      `update deedbox.document
          set title = $2, description = $3, document_date = $4, confidential = $5, folder = $6
        where id = $1`,
      [
        input.document,
        title,
        description,
        input.documentDate !== undefined ? input.documentDate : head.document_date,
        input.confidential !== undefined ? input.confidential : head.confidential,
        input.folder !== undefined ? input.folder : head.folder,
      ],
    )
    await syncDocumentText(tx, input.document)
    await emitRegister(tx, p, {
      kind: 'record.changed',
      subjectType: 'document',
      subject: input.document,
      detail: {
        before: { title: head.title, description: head.description, folder: head.folder },
        after: { title, description, folder: input.folder !== undefined ? input.folder : head.folder },
      },
    })
  })
}

export async function checkoutDocument(
  p: Principal,
  input: { document: number; purpose?: string },
): Promise<void> {
  requireStaff(p)
  await withPrincipal(p, async (tx) => {
    const head = await loadHead(tx, input.document)
    refuseClosed(head.matter_status)
    if (head.locked) throw new OperationRefused('document_locked', 'the document is locked')
    if (head.checked_out_by !== null && head.checked_out_by !== p.id) {
      throw new OperationRefused('checked_out_elsewhere', 'the document is checked out by someone else')
    }
    await tx.query(
      `update deedbox.document
          set checked_out_by = $2, checked_out_at = now(), checkout_purpose = $3
        where id = $1`,
      [input.document, p.id, input.purpose ?? null],
    )
    await emitRegister(tx, p, {
      kind: 'record.changed',
      subjectType: 'document',
      subject: input.document,
      detail: { before: { checked_out_by: head.checked_out_by }, after: { checked_out_by: p.id, purpose: input.purpose ?? null } },
    })
  })
}

/** Release a checkout without a new version — the holder, or documents.manage. */
export async function checkinDocument(p: Principal, input: { document: number }): Promise<void> {
  requireStaff(p)
  await withPrincipal(p, async (tx) => {
    const head = await loadHead(tx, input.document)
    if (head.checked_out_by === null) return
    if (head.checked_out_by !== p.id) await requireCapability(tx, p, 'documents.manage')
    await tx.query(
      `update deedbox.document
          set checked_out_by = null, checked_out_at = null, checkout_purpose = null
        where id = $1`,
      [input.document],
    )
    await emitRegister(tx, p, {
      kind: 'record.changed',
      subjectType: 'document',
      subject: input.document,
      detail: { before: { checked_out_by: head.checked_out_by }, after: { checked_out_by: null } },
    })
  })
}

export async function setDocumentLock(
  p: Principal,
  input: { document: number; locked: boolean },
): Promise<void> {
  requireStaff(p)
  await withPrincipal(p, async (tx) => {
    await requireCapability(tx, p, 'documents.manage')
    const head = await loadHead(tx, input.document)
    if (head.locked === input.locked) return
    await tx.query(`update deedbox.document set locked = $2 where id = $1`, [
      input.document,
      input.locked,
    ])
    await emitRegister(tx, p, {
      kind: 'record.changed',
      subjectType: 'document',
      subject: input.document,
      detail: { before: { locked: head.locked }, after: { locked: input.locked } },
    })
  })
}

export async function setLegalHold(
  p: Principal,
  input: { document: number; hold: boolean },
): Promise<void> {
  requireStaff(p)
  await withPrincipal(p, async (tx) => {
    await requireCapability(tx, p, 'documents.manage')
    const head = await loadHead(tx, input.document)
    if (head.legal_hold === input.hold) return
    await tx.query(`update deedbox.document set legal_hold = $2 where id = $1`, [
      input.document,
      input.hold,
    ])
    await emitRegister(tx, p, {
      kind: 'record.changed',
      subjectType: 'document',
      subject: input.document,
      detail: { before: { legal_hold: head.legal_hold }, after: { legal_hold: input.hold } },
    })
  })
}

// ---------------------------------------------------------------------------
// Soft delete, restore, access evidence.
// ---------------------------------------------------------------------------

export async function softDeleteDocument(p: Principal, input: { document: number }): Promise<void> {
  requireStaff(p)
  await withPrincipal(p, async (tx) => {
    const head = await loadHead(tx, input.document)
    refuseClosed(head.matter_status)
    if (head.soft_deleted_at) return
    if (head.legal_hold) {
      throw new OperationRefused('legal_hold', 'the document is under legal hold')
    }
    if (head.locked) throw new OperationRefused('document_locked', 'the document is locked')
    await tx.query(
      `update deedbox.document set soft_deleted_at = now(), soft_deleted_by = $2 where id = $1`,
      [input.document, p.id],
    )
    await syncDocumentText(tx, input.document)
    await emitRegister(tx, p, {
      kind: 'record.soft_deleted',
      subjectType: 'document',
      subject: input.document,
      detail: { matter: head.matter, title: head.title },
    })
  })
}

/** Dispatched from the generic restore: window-checked, corpus re-registered. */
export async function restoreDocument(p: Principal, input: { document: number }): Promise<void> {
  requireStaff(p)
  await withPrincipal(p, async (tx) => {
    await requireCapability(tx, p, 'deleted.restore')
    const head = await loadHead(tx, input.document)
    if (!head.soft_deleted_at) return
    const policy = await tx.query(
      `select restore_window_days from deedbox.deletion_policy where entity_type = 'document'`,
    )
    const fallback = Number((await settingText(tx, 'softdelete.retention_days')) ?? '90')
    const windowDays = (policy.rows[0]?.restore_window_days as number | null) ?? fallback
    const ageDays = (Date.now() - new Date(head.soft_deleted_at).getTime()) / 86_400_000
    if (ageDays > windowDays) {
      throw new OperationRefused(
        'restore_window_passed',
        `the restore window (${windowDays} days) has passed`,
      )
    }
    await tx.query(
      `update deedbox.document set soft_deleted_at = null, soft_deleted_by = null where id = $1`,
      [input.document],
    )
    await syncDocumentText(tx, input.document)
    await emitRegister(tx, p, {
      kind: 'record.restored',
      subjectType: 'document',
      subject: input.document,
      detail: { matter: head.matter, title: head.title },
    })
  })
}

/** Evidence of access — insert-only, deliberately off the hash chain. */
export async function recordDocumentAccess(
  p: Principal,
  input: {
    document: number
    version?: number | null
    action: 'viewed' | 'downloaded' | 'opened_in_word' | 'printed' | 'compared'
    detail?: Record<string, unknown>
  },
): Promise<void> {
  await withPrincipal(p, async (tx) => {
    await tx.query(
      `insert into deedbox.document_access (document, version, actor_kind, actor, action, detail)
       values ($1, $2, $3, $4, $5, $6)`,
      [
        input.document,
        input.version ?? null,
        p.kind,
        p.id,
        input.action,
        input.detail ? JSON.stringify(input.detail) : null,
      ],
    )
  })
}
