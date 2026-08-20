// The record appliers the batch engine runs. One applier per record domain, used
// IDENTICALLY by validate-only and real batches (dispositions must be
// equal on the same file and state). Every write goes through the owning domain's
// path so every rule, mirror and index upsert fires; the source-reference discipline
// makes re-runs repeat-safe.
//
// Implementation notes:
//   * Shipped domains this increment: clients, matters, and the two money modes.
//     bills / time / other refuse loudly with an itemised message — they are
//     migration-workbook content, arriving with that later phase.
//   * "Touched since import": any register event on the target strictly after the
//     source-reference row's creation whose detail carries no import-batch marker.
//     Import-path updates stamp `import_batch` in their event detail; domain-core
//     creation events share the import transaction's frozen now() and are never
//     strictly after it. A later import's update is an import actor and does not
//     count as touched (the rule is "by a non-import actor").
//   * Client updates apply the name discipline (demote current, install new
//     current) and notes; contact points are not updated by re-runs (the source
//     file's contacts land at creation only).
//   * Imported matters satisfy the conflict gate externally: the source system's
//     own history is the gate's satisfaction, itemised on the batch report. Records
//     arriving with status closed close through the direct close path in the same
//     posture as any close.
//   * Money movements replay as native postings: receipts carry their own gapless
//     R- documents; historical payments post under one approved import authorisation
//     per batch — the ceremony documents belong to live operations, history is
//     evidence.

import type { Principal, Tx } from '@/lib/db'
import { emitRegister, OperationRefused } from '@/lib/db'
import { defaultTaxTreatment } from '@/lib/ops/shared'
import { checkDuplicatesInTx } from '@/lib/ops/matters/duplicates'
import { createMatterInTx } from '@/lib/ops/matters/createMatter'
import { closeMatterDirectInTx } from '@/lib/ops/matters/matterLifecycle'
import { ensureLedgerInTx } from '@/lib/ops/money/receipts'
import { createTimeEntryInTx } from '@/lib/ops/billing/timeEntries'
import { createDocumentWithFileInTx, writeVersionTextInTx } from '@/lib/ops/documents/documents'
import { createHash } from 'node:crypto'

export interface ImportContext {
  batchId: number
  sourceSystem: string
}

export interface RecordOutcome {
  sourceRef: string
  disposition: 'accepted' | 'accepted_with_warning' | 'refused' | 'updated'
  message?: string
  targetType?: string
  target?: number
}

/** The source-reference lookup: has this source line landed before? */
async function sourceHit(
  tx: Tx,
  sourceSystem: string,
  sourceRef: string,
  targetType: string,
): Promise<{ target: number; createdAt: string } | null> {
  const r = await tx.query(
    `select target, created_at::text as created_at from deedbox.source_reference
      where source_system = $1 and source_ref = $2 and target_type = $3`,
    [sourceSystem, sourceRef, targetType],
  )
  if (r.rowCount === 0) return null
  // created_at travels as postgres's OWN text rendering, microseconds intact:
  // a JS Date round-trip truncates to milliseconds, which made a record's
  // same-transaction birth events look strictly AFTER their source reference.
  return { target: r.rows[0].target as number, createdAt: r.rows[0].created_at as string }
}

async function recordSource(
  tx: Tx,
  ctx: ImportContext,
  sourceRef: string,
  targetType: string,
  target: number,
): Promise<void> {
  await tx.query(
    `insert into deedbox.source_reference (source_system, source_ref, target_type, target)
     values ($1, $2, $3, $4)`,
    [ctx.sourceSystem, sourceRef, targetType, target],
  )
}

/** The binding safety rule: touched by any non-import actor ⇒ never updated. */
export async function touchedSinceImport(
  tx: Tx,
  targetType: string,
  target: number,
  importedAt: string,
): Promise<boolean> {
  const r = await tx.query(
    `select exists (
       select 1 from deedbox.register_entry e
        where e.subject_type = $1 and e.subject = $2
          and e.occurred_at > $3::timestamptz
          and (e.detail ->> 'import_batch') is null
          and (e.detail ->> 'import_batch_reversal') is null
     ) as touched`,
    [targetType, target, importedAt],
  )
  return r.rows[0].touched as boolean
}

// ---------------------------------------------------------------------------

export interface ClientRecordData {
  kind?: 'person' | 'organisation'
  full_name: string
  notes?: string
  phone?: string
  email?: string
}

