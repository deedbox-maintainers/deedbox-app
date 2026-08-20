// The documents module's core (schema change 0030): the byte-store seam
// (unbound refusal, bytes-first upload), heads + dense immutable versions,
// filing intake arrivals, checkout exclusivity, the admin lock, legal
// hold, soft delete + window-bound restore with corpus registration,
// folders (delete only when empty), access evidence, and the
// predicate-governed reads.
//
// Cross-suite contract: binds its OWN fake byte store and unbinds in
// afterAll (config/intake-api/jobs prove other seams' unbound refusals —
// this seam is proven unbound HERE, first test, after an explicit null).
// Flips no settings. Fixture tag 'doc' (first-three unique).

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import type { Pool } from 'pg'
import { closePool } from '@/lib/db'
import type { Principal } from '@/lib/db'
import {
  setDocumentByteStore,
  uploadDocument,
  addDocumentVersion,
  fileArrival,
  editDocument,
  checkoutDocument,
  checkinDocument,
  setDocumentLock,
  setLegalHold,
  softDeleteDocument,
  restoreDocument,
  recordDocumentAccess,
  createFolder,
  deleteEmptyFolder,
} from '@/lib/ops/documents'
import { matterDocumentsTab, documentDetail } from '@/lib/reads/documents'
import { makeAdminPool, buildFixture, type Fixture } from './helpers'

let admin: Pool
let fx: Fixture
let P: Principal
let P2: Principal
let closedMatter: number
let puts = 0

beforeAll(async () => {
  admin = makeAdminPool()
  fx = await buildFixture(admin, 'doc')
  P = { kind: 'staff', id: fx.staff, firm: fx.firm }
  const s2 = await admin.query(
    `insert into deedbox.staff_member (person_name, login, role, office, email)
     values ('{"given":"Second","family":"Doc"}','second.doc', $1, $2, 'second.doc@example.test')
     returning id`,
    [fx.adminRole, fx.office],
  )
  P2 = { kind: 'staff', id: s2.rows[0].id as number, firm: fx.firm }
  const num = await admin.query(`select deedbox.allocate_number('matter', null, current_date) as n`)
  const m2 = await admin.query(
    `insert into deedbox.matter (matter_number, title, client_party, responsible_lawyer, office, practice_area)
     values ($1, 'DOC closed matter', $2, $3, $4, $5) returning id`,
    [num.rows[0].n, fx.clientParty, fx.staff, fx.office, fx.practiceArea],
  )
  closedMatter = m2.rows[0].id as number
  await admin.query(
    `begin;
     insert into deedbox.matter_close_request (matter, requested_by, financial_position, condition_evaluation, state, decided_by, decided_at)
       values (${closedMatter}, ${fx.staff}, '{}', '{}', 'approved', ${fx.staff}, now());
     update deedbox.matter set status='closed' where id = ${closedMatter};
     commit;`,
  )
})

afterAll(async () => {
  setDocumentByteStore(null)
  await closePool()
  await admin.end()
})

