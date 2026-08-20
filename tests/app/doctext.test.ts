// Documents text (schema change 0033): extraction on upload (real pdf +
// real Word file), the corpus and search-index rows carrying the body
// text and re-pointing at the newest version, the sweep job backfilling
// versions born without text exactly once, honest 'none' for unreadable
// binaries, and soft deletion clearing the search row.
//
// Cross-suite contract: binds its OWN fake byte store + fetch and unbinds
// both in afterAll. Flips no settings. Fixture tag 'dtx' (first-three
// unique).

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import type { Pool } from 'pg'
import PizZip from 'pizzip'
import { PDFDocument, StandardFonts } from 'pdf-lib'
import { closePool } from '@/lib/db'
import type { Principal } from '@/lib/db'
import {
  setDocumentByteStore,
  setDocumentByteFetch,
  uploadDocument,
  addDocumentVersion,
  softDeleteDocument,
  runDocumentTextSweep,
} from '@/lib/ops/documents'
import { compareVersions } from '@/lib/reads/documents'
import { makeAdminPool, buildFixture, type Fixture } from './helpers'

let admin: Pool
let fx: Fixture
let P: Principal
const stored = new Map<string, Buffer>()
let putCount = 0
let fetchCount = 0

function makeDocx(bodyText: string): Buffer {
  const esc = bodyText.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  const zip = new PizZip()
  zip.file(
    '[Content_Types].xml',
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
      `<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">` +
      `<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>` +
      `<Default Extension="xml" ContentType="application/xml"/>` +
      `<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>` +
      `</Types>`,
  )
  zip.file(
    '_rels/.rels',
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
      `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
      `<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>` +
      `</Relationships>`,
  )
  zip.file(
    'word/document.xml',
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
      `<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">` +
      `<w:body><w:p><w:r><w:t xml:space="preserve">${esc}</w:t></w:r></w:p></w:body></w:document>`,
  )
  return Buffer.from(zip.generate({ type: 'nodebuffer' }))
}

async function makePdf(text: string): Promise<Buffer> {
  const pdf = await PDFDocument.create()
  const page = pdf.addPage([400, 200])
  const font = await pdf.embedFont(StandardFonts.Helvetica)
  page.drawText(text, { x: 40, y: 120, size: 12, font })
  return Buffer.from(await pdf.save())
}

beforeAll(async () => {
  admin = makeAdminPool()
  fx = await buildFixture(admin, 'dtx')
  P = { kind: 'staff', id: fx.staff, firm: fx.firm }
  setDocumentByteStore(async ({ matter, filename, bytes }) => {
    const storageRef = `${matter ?? 'templates'}/dtx-${++putCount}-${filename}`
    stored.set(storageRef, bytes)
    const contentType = filename.toLowerCase().endsWith('.pdf')
      ? 'application/pdf'
      : 'application/octet-stream'
    return { storageRef, contentType }
  })
  setDocumentByteFetch(async (storageRef) => {
    fetchCount++
    const bytes = stored.get(storageRef)
    if (!bytes) throw new Error(`no stored object at ${storageRef}`)
    return { bytes, contentType: 'application/octet-stream' }
  })
})

afterAll(async () => {
  setDocumentByteStore(null)
  setDocumentByteFetch(null)
  await closePool()
  await admin.end()
})