export async function applyClientRecord(
  tx: Tx,
  p: Principal,
  ctx: ImportContext,
  sourceRef: string,
  data: ClientRecordData,
): Promise<RecordOutcome> {
  const fullName = (data.full_name ?? '').trim()
  if (!fullName) {
    throw new OperationRefused('name_required', 'a client record needs full_name')
  }
  const hit = await sourceHit(tx, ctx.sourceSystem, sourceRef, 'party')
  if (hit) {
    if (await touchedSinceImport(tx, 'party', hit.target, hit.createdAt)) {
      return {
        sourceRef,
        disposition: 'accepted_with_warning',
        message: 'target changed since import; not updated',
      }
    }
    const cur = await tx.query(
      `select display_name, notes from deedbox.party where id = $1`,
      [hit.target],
    )
    const unchanged =
      cur.rows[0].display_name === fullName && (cur.rows[0].notes ?? null) === (data.notes ?? null)
    if (unchanged) {
      return {
        sourceRef,
        disposition: 'accepted_with_warning',
        message: 'already imported; no changes',
      }
    }
    if (cur.rows[0].display_name !== fullName) {
      await tx.query(
        `update deedbox.party_name set name_kind = 'former'
          where party = $1 and name_kind = 'current'`,
        [hit.target],
      )
      await tx.query(
        `insert into deedbox.party_name (party, name_kind, full_name) values ($1, 'current', $2)`,
        [hit.target, fullName],
      )
    }
    await tx.query(`update deedbox.party set display_name = $2, notes = $3 where id = $1`, [
      hit.target,
      fullName,
      data.notes ?? null,
    ])
    await emitRegister(tx, p, {
      kind: 'record.changed',
      subjectType: 'party',
      subject: hit.target,
      detail: {
        before: { display_name: cur.rows[0].display_name, notes: cur.rows[0].notes },
        after: { display_name: fullName, notes: data.notes ?? null },
        import_batch: ctx.batchId,
      },
    })
    return { sourceRef, disposition: 'updated', targetType: 'party', target: hit.target }
  }

  // create through the domain path; candidates are warnings, never blocks
  const candidates = await checkDuplicatesInTx(tx, {
    name: fullName,
    phone: data.phone,
    email: data.email,
  })
  const party = await tx.query(
    `insert into deedbox.party (kind, display_name, notes) values ($1, $2, $3) returning id`,
    [data.kind ?? 'person', fullName, data.notes ?? null],
  )
  const partyId = party.rows[0].id as number
  await tx.query(
    `insert into deedbox.party_name (party, name_kind, full_name) values ($1, 'current', $2)`,
    [partyId, fullName],
  )
  if (data.phone?.trim()) {
    await tx.query(
      `insert into deedbox.contact_point (party, kind, value, is_primary)
       values ($1, 'phone', $2, true)`,
      [partyId, data.phone.trim()],
    )
  }
  if (data.email?.trim()) {
    await tx.query(
      `insert into deedbox.contact_point (party, kind, value, is_primary)
       values ($1, 'email', $2, true)`,
      [partyId, data.email.trim()],
    )
  }
  await emitRegister(tx, p, {
    kind: 'record.created',
    subjectType: 'party',
    subject: partyId,
    detail: { display_name: fullName, import_batch: ctx.batchId },
  })
  await recordSource(tx, ctx, sourceRef, 'party', partyId)
  if (candidates.length > 0) {
    return {
      sourceRef,
      disposition: 'accepted_with_warning',
      message: `possible duplicates of existing parties: ${candidates.join(', ')}`,
      targetType: 'party',
      target: partyId,
    }
  }
  return { sourceRef, disposition: 'accepted', targetType: 'party', target: partyId }
}

// ---------------------------------------------------------------------------

export interface MatterRecordData {
  title: string
  client_source_ref?: string
  client_party?: number
  responsible_lawyer_login: string
  office_code: string
  practice_area_name: string
  opened_date?: string
  summary?: string
  status?: 'open' | 'closed'
  close_note?: string
  /** The matter's number in the source system — displayed on the matter,
   *  immutable once set (schema change 0043). */
  prior_reference?: string
}

export async function applyMatterRecord(
  tx: Tx,
  p: Principal,
  ctx: ImportContext,
  sourceRef: string,
  data: MatterRecordData,
): Promise<RecordOutcome> {
  const hit = await sourceHit(tx, ctx.sourceSystem, sourceRef, 'matter')
  if (hit) {
    if (await touchedSinceImport(tx, 'matter', hit.target, hit.createdAt)) {
      return {
        sourceRef,
        disposition: 'accepted_with_warning',
        message: 'target changed since import; not updated',
      }
    }
    const cur = await tx.query(`select title, summary from deedbox.matter where id = $1`, [hit.target])
    if (cur.rowCount === 0) {
      return {
        sourceRef,
        disposition: 'accepted_with_warning',
        message: 'imported matter not visible to the import actor; not updated',
      }
    }
    const unchanged =
      cur.rows[0].title === data.title.trim() && (cur.rows[0].summary ?? null) === (data.summary ?? null)
    if (unchanged) {
      return { sourceRef, disposition: 'accepted_with_warning', message: 'already imported; no changes' }
    }
    await tx.query(`update deedbox.matter set title = $2, summary = $3 where id = $1`, [
      hit.target,
      data.title.trim(),
      data.summary ?? null,
    ])
    await emitRegister(tx, p, {
      kind: 'record.changed',
      subjectType: 'matter',
      subject: hit.target,
      matter: hit.target,
      detail: {
        before: { title: cur.rows[0].title, summary: cur.rows[0].summary },
        after: { title: data.title.trim(), summary: data.summary ?? null },
        import_batch: ctx.batchId,
      },
    })
    return { sourceRef, disposition: 'updated', targetType: 'matter', target: hit.target }
  }

  let clientId: number
  if (data.client_party !== undefined) {
    clientId = data.client_party
  } else if (data.client_source_ref) {
    const c = await sourceHit(tx, ctx.sourceSystem, data.client_source_ref, 'party')
    if (!c) {
      throw new OperationRefused(
        'client_unresolved',
        `client source reference ${data.client_source_ref} has not been imported`,
      )
    }
    clientId = c.target
  } else {
    throw new OperationRefused('client_required', 'a matter record names its client')
  }
  const lawyer = await tx.query(
    `select id from deedbox.staff_member where login = $1 and active`,
    [data.responsible_lawyer_login],
  )
  if (lawyer.rowCount === 0) {
    throw new OperationRefused(
      'lawyer_unresolved',
      `no active staff member with login ${data.responsible_lawyer_login}`,
    )
  }
  const office = await tx.query(`select id from deedbox.office where code = $1`, [data.office_code])
  if (office.rowCount === 0) {
    throw new OperationRefused('office_unresolved', `no office with code ${data.office_code}`)
  }
  const area = await tx.query(
    `select id from deedbox.practice_area where name = $1 and active`,
    [data.practice_area_name],
  )
  if (area.rowCount === 0) {
    throw new OperationRefused(
      'area_unresolved',
      `no active practice area named ${data.practice_area_name}`,
    )
  }

  const created = await createMatterInTx(
    tx,
    p,
    {
      title: data.title,
      clientParty: clientId,
      responsibleLawyer: lawyer.rows[0].id as number,
      office: office.rows[0].id as number,
      practiceArea: area.rows[0].id as number,
      summary: data.summary,
      originNote: `imported from ${ctx.sourceSystem} (${sourceRef})`,
      openedDate: data.opened_date,
    },
    { conflictGateSatisfiedExternally: true },
  )
  // Stamp the prior-system reference BEFORE any close: a closed matter is
  // read-only by ceremony, and the stamp is part of the record's birth.
  if (data.prior_reference?.trim()) {
    await tx.query(`update deedbox.matter set prior_reference = $2 where id = $1`, [
      created.id,
      data.prior_reference.trim(),
    ])
  }
  if (data.status === 'closed') {
    await closeMatterDirectInTx(tx, p, {
      matter: created.id,
      note: data.close_note ?? `imported as closed from ${ctx.sourceSystem}`,
    })
  }
  await recordSource(tx, ctx, sourceRef, 'matter', created.id)
  return { sourceRef, disposition: 'accepted', targetType: 'matter', target: created.id }
}