describe('the documents module core', () => {
  let doc1 = 0
  let folder1 = 0

  it('an unbound byte store refuses typed; a bound one stores bytes first', async () => {
    setDocumentByteStore(null)
    await expect(
      uploadDocument(P, { matter: fx.matter, filename: 'x.pdf', bytes: Buffer.from('a') }),
    ).rejects.toMatchObject({ code: 'document_storage_unbound' })
    setDocumentByteStore(async ({ matter, filename }) => ({
      storageRef: `${matter}/fake-${++puts}-${filename}`,
      contentType: 'application/pdf',
    }))
  })

  it('upload creates the landing row, the head, version 1, the corpus row and the register entry', async () => {
    const r = await uploadDocument(P, {
      matter: fx.matter,
      filename: 'advice.pdf',
      bytes: Buffer.from('first version'),
      title: 'Letter of advice',
      description: 'initial advice on prospects',
    })
    doc1 = r.document
    const file = await admin.query(`select * from deedbox.document_file where id = $1`, [r.file])
    expect(file.rows[0].source).toBe('staff_upload')
    expect(file.rows[0].uploaded_by).toBe(fx.staff)
    expect(Number(file.rows[0].size_bytes)).toBe(13)
    const v = await admin.query(
      `select version_no, file from deedbox.document_version where document = $1`,
      [doc1],
    )
    expect(v.rowCount).toBe(1)
    expect(v.rows[0].version_no).toBe(1)
    const corpus = await admin.query(
      `select content, superseded_at from deedbox.registered_text
        where source_module='documents' and source_type='external_document' and source_ref=$1`,
      [String(doc1)],
    )
    expect(corpus.rowCount).toBe(1)
    expect(corpus.rows[0].content).toContain('Letter of advice')
    expect(corpus.rows[0].superseded_at).toBeNull()
    const reg = await admin.query(
      `select 1 from deedbox.register_entry
        where event_kind='record.created' and subject_type='document' and subject=$1`,
      [doc1],
    )
    expect(reg.rowCount).toBe(1)
  })

  it('versions are dense and checkout-exclusive; the holder auto-releases; a signal lands', async () => {
    await checkoutDocument(P2, { document: doc1, purpose: 'editing' })
    await expect(
      addDocumentVersion(P, { document: doc1, filename: 'advice-v2.pdf', bytes: Buffer.from('bb') }),
    ).rejects.toMatchObject({ code: 'checked_out_elsewhere' })
    await expect(
      checkoutDocument(P, { document: doc1 }),
    ).rejects.toMatchObject({ code: 'checked_out_elsewhere' })
    const r = await addDocumentVersion(P2, {
      document: doc1,
      filename: 'advice-v2.pdf',
      bytes: Buffer.from('bb'),
      comment: 'holder checks in',
    })
    expect(r.version).toBe(2)
    const head = await admin.query(
      `select current_version, checked_out_by from deedbox.document where id = $1`,
      [doc1],
    )
    expect(head.rows[0].current_version).toBe(2)
    expect(head.rows[0].checked_out_by).toBeNull()
    const sig = await admin.query(
      `select 1 from deedbox.activity_signal
        where source_module='documents' and source_ref=$1 and signal_kind='document_worked'`,
      [`document:${doc1}:v2`],
    )
    expect(sig.rowCount).toBe(1)
  })

  it('an intake arrival files into a head exactly once', async () => {
    const arrival = await admin.query(
      `insert into deedbox.document_file (matter, filename, size_bytes, storage_ref, source)
       values ($1, 'from-intake.pdf', 7, $2, 'intake_api') returning id`,
      [fx.matter, `${fx.matter}/intake-arrival.pdf`],
    )
    const before = await matterDocumentsTab(P, fx.matter)
    expect(before.arrivals.some((a) => a.id === arrival.rows[0].id)).toBe(true)
    const filed = await fileArrival(P, { file: arrival.rows[0].id as number })
    await expect(fileArrival(P, { file: arrival.rows[0].id as number })).rejects.toMatchObject({
      code: 'already_filed',
    })
    const after = await matterDocumentsTab(P, fx.matter)
    expect(after.arrivals.some((a) => a.id === arrival.rows[0].id)).toBe(false)
    expect(after.documents.some((d) => d.id === filed.document)).toBe(true)
  })

  it('metadata edits re-register the corpus; the lock freezes everything but its flags', async () => {
    await editDocument(P, { document: doc1, title: 'Amended advice', description: 'revised' })
    const corpus = await admin.query(
      `select content from deedbox.registered_text
        where source_module='documents' and source_ref=$1 and superseded_at is null`,
      [String(doc1)],
    )
    expect(corpus.rows[0].content).toContain('Amended advice')
    await setDocumentLock(P, { document: doc1, locked: true })
    await expect(
      editDocument(P, { document: doc1, title: 'While locked' }),
    ).rejects.toMatchObject({ code: 'document_locked' })
    await expect(
      addDocumentVersion(P, { document: doc1, filename: 'v3.pdf', bytes: Buffer.from('c') }),
    ).rejects.toMatchObject({ code: 'document_locked' })
    await setDocumentLock(P, { document: doc1, locked: false })
  })

  it('legal hold blocks soft delete; released, delete withdraws the corpus and restore re-registers', async () => {
    await setLegalHold(P, { document: doc1, hold: true })
    await expect(softDeleteDocument(P, { document: doc1 })).rejects.toMatchObject({
      code: 'legal_hold',
    })
    await setLegalHold(P, { document: doc1, hold: false })
    await softDeleteDocument(P, { document: doc1 })
    const gone = await admin.query(
      `select superseded_at from deedbox.registered_text
        where source_module='documents' and source_ref=$1
        order by registered_at desc limit 1`,
      [String(doc1)],
    )
    expect(gone.rows[0].superseded_at).not.toBeNull()
    const tab = await matterDocumentsTab(P, fx.matter)
    expect(tab.documents.some((d) => d.id === doc1)).toBe(false)
    await restoreDocument(P, { document: doc1 })
    const back = await admin.query(
      `select 1 from deedbox.registered_text
        where source_module='documents' and source_ref=$1 and superseded_at is null`,
      [String(doc1)],
    )
    expect(back.rowCount).toBe(1)
    const reg = await admin.query(
      `select 1 from deedbox.register_entry
        where event_kind='record.restored' and subject_type='document' and subject=$1`,
      [doc1],
    )
    expect(reg.rowCount).toBe(1)
  })

  it('folders hold documents and refuse deletion until empty', async () => {
    const f = await createFolder(P, { matter: fx.matter, name: 'Correspondence' })
    folder1 = f.folder
    const up = await uploadDocument(P, {
      matter: fx.matter,
      folder: folder1,
      filename: 'inside.pdf',
      bytes: Buffer.from('in a folder'),
    })
    await expect(deleteEmptyFolder(P, { folder: folder1 })).rejects.toMatchObject({
      code: 'folder_not_empty',
    })
    await editDocument(P, { document: up.document, folder: null })
    await deleteEmptyFolder(P, { folder: folder1 })
    const tab = await matterDocumentsTab(P, fx.matter)
    expect(tab.folders.some((x) => x.id === folder1)).toBe(false)
  })

  it('closed matters refuse document writes typed', async () => {
    await expect(
      uploadDocument(P, { matter: closedMatter, filename: 'late.pdf', bytes: Buffer.from('x') }),
    ).rejects.toMatchObject({ code: 'matter_closed' })
  })

  it('access is recorded as evidence and served on the detail', async () => {
    await recordDocumentAccess(P, { document: doc1, action: 'downloaded' })
    const detail = await documentDetail(P, doc1)
    expect(detail.document.id).toBe(doc1)
    expect(detail.versions.length).toBe(2)
    expect(detail.versions[0].versionNo).toBe(2)
    expect(detail.access.some((a) => a.action === 'downloaded' && a.actor === fx.staff)).toBe(true)
  })
})