describe('document text extraction, search and compare', () => {
  let pdfDoc = 0
  let wordDoc = 0

  it('a real pdf and a real Word file extract on upload into corpus and search', async () => {
    const up = await uploadDocument(P, {
      matter: fx.matter,
      filename: 'agreement.pdf',
      bytes: await makePdf('the quick brown fox agreement'),
      title: 'Fox agreement',
    })
    pdfDoc = up.document
    const text = await admin.query(
      `select t.content, t.method from deedbox.document_version_text t
         join deedbox.document_version v on v.id = t.version
        where v.document = $1 and v.version_no = 1`,
      [pdfDoc],
    )
    expect(text.rows[0].method).toBe('embedded')
    expect(text.rows[0].content).toContain('quick brown fox')
    const corpus = await admin.query(
      `select content from deedbox.registered_text
        where source_module='documents' and source_ref=$1 and superseded_at is null`,
      [String(pdfDoc)],
    )
    expect(corpus.rows[0].content).toContain('quick brown fox')
    const idx = await admin.query(
      `select display_title, body from deedbox.search_index
        where entry_type='document' and source=$1`,
      [pdfDoc],
    )
    expect(idx.rows[0].display_title).toBe('Fox agreement')
    expect(idx.rows[0].body).toContain('quick brown fox')

    const up2 = await uploadDocument(P, {
      matter: fx.matter,
      filename: 'advice.docx',
      bytes: makeDocx('confidential merger advice for the dtx client'),
    })
    wordDoc = up2.document
    const wordIdx = await admin.query(
      `select body from deedbox.search_index where entry_type='document' and source=$1`,
      [wordDoc],
    )
    expect(wordIdx.rows[0].body).toContain('confidential merger advice')
  })

  it('a new version re-points corpus and search at the newest text; compare serves both', async () => {
    await addDocumentVersion(P, {
      document: pdfDoc,
      filename: 'agreement-v2.pdf',
      bytes: await makePdf('the amended lazy dog agreement'),
    })
    const idx = await admin.query(
      `select body from deedbox.search_index where entry_type='document' and source=$1`,
      [pdfDoc],
    )
    expect(idx.rows[0].body).toContain('lazy dog')
    expect(idx.rows[0].body).not.toContain('quick brown fox')
    const cmp = await compareVersions(P, pdfDoc, 1, 2)
    expect(cmp.a?.text).toContain('quick brown fox')
    expect(cmp.b?.text).toContain('lazy dog')
  })

  it('an unreadable binary is honestly text-less, never a crash', async () => {
    const up = await uploadDocument(P, {
      matter: fx.matter,
      filename: 'photo.bin',
      bytes: Buffer.from([0xff, 0xd8, 0x01, 0x02, 0x03]),
    })
    const text = await admin.query(
      `select t.method, t.content from deedbox.document_version_text t
         join deedbox.document_version v on v.id = t.version
        where v.document = $1`,
      [up.document],
    )
    expect(text.rows[0].method).toBe('none')
    expect(text.rows[0].content).toBe('')
  })

  it('the sweep backfills versions born without text, exactly once', async () => {
    // a pre-slice document: head + version written directly, no text row
    const bytes = makeDocx('backfill me from the dtx sweep')
    const ref = `${fx.matter}/dtx-manual-backfill.docx`
    stored.set(ref, bytes)
    const file = await admin.query(
      `insert into deedbox.document_file (matter, filename, content_type, size_bytes, storage_ref, source, uploaded_by)
       values ($1, 'backfill.docx', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', $2, $3, 'staff_upload', $4)
       returning id`,
      [fx.matter, bytes.length, ref, fx.staff],
    )
    const head = await admin.query(
      `insert into deedbox.document (matter, title, current_file, current_version, created_by)
       values ($1, 'Backfill target', $2, 1, $3) returning id`,
      [fx.matter, file.rows[0].id, fx.staff],
    )
    await admin.query(
      `insert into deedbox.document_version (document, version_no, file, created_by)
       values ($1, 1, $2, $3)`,
      [head.rows[0].id, file.rows[0].id, fx.staff],
    )
    const first = await runDocumentTextSweep(P)
    expect(first.extracted).toBeGreaterThanOrEqual(1)
    const text = await admin.query(
      `select t.content from deedbox.document_version_text t
         join deedbox.document_version v on v.id = t.version
        where v.document = $1`,
      [head.rows[0].id],
    )
    expect(text.rows[0].content).toContain('backfill me')
    const again = await runDocumentTextSweep(P)
    expect(again.extracted).toBe(0)
  })

  it('unreadable formats and over-cap files are recorded text-less without a fetch', async () => {
    // catalogue-only rows — storage deliberately holds NO such objects, so
    // any attempted fetch would show in the counter. A video can never
    // yield text; a gigantic scan must not be pulled whole into memory
    // (a 1 GB body-cam mp4 at the head of a live backfill queue once
    // OOM-killed every run).
    const plant = async (filename: string, contentType: string, sizeBytes: number) => {
      const file = await admin.query(
        `insert into deedbox.document_file (matter, filename, content_type, size_bytes, storage_ref, source, uploaded_by)
         values ($1, $2, $3, $4, $5, 'staff_upload', $6) returning id`,
        [fx.matter, filename, contentType, sizeBytes, `${fx.matter}/dtx-never-fetched-${filename}`, fx.staff],
      )
      const head = await admin.query(
        `insert into deedbox.document (matter, title, current_file, current_version, created_by)
         values ($1, $2, $3, 1, $4) returning id`,
        [fx.matter, filename, file.rows[0].id, fx.staff],
      )
      await admin.query(
        `insert into deedbox.document_version (document, version_no, file, created_by)
         values ($1, 1, $2, $3)`,
        [head.rows[0].id, file.rows[0].id, fx.staff],
      )
      return head.rows[0].id as number
    }
    const videoDoc = await plant('bodycam.mp4', 'application/mp4', 5_000)
    const hugeDoc = await plant('brief-scan.pdf', 'application/pdf', 500_000_000)
    const before = fetchCount
    const run = await runDocumentTextSweep(P)
    expect(run.skipped).toBeGreaterThanOrEqual(2)
    expect(fetchCount).toBe(before)
    for (const doc of [videoDoc, hugeDoc]) {
      const text = await admin.query(
        `select t.method, t.content from deedbox.document_version_text t
           join deedbox.document_version v on v.id = t.version
          where v.document = $1`,
        [doc],
      )
      expect(text.rows[0].method).toBe('none')
      expect(text.rows[0].content).toBe('')
    }
    const again = await runDocumentTextSweep(P)
    expect(again.skipped).toBe(0) // written exactly once — the queue moved on
  })

  it('soft deletion clears the search row', async () => {
    await softDeleteDocument(P, { document: wordDoc })
    const idx = await admin.query(
      `select count(*)::int as n from deedbox.search_index
        where entry_type='document' and source=$1`,
      [wordDoc],
    )
    expect(idx.rows[0].n).toBe(0)
  })
})