// ---------------------------------------------------------------------------
// Documents and file notes — the archive's substance. Rows arrive through the
// owning domain's own creation paths, referencing bytes ALREADY COPIED
// bucket-to-bucket ahead of the import and verified there (these appliers
// never touch storage). Folders are records too, so an empty
// folder the firm navigated by survives the move.

/** The historical uploader / author, by login; absent = the import actor
 *  (documents) or honestly unknown (notes). Named-but-unresolvable refuses. */
async function resolveImportStaff(
  tx: Tx,
  p: Principal,
  sourceRef: string,
  login: string | undefined,
): Promise<number> {
  if (!login) return p.id
  const r = await tx.query(`select id from deedbox.staff_member where login = $1`, [login])
  if (r.rowCount === 0) {
    throw new OperationRefused('staff_unresolved', `${sourceRef}: no staff member with login ${login}`)
  }
  return r.rows[0].id as number
}

/** Resolve a '/'-separated folder path under a matter, creating what is
 *  missing. Idempotent by the (matter, parent, name) uniqueness; every
 *  creation registers, like every other write. */
async function ensureFolderPathInTx(
  tx: Tx,
  p: Principal,
  ctx: ImportContext,
  matter: number,
  path: string,
  createdBy: number,
): Promise<number> {
  const segments = path
    .split('/')
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
  if (segments.length === 0) {
    throw new OperationRefused('path_required', 'a folder path needs at least one segment')
  }
  let parent: number | null = null
  for (const name of segments) {
    const hit = await tx.query(
      `select id from deedbox.document_folder
        where matter = $1 and name = $2 and parent is not distinct from $3::bigint`,
      [matter, name, parent],
    )
    if ((hit.rowCount ?? 0) > 0) {
      parent = hit.rows[0].id as number
      continue
    }
    const made = await tx.query(
      `insert into deedbox.document_folder (matter, parent, name, created_by)
       values ($1, $2, $3, $4) returning id`,
      [matter, parent, name, createdBy],
    )
    parent = made.rows[0].id as number
    await emitRegister(tx, p, {
      kind: 'record.created',
      subjectType: 'document_folder',
      subject: parent,
      matter,
      detail: { name, import_batch: ctx.batchId },
    })
  }
  return parent!
}

export interface DocumentVersionData {
  filename: string
  content_type?: string
  size_bytes: number
  /** The object's key in THIS project's storage — the byte copy preserves keys. */
  storage_ref: string
  /** When the source system says this file arrived. */
  uploaded_at?: string
  comment?: string
  /** The source system's own extracted text for THIS version, when it had
   *  any — a source's existing extraction (including OCR work) is worth
   *  carrying. Absent = no text row, which leaves the version for the
   *  text sweep. */
  extracted_text?: string
}

export interface DocumentRecordData {
  record_kind: 'folder' | 'document'
  matter_source_ref?: string
  matter?: number
  /** folder records: the full path from the matter root, '/'-separated. */
  path?: string
  /** document records: */
  folder_path?: string
  title?: string
  description?: string
  document_date?: string
  confidential?: boolean
  created_by_login?: string
  created_at?: string
  /** Oldest first; the last is the current version. */
  versions?: DocumentVersionData[]
}

export async function applyDocumentRecord(
  tx: Tx,
  p: Principal,
  ctx: ImportContext,
  sourceRef: string,
  data: DocumentRecordData,
): Promise<RecordOutcome> {
  if (data.record_kind === 'folder') {
    const hit = await sourceHit(tx, ctx.sourceSystem, sourceRef, 'document_folder')
    if (hit) {
      return { sourceRef, disposition: 'accepted_with_warning', message: 'already imported; history never re-applies' }
    }
    if (!data.path?.trim()) {
      throw new OperationRefused('path_required', `${sourceRef}: a folder record names its path`)
    }
    const matter = await resolveRecordMatter(tx, ctx, data, sourceRef)
    const by = await resolveImportStaff(tx, p, sourceRef, data.created_by_login)
    const folder = await ensureFolderPathInTx(tx, p, ctx, matter, data.path, by)
    await recordSource(tx, ctx, sourceRef, 'document_folder', folder)
    return { sourceRef, disposition: 'accepted', targetType: 'document_folder', target: folder }
  }
  if (data.record_kind !== 'document') {
    throw new OperationRefused(
      'record_kind_unknown',
      `${sourceRef}: unknown documents-record kind ${String(data.record_kind)}`,
    )
  }
  const hit = await sourceHit(tx, ctx.sourceSystem, sourceRef, 'document')
  if (hit) {
    return { sourceRef, disposition: 'accepted_with_warning', message: 'already imported; history never re-applies' }
  }
  const versions = data.versions ?? []
  if (versions.length === 0) {
    throw new OperationRefused('versions_required', `${sourceRef}: a document record carries at least one version`)
  }
  const matter = await resolveRecordMatter(tx, ctx, data, sourceRef)
  const by = await resolveImportStaff(tx, p, sourceRef, data.created_by_login)
  const folder = data.folder_path?.trim()
    ? await ensureFolderPathInTx(tx, p, ctx, matter, data.folder_path, by)
    : null
  const first = versions[0]
  const created = await createDocumentWithFileInTx(tx, p, {
    matter,
    folder,
    filename: first.filename,
    contentType: first.content_type ?? 'application/octet-stream',
    sizeBytes: first.size_bytes,
    storageRef: first.storage_ref,
    source: 'import',
    title: data.title,
    description: data.description ?? null,
    documentDate: data.document_date ?? null,
    confidential: data.confidential ?? false,
    comment: first.comment ?? null,
    createdBy: by,
    uploadedAt: first.uploaded_at,
    createdAt: data.created_at ?? first.uploaded_at,
    importBatch: ctx.batchId,
  })
  // Every version's text rides with it when the source had any — a version
  // without source text gets NO text row, which honestly leaves it for the
  // text sweep (and its OCR) to derive from the copied bytes later.
  if (first.extracted_text !== undefined) {
    const v1 = await tx.query(
      `select id from deedbox.document_version where document = $1 and version_no = 1`,
      [created.document],
    )
    await writeVersionTextInTx(tx, v1.rows[0].id as number, created.document, {
      content: first.extracted_text,
      method: 'embedded',
    })
  }
  // Superseded versions, oldest to newest — the version guard enforces
  // density, and the LAST one becomes current.
  for (let i = 1; i < versions.length; i++) {
    const v = versions[i]
    const file = await tx.query(
      `insert into deedbox.document_file
         (matter, filename, content_type, size_bytes, storage_ref, source, uploaded_by, uploaded_at)
       values ($1, $2, $3, $4, $5, 'import', $6, coalesce($7::timestamptz, now())) returning id`,
      [
        matter,
        v.filename,
        v.content_type ?? 'application/octet-stream',
        v.size_bytes,
        v.storage_ref,
        by,
        v.uploaded_at ?? null,
      ],
    )
    const ver = await tx.query(
      `insert into deedbox.document_version (document, version_no, file, comment, created_by, created_at)
       values ($1, $2, $3, $4, $5, coalesce($6::timestamptz, now())) returning id`,
      [created.document, i + 1, file.rows[0].id, v.comment ?? null, by, v.uploaded_at ?? null],
    )
    await tx.query(
      `update deedbox.document set current_file = $2, current_version = $3 where id = $1`,
      [created.document, file.rows[0].id, i + 1],
    )
    if (v.extracted_text !== undefined) {
      await writeVersionTextInTx(tx, ver.rows[0].id as number, created.document, {
        content: v.extracted_text,
        method: 'embedded',
      })
    }
  }
  await recordSource(tx, ctx, sourceRef, 'document', created.document)
  return { sourceRef, disposition: 'accepted', targetType: 'document', target: created.document }
}

export interface NoteRecordData {
  matter_source_ref?: string
  matter?: number
  body: string
  noted_at?: string
  /** The historical author, by login; absent = honestly unknown (null). */
  author_login?: string
}

export async function applyNoteRecord(
  tx: Tx,
  p: Principal,
  ctx: ImportContext,
  sourceRef: string,
  data: NoteRecordData,
): Promise<RecordOutcome> {
  const hit = await sourceHit(tx, ctx.sourceSystem, sourceRef, 'note')
  if (hit) {
    return { sourceRef, disposition: 'accepted_with_warning', message: 'already imported; history never re-applies' }
  }
  if (!data.body?.trim()) {
    throw new OperationRefused('body_required', `${sourceRef}: a note needs text`)
  }
  const matter = await resolveRecordMatter(tx, ctx, data, sourceRef)
  let author: number | null = null
  if (data.author_login) {
    const r = await tx.query(`select id from deedbox.staff_member where login = $1`, [
      data.author_login,
    ])
    if (r.rowCount === 0) {
      throw new OperationRefused(
        'staff_unresolved',
        `${sourceRef}: no staff member with login ${data.author_login}`,
      )
    }
    author = r.rows[0].id as number
  }
  const note = await tx.query(
    `insert into deedbox.note (owner_type, owner, body, noted_at, author)
     values ('matter', $1, $2, coalesce($3::timestamptz, now()), $4) returning id`,
    [matter, data.body, data.noted_at ?? null, author],
  )
  const id = note.rows[0].id as number
  await emitRegister(tx, p, {
    kind: 'record.created',
    subjectType: 'note',
    subject: id,
    matter,
    detail: {
      import_batch: ctx.batchId,
      ...(data.author_login ? { author_login: data.author_login } : {}),
    },
  })
  await recordSource(tx, ctx, sourceRef, 'note', id)
  return { sourceRef, disposition: 'accepted', targetType: 'note', target: id }
}

// ---------------------------------------------------------------------------

export interface MoneyMovement {
  source_ref: string
  kind: 'receipt' | 'payment_out'
  matter_source_ref?: string
  matter?: number
  amount: number
  effective_date: string
  entered_at: string
  method?: string
  payer_description?: string
  payee?: string
  reason?: string
}

export interface FullHistoryPayload {
  account: number
  movements: MoneyMovement[]
}

async function resolveMovementMatter(
  tx: Tx,
  ctx: ImportContext,
  m: { matter_source_ref?: string; matter?: number; source_ref: string },
): Promise<number> {
  if (m.matter !== undefined) return m.matter
  if (m.matter_source_ref) {
    const hit = await sourceHit(tx, ctx.sourceSystem, m.matter_source_ref, 'matter')
    if (!hit) {
      throw new OperationRefused(
        'matter_unresolved',
        `movement ${m.source_ref}: matter source reference ${m.matter_source_ref} has not been imported`,
      )
    }
    return hit.target
  }
  throw new OperationRefused('matter_required', `movement ${m.source_ref} names no matter`)
}

/**
 * Full-history replay, INSIDE the caller's transaction. Chronological
 * source order; per-ledger serialisation and balance rules through the
 * posting protocol; any integrity failure throws — the caller's transaction
 * IS the staging posture that is discarded on refusal, so a refused batch
 * persists zero money rows.
 */
export async function applyMoneyFullHistory(
  tx: Tx,
  p: Principal,
  ctx: ImportContext,
  payload: FullHistoryPayload,
  outcomes: RecordOutcome[],
): Promise<void> {
  const movements = [...payload.movements].sort((a, b) =>
    a.entered_at === b.entered_at ? 0 : a.entered_at < b.entered_at ? -1 : 1,
  )
  let importAuthorisation: number | null = null
  for (const m of movements) {
    const hit = await sourceHit(tx, ctx.sourceSystem, m.source_ref, 'money_transaction')
    if (hit) {
      outcomes.push({
        sourceRef: m.source_ref,
        disposition: 'accepted_with_warning',
        message: 'already imported',
      })
      continue
    }
    if (!(m.amount > 0)) {
      throw new OperationRefused('bad_amount', `movement ${m.source_ref}: amounts are positive; kind carries direction`)
    }
    const matterId = await resolveMovementMatter(tx, ctx, m)
    const ledger = await ensureLedgerInTx(tx, p, matterId, payload.account)
    await tx.query(`select id from deedbox.matter_ledger where id = $1 for update`, [ledger.id])

    let txnId: number
    if (m.kind === 'receipt') {
      const num = await tx.query(`select deedbox.allocate_number('money_receipt') as n`)
      const receiptNumber = num.rows[0].n as string
      const receiptSeq = Number(receiptNumber.replace(/^\D+/, ''))
      const txn = await tx.query(
        `select deedbox.post_money_transaction(
           'receipt', $6::date, $1, 'money_receipt_number', $2,
           jsonb_build_array(
             jsonb_build_object('side','cash_book','account',$3::bigint,'signed_amount',$4::numeric),
             jsonb_build_object('side','matter_ledger','account',$3::bigint,'matter_ledger',$5::bigint,'signed_amount',$4::numeric)
           ), null, null, null, $7::timestamptz) as t`,
        [p.id, receiptSeq, payload.account, m.amount, ledger.id, m.effective_date, m.entered_at],
      )
      txnId = txn.rows[0].t as number
      const rendering = JSON.stringify({
        document: 'money_receipt',
        receipt_number: receiptNumber,
        amount: m.amount,
        method: m.method ?? 'electronic_transfer',
        imported_from: ctx.sourceSystem,
        source_ref: m.source_ref,
      })
      const artefact = await tx.query(
        `insert into deedbox.stored_artefact (kind, content_ref, content_hash, content_type, size_bytes)
         values ('money_receipt_rendering', $1, $2, 'application/json', $3) returning id`,
        [rendering, createHash('sha256').update(rendering).digest('hex'), Buffer.byteLength(rendering)],
      )
      await tx.query(
        `insert into deedbox.money_receipt
           (matter_ledger, receipt_number, payer_description, method,
            received_date, amount, transaction, printable_artefact)
         values ($1, $2, $3, $4, $5::date, $6, $7, $8)`,
        [
          ledger.id,
          receiptNumber,
          m.payer_description ?? `imported from ${ctx.sourceSystem}`,
          m.method ?? 'electronic_transfer',
          m.effective_date,
          m.amount,
          txnId,
          String(artefact.rows[0].id),
        ],
      )
    } else {
      // one approved import authorisation per batch evidences the operator's
      // authority over every historical payment it replays (subject_type is
      // schema-constrained to the payment kinds; the note carries the batch).
      // The subject is the NEGATED batch id: a positive batch id would one
      // day collide with a real payment's id and hand that payment a phantom
      // approval — the negative space collides with nothing, ever.
      if (importAuthorisation === null) {
        const auth = await tx.query(
          `insert into deedbox.payment_authorisation (subject_type, subject, authoriser, decision, note)
           values ('money_payment', $1, $2, 'approved', $3) returning id`,
          [-ctx.batchId, p.id, `money history import from ${ctx.sourceSystem} (batch ${ctx.batchId})`],
        )
        importAuthorisation = auth.rows[0].id as number
      }
      const txn = await tx.query(
        `select deedbox.post_money_transaction(
           'payment_out', $6::date, $1, 'import_batch', $2,
           jsonb_build_array(
             jsonb_build_object('side','cash_book','account',$3::bigint,'signed_amount',-$4::numeric),
             jsonb_build_object('side','matter_ledger','account',$3::bigint,'matter_ledger',$5::bigint,'signed_amount',-$4::numeric)
           ), $8, $7::bigint, null, $9::timestamptz) as t`,
        [
          p.id,
          ctx.batchId,
          payload.account,
          m.amount,
          ledger.id,
          m.effective_date,
          importAuthorisation,
          m.reason ?? `imported payment ${m.source_ref} (${m.payee ?? 'payee unrecorded'})`,
          m.entered_at,
        ],
      )
      txnId = txn.rows[0].t as number
    }
    await emitRegister(tx, p, {
      kind: 'money.transaction_posted',
      subjectType: 'money_transaction',
      subject: txnId,
      matter: matterId,
      detail: { kind: m.kind, amount: m.amount, import_batch: ctx.batchId, source_ref: m.source_ref },
    })
    await recordSource(tx, ctx, m.source_ref, 'money_transaction', txnId)
    outcomes.push({
      sourceRef: m.source_ref,
      disposition: 'accepted',
      targetType: 'money_transaction',
      target: txnId,
    })
  }
}

export interface OpeningBalanceRecord {
  source_ref: string
  matter_source_ref?: string
  matter?: number
  amount: number
  as_at_date: string
  source_closing_balance: number
  /**
   * The ledger's full prior history, kept as evidence rather than replayed.
   * A ledger that ever went below zero cannot be replayed into this engine —
   * the guard refuses the negative posting, and that refusal is the product.
   * Such a ledger arrives as an opening balance at the boundary date with its
   * old history stored verbatim as a labelled archive artefact, referenced
   * from the opening balance's own register entry and from the batch report.
   */
  legacy_ledger?: unknown
}

export interface OpeningBalancesPayload {
  account: number
  balances: OpeningBalanceRecord[]
}

/**
 * Opening-balances mode: one clearly labelled opening_balance
 * transaction per ledger, and the boundary reconciliation rows the caller
 * stores as the batch's auditable artefact. A mismatch between the posted
 * amount and the source system's closing balance refuses the whole batch.
 */
export async function applyOpeningBalances(
  tx: Tx,
  p: Principal,
  ctx: ImportContext,
  payload: OpeningBalancesPayload,
  outcomes: RecordOutcome[],
): Promise<{
  boundary: {
    sourceRef: string
    ledger: number
    posted: number
    sourceClosing: number
    legacyArtefact: number | null
  }[]
}> {
  const boundary: {
    sourceRef: string
    ledger: number
    posted: number
    sourceClosing: number
    legacyArtefact: number | null
  }[] = []
  for (const b of payload.balances) {
    const hit = await sourceHit(tx, ctx.sourceSystem, b.source_ref, 'money_transaction')
    if (hit) {
      outcomes.push({
        sourceRef: b.source_ref,
        disposition: 'accepted_with_warning',
        message: 'already imported',
      })
      continue
    }
    if (Math.round(b.amount * 100) !== Math.round(b.source_closing_balance * 100)) {
      throw new OperationRefused(
        'boundary_mismatch',
        `${b.source_ref}: opening amount ${b.amount.toFixed(2)} does not equal the source closing balance ${b.source_closing_balance.toFixed(2)}`,
      )
    }
    if (!(b.amount > 0)) {
      throw new OperationRefused('bad_amount', `${b.source_ref}: an opening balance is above zero`)
    }
    const matterId = await resolveMovementMatter(tx, ctx, b)
    const ledger = await ensureLedgerInTx(tx, p, matterId, payload.account)
    await tx.query(`select id from deedbox.matter_ledger where id = $1 for update`, [ledger.id])
    const existing = await tx.query(
      `select 1 from deedbox.money_transaction t
        join deedbox.ledger_line l on l.transaction = t.id
       where t.txn_kind = 'opening_balance' and l.matter_ledger = $1`,
      [ledger.id],
    )
    if (existing.rowCount! > 0) {
      throw new OperationRefused(
        'opening_exists',
        `${b.source_ref}: ledger ${ledger.id} already carries an opening balance`,
      )
    }
    const txn = await tx.query(
      `select deedbox.post_money_transaction(
         'opening_balance', $5::date, $1, 'import_batch', $2,
         jsonb_build_array(
           jsonb_build_object('side','cash_book','account',$3::bigint,'signed_amount',$4::numeric),
           jsonb_build_object('side','matter_ledger','account',$3::bigint,'matter_ledger',$6::bigint,'signed_amount',$4::numeric)
         )) as t`,
      [p.id, ctx.batchId, payload.account, b.amount, b.as_at_date, ledger.id],
    )
    const txnId = txn.rows[0].t as number

    // a ledger arriving by this route because it cannot be replayed keeps its
    // old history as evidence: stored verbatim, hashed, and pointed at from
    // the register entry below so it is reachable from the matter itself
    let legacyArtefact: number | null = null
    if (b.legacy_ledger !== undefined && b.legacy_ledger !== null) {
      const archive = {
        document: 'legacy_ledger',
        source_system: ctx.sourceSystem,
        source_ref: b.source_ref,
        as_at: b.as_at_date,
        closing_balance: b.source_closing_balance,
        history: b.legacy_ledger,
      }
      const content = JSON.stringify(archive)
      const stored = await tx.query(
        `insert into deedbox.stored_artefact (kind, content_ref, content_hash, content_type, size_bytes)
         values ('legacy_ledger_rendering', $1, $2, 'application/json', $3) returning id`,
        [content, createHash('sha256').update(content).digest('hex'), Buffer.byteLength(content)],
      )
      legacyArtefact = stored.rows[0].id as number
    }

    await emitRegister(tx, p, {
      kind: 'money.transaction_posted',
      subjectType: 'money_transaction',
      subject: txnId,
      matter: matterId,
      detail: {
        kind: 'opening_balance',
        amount: b.amount,
        as_at: b.as_at_date,
        import_batch: ctx.batchId,
        source_ref: b.source_ref,
        legacy_ledger_artefact: legacyArtefact,
      },
    })
    await recordSource(tx, ctx, b.source_ref, 'money_transaction', txnId)
    boundary.push({
      sourceRef: b.source_ref,
      ledger: ledger.id,
      posted: b.amount,
      sourceClosing: b.source_closing_balance,
      legacyArtefact,
    })
    outcomes.push({
      sourceRef: b.source_ref,
      disposition: 'accepted',
      targetType: 'money_transaction',
      target: txnId,
    })
  }
  return { boundary }
}

// ---------------------------------------------------------------------------
// Workbook appliers: the domains recorded as migration-workbook content. Same
// discipline as every applier above — source-reference keys make re-runs
// repeat-safe (already-imported = a warning, never a duplicate), hard problems
// THROW typed (the batch's savepoint turns them into itemised refusals), and
// every write goes through the owning domain's rules.
// ---------------------------------------------------------------------------

async function resolveRecordMatter(
  tx: Tx,
  ctx: ImportContext,
  r: { matter_source_ref?: string; matter?: number },
  sourceRef: string,
): Promise<number> {
  if (r.matter !== undefined) return r.matter
  if (r.matter_source_ref) {
    const hit = await sourceHit(tx, ctx.sourceSystem, r.matter_source_ref, 'matter')
    if (!hit) {
      throw new OperationRefused(
        'matter_unresolved',
        `${sourceRef}: matter source reference ${r.matter_source_ref} has not been imported`,
      )
    }
    return hit.target
  }
  throw new OperationRefused('matter_required', `${sourceRef} names no matter`)
}

export interface TimeEntryRecordData {
  matter_source_ref?: string
  matter?: number
  /** The historical owner, by login — the record belongs to them, not the importer. */
  staff_login: string
  work_date: string
  kind?: 'timed' | 'fixed_fee'
  units?: number
  fixed_amount?: number
  /** The source system's rate, so the value reproduces exactly. */
  manual_rate?: number
  narrative: string
}

/**
 * Unbilled time only — live work-in-progress the firm still intends to
 * bill. BILLED history never re-enters as time rows: it arrives inside its
 * bill (summary lines + the legacy rendering artefact carrying the full
 * source detail). Deliberate workbook decision.
 */
export async function applyTimeEntryRecord(
  tx: Tx,
  p: Principal,
  ctx: ImportContext,
  sourceRef: string,
  data: TimeEntryRecordData,
): Promise<RecordOutcome> {
  const hit = await sourceHit(tx, ctx.sourceSystem, sourceRef, 'time_entry')
  if (hit) {
    return { sourceRef, disposition: 'accepted_with_warning', message: 'already imported; history never re-applies' }
  }
  const matter = await resolveRecordMatter(tx, ctx, data, sourceRef)
  const staff = await tx.query(`select id from deedbox.staff_member where login = $1`, [
    data.staff_login,
  ])
  if (staff.rowCount === 0) {
    throw new OperationRefused('staff_unresolved', `${sourceRef}: no staff member with login ${data.staff_login}`)
  }
  const created = await createTimeEntryInTx(tx, p, {
    matter,
    staff: staff.rows[0].id as number,
    workDate: data.work_date,
    kind: data.kind ?? 'timed',
    units: data.units,
    fixedAmount: data.fixed_amount,
    manualRate: data.manual_rate,
    narrative: data.narrative,
    origin: 'import',
  })
  await recordSource(tx, ctx, sourceRef, 'time_entry', created.id)
  return { sourceRef, disposition: 'accepted', targetType: 'time_entry', target: created.id }
}

export interface ImportedBillLine {
  description: string
  net: number
  tax: number
  category_key?: string
}

export interface ImportedJournalEntry {
  kind: 'issue_total' | 'payment_allocation' | 'credit_application' | 'write_off' | 'interest_charge'
  /** Signed exactly as the source system's effect on the balance. */
  amount: number
  date: string
  /** The source system's justification — the schema DEMANDS one on write-offs. */
  reason?: string
}

export interface BillRecordData {
  matter_source_ref?: string
  matter?: number
  payer_source_ref?: string
  payer_party?: number
  /** The source system's number — evidence, verbatim, never re-allocated. */
  bill_number: string
  issue_date: string
  terms_days: number
  due_date?: string
  lines: ImportedBillLine[]
  journal: ImportedJournalEntry[]
  /** Anything else the source system knew — preserved whole in the artefact. */
  legacy_detail?: unknown
}

/**
 * An issued bill with its financial history, reproduced to the cent.
 * The bill KEEPS its old number (evidence; the engine's own new series is
 * untouched); its lines import as MANUAL summary lines; the full old
 * detail is frozen into a legacy rendering artefact; the journal replays
 * as native entries in history order. No reminder schedule is created —
 * chasing an imported bill is a deliberate later act by the firm.
 */
export async function applyBillRecord(
  tx: Tx,
  p: Principal,
  ctx: ImportContext,
  sourceRef: string,
  data: BillRecordData,
): Promise<RecordOutcome> {
  const hit = await sourceHit(tx, ctx.sourceSystem, sourceRef, 'bill')
  if (hit) {
    return { sourceRef, disposition: 'accepted_with_warning', message: 'already imported; history never re-applies' }
  }
  if (!Array.isArray(data.journal) || data.journal.length === 0) {
    throw new OperationRefused('journal_required', `${sourceRef}: an imported bill carries its journal history`)
  }
  if (data.journal[0].kind !== 'issue_total' || data.journal[0].amount <= 0) {
    throw new OperationRefused(
      'journal_shape',
      `${sourceRef}: the first journal entry is the positive issue total`,
    )
  }
  const issueCents = Math.round(data.journal[0].amount * 100)
  if (!Array.isArray(data.lines) || data.lines.length === 0) {
    throw new OperationRefused('lines_required', `${sourceRef}: an imported bill carries at least one line`)
  }
  const lineCents = data.lines.reduce(
    (s, l) => s + Math.round(l.net * 100) + Math.round(l.tax * 100),
    0,
  )
  if (lineCents !== issueCents) {
    throw new OperationRefused(
      'totals_disagree',
      `${sourceRef}: lines sum to ${(lineCents / 100).toFixed(2)} but the issue total is ${(issueCents / 100).toFixed(2)} — the old record must reproduce to the cent`,
    )
  }
  let runningCents = 0
  for (const e of data.journal) {
    runningCents += Math.round(e.amount * 100)
    if (runningCents < 0) {
      throw new OperationRefused(
        'history_not_replayable',
        `${sourceRef}: the journal drives the balance below zero — route this record specially, never replay it`,
      )
    }
  }
  const taken = await tx.query(`select 1 from deedbox.bill where bill_number = $1`, [data.bill_number])
  if ((taken.rowCount ?? 0) > 0) {
    throw new OperationRefused('bill_number_taken', `${sourceRef}: a bill numbered ${data.bill_number} already exists`)
  }
  const matter = await resolveRecordMatter(tx, ctx, data, sourceRef)
  let payer = data.payer_party ?? null
  if (payer === null && data.payer_source_ref) {
    const ph = await sourceHit(tx, ctx.sourceSystem, data.payer_source_ref, 'party')
    if (!ph) {
      throw new OperationRefused(
        'payer_unresolved',
        `${sourceRef}: payer source reference ${data.payer_source_ref} has not been imported`,
      )
    }
    payer = ph.target
  }
  if (payer === null) {
    const mc = await tx.query(`select client_party from deedbox.matter where id = $1`, [matter])
    payer = mc.rows[0].client_party as number
  }

  const group = await tx.query(
    `insert into deedbox.bill_group (matter, matter_total, payer_share_snapshot)
     values ($1, $2, '[]') returning id`,
    [matter, (issueCents / 100).toFixed(2)],
  )
  const groupId = group.rows[0].id as number
  const bill = await tx.query(
    `insert into deedbox.bill (bill_group, matter, payer_party) values ($1, $2, $3) returning id`,
    [groupId, matter, payer],
  )
  const billId = bill.rows[0].id as number

  const rendering = {
    document: 'legacy_bill',
    source_system: ctx.sourceSystem,
    source_ref: sourceRef,
    bill_number: data.bill_number,
    issue_date: data.issue_date,
    terms_days: data.terms_days,
    lines: data.lines,
    journal: data.journal,
    legacy_detail: data.legacy_detail ?? null,
  }
  const content = JSON.stringify(rendering)
  const artefact = await tx.query(
    `insert into deedbox.stored_artefact (kind, content_ref, content_hash, content_type, size_bytes)
     values ('legacy_bill_rendering', $1, $2, 'application/json', $3) returning id`,
    [content, createHash('sha256').update(content).digest('hex'), Buffer.byteLength(content)],
  )

  // lines are drafted onto DRAFT bills only (the engine's own rule) —
  // they land before the issue step. The treatment is a label here: the
  // source system's tax amount rides verbatim (0049 keeps imports exact),
  // and the label is the pack's own default key so the trigger accepts it.
  let position = 0
  const importTreatment = await defaultTaxTreatment(tx, p.firm)
  for (const l of data.lines) {
    position += 1
    await tx.query(
      `insert into deedbox.bill_line
         (bill, position, kind, source_entry, description, original_value, amount,
          tax_treatment, tax_amount, category_key)
       values ($1, $2, 'manual', null, $3, $4, $4, $7, $5, $6)`,
      [billId, position, l.description, l.net.toFixed(2), l.tax.toFixed(2), l.category_key ?? 'imported', importTreatment],
    )
  }

  const due =
    data.due_date ??
    ((await tx.query(`select ($1::date + $2::int)::text as d`, [data.issue_date, data.terms_days]))
      .rows[0].d as string)
  await tx.query(
    `update deedbox.bill
        set state = 'issued', bill_number = $2, issue_date = $3::date,
            terms_days_applied = $4, due_date = $5::date, rendered_artefact = $6
      where id = $1`,
    [billId, data.bill_number, data.issue_date, data.terms_days, due, String(artefact.rows[0].id)],
  )

  for (const e of data.journal) {
    // the schema demands a reason on write-offs (evidence needs its
    // justification); the source system's reason carries across, and its
    // absence is recorded honestly rather than invented
    const reason =
      e.kind === 'write_off'
        ? (e.reason?.trim() || 'written off in the source system; no reason recorded there')
        : (e.reason?.trim() || null)
    await tx.query(
      `insert into deedbox.bill_journal_entry
         (bill, entry_kind, signed_amount, source_type, source, effective_date, entered_by, reason)
       values ($1, $2, $3, 'import', $4, $5::date, $6, $7)`,
      [billId, e.kind, e.amount.toFixed(2), ctx.batchId, e.date, p.id, reason],
    )
  }

  await emitRegister(tx, p, {
    kind: 'record.created',
    subjectType: 'bill',
    subject: billId,
    matter,
    detail: {
      import_batch: ctx.batchId,
      source_ref: sourceRef,
      bill_number: data.bill_number,
      issue_total: (issueCents / 100).toFixed(2),
      outstanding: (runningCents / 100).toFixed(2),
    },
  })
  await recordSource(tx, ctx, sourceRef, 'bill', billId)
  return {
    sourceRef,
    disposition: 'accepted',
    targetType: 'bill',
    target: billId,
    message: `outstanding ${(runningCents / 100).toFixed(2)}`,
  }
}

export interface OtherRecordData {
  record_kind: 'disbursement'
  matter_source_ref?: string
  matter?: number
  incurred_date: string
  description: string
  amount: number
  tax_treatment?: string
}

/**
 * The "other" domain, v1 = UNBILLED disbursements (live WIP on open
 * matters). Billed history rides its bill; anything else the workbook
 * surfaces gets its own record_kind here with its own rules.
 */
export async function applyOtherRecord(
  tx: Tx,
  p: Principal,
  ctx: ImportContext,
  sourceRef: string,
  data: OtherRecordData,
): Promise<RecordOutcome> {
  if (data.record_kind !== 'disbursement') {
    throw new OperationRefused(
      'record_kind_unknown',
      `${sourceRef}: unknown other-record kind ${String(data.record_kind)}`,
    )
  }
  const hit = await sourceHit(tx, ctx.sourceSystem, sourceRef, 'disbursement')
  if (hit) {
    return { sourceRef, disposition: 'accepted_with_warning', message: 'already imported; history never re-applies' }
  }
  const matter = await resolveRecordMatter(tx, ctx, data, sourceRef)
  const m = await tx.query(`select status from deedbox.matter where id = $1`, [matter])
  if (m.rows[0].status === 'closed' || m.rows[0].status === 'archived') {
    throw new OperationRefused(
      'matter_closed',
      `${sourceRef}: unbilled costs import onto OPEN matters only — billed history rides its bill`,
    )
  }
  if (!(data.amount > 0)) {
    throw new OperationRefused('amount_required', `${sourceRef}: a disbursement needs its amount above zero`)
  }
  const row = await tx.query(
    `insert into deedbox.disbursement
       (matter, incurred_date, description, amount, tax_treatment, billable, cost_type, created_by)
     values ($1, $2::date, $3, $4, $5, true, null, $6) returning id`,
    [
      matter,
      data.incurred_date,
      data.description,
      data.amount.toFixed(2),
      data.tax_treatment ?? (await defaultTaxTreatment(tx, p.firm)),
      p.id,
    ],
  )
  await recordSource(tx, ctx, sourceRef, 'disbursement', row.rows[0].id as number)
  return { sourceRef, disposition: 'accepted', targetType: 'disbursement', target: row.rows[0].id as number }
}
