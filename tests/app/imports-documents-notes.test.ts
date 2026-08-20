// The documents and file-notes import routes: folders (structure is a
// record too), documents with real version chains referencing ALREADY-COPIED
// bytes, and notes carrying their historical author. Proven through the REAL
// batch engine: validate-only leaves nothing, dry and real agree record for
// record, re-runs never duplicate history, closed matters accept their
// archive, unresolvable people refuse typed, and the all-or-nothing reversal
// soft-deletes content while folders honestly stand.
//
// Cross-suite contract: flips NO settings; everything lands on this
// fixture's own matters. Fixture tag 'idn' (first-three unique).

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import type { Pool } from 'pg'
import { closePool } from '@/lib/db'
import type { Principal } from '@/lib/db'
import { runImportBatch, reverseImportBatch } from '@/lib/ops/imports'
import { makeAdminPool, buildFixture, type Fixture } from './helpers'

let admin: Pool
let fx: Fixture
let P: Principal
let staffLogin = ''
let officeCode = ''
let practiceArea = ''
let closedMatterId = 0

const SRC = 'idn-old-system'

beforeAll(async () => {
  admin = makeAdminPool()
  fx = await buildFixture(admin, 'idn')
  P = { kind: 'staff', id: fx.staff, firm: fx.firm }
  const s = await admin.query(
    `select s.login, o.code, pa.name as pa
       from deedbox.staff_member s
       join deedbox.office o on o.id = $2
       join deedbox.practice_area pa on pa.id = $3
      where s.id = $1`,
    [fx.staff, fx.office, fx.practiceArea],
  )
  staffLogin = s.rows[0].login as string
  officeCode = s.rows[0].code as string
  practiceArea = s.rows[0].pa as string
  // an imported CLOSED matter — the archive case documents must land on
  const closed = await runImportBatch(
    P,
    {
      recordDomain: 'matters',
      sourceSystem: SRC,
      records: [
        {
          source_ref: 'idn-m-closed',
          data: {
            title: 'Imported closed matter idn',
            client_party: fx.clientParty,
            responsible_lawyer_login: staffLogin,
            office_code: officeCode,
            practice_area_name: practiceArea,
            status: 'closed',
            close_note: 'closed in the source system',
          },
        },
      ],
    },
    { mode: 'real' },
  )
  expect(closed.counts.accepted).toBe(1)
  const m = await admin.query(
    `select id from deedbox.matter where title = 'Imported closed matter idn'`,
  )
  closedMatterId = m.rows[0].id as number
})

afterAll(async () => {
  await closePool()
  await admin.end()
})

const folderRecords = () => [
  {
    source_ref: 'idn-f-1',
    data: { record_kind: 'folder', matter: 0, path: 'Correspondence' },
  },
  {
    source_ref: 'idn-f-2',
    data: { record_kind: 'folder', matter: 0, path: 'Correspondence/Inbound' },
  },
  {
    source_ref: 'idn-f-3',
    data: { record_kind: 'folder', matter: 0, path: 'Court documents' },
  },
]

describe('the documents and notes import routes', () => {
  it('documents: validate-only leaves not one row behind', async () => {
    const before = await admin.query(
      `select (select count(*)::int from deedbox.document_folder where matter = $1) as folders,
              (select count(*)::int from deedbox.document where matter = $1) as docs,
              (select count(*)::int from deedbox.document_file where matter = $1) as files`,
      [fx.matter],
    )
    const records = folderRecords().map((r) => ({
      ...r,
      data: { ...r.data, matter: fx.matter },
    }))
    records.push({
      source_ref: 'idn-d-dry',
      data: {
        record_kind: 'document',
        matter: fx.matter,
        folder_path: 'Correspondence/Inbound',
        title: 'Dry-run letter',
        versions: [
          {
            filename: 'letter.pdf',
            size_bytes: 1000,
            storage_ref: 'idn/dry/letter.pdf',
          },
        ],
      } as never,
    })
    const dry = await runImportBatch(
      P,
      { recordDomain: 'documents', sourceSystem: SRC, records },
      { mode: 'validate_only' },
    )
    expect(dry.state).toBe('completed')
    expect(dry.outcomes.every((o) => o.disposition === 'accepted')).toBe(true)
    const after = await admin.query(
      `select (select count(*)::int from deedbox.document_folder where matter = $1) as folders,
              (select count(*)::int from deedbox.document where matter = $1) as docs,
              (select count(*)::int from deedbox.document_file where matter = $1) as files`,
      [fx.matter],
    )
    expect(after.rows[0]).toEqual(before.rows[0])
  })

  it('documents: folders, a two-version chain, historical dates and text land; dry and real agree', async () => {
    const records = [
      ...folderRecords().map((r) => ({ ...r, data: { ...r.data, matter: closedMatterId } })),
      {
        source_ref: 'idn-d-1',
        data: {
          record_kind: 'document',
          matter: closedMatterId,
          folder_path: 'Correspondence/Inbound',
          title: 'Letter from the other side',
          description: 'imported letter',
          document_date: '2026-02-10',
          created_by_login: staffLogin,
          created_at: '2026-02-10T03:00:00Z',
          versions: [
            {
              filename: 'letter-v1.pdf',
              content_type: 'application/pdf',
              size_bytes: 111,
              storage_ref: 'idn/letter-v1.pdf',
              uploaded_at: '2026-02-10T03:00:00Z',
              extracted_text: 'Version one text, superseded later.',
            },
            {
              filename: 'letter-v2.pdf',
              content_type: 'application/pdf',
              size_bytes: 222,
              storage_ref: 'idn/letter-v2.pdf',
              uploaded_at: '2026-03-01T03:00:00Z',
              comment: 'superseded in the source system',
              extracted_text: 'Dear colleagues, the quick brown fox idnsearchtoken.',
            },
          ],
        } as never,
      },
      {
        source_ref: 'idn-d-2',
        data: {
          record_kind: 'document',
          matter: closedMatterId,
          title: 'Unfiled memo',
          versions: [
            { filename: 'memo.docx', size_bytes: 333, storage_ref: 'idn/memo.docx' },
          ],
        } as never,
      },
    ]
    const dry = await runImportBatch(
      P,
      { recordDomain: 'documents', sourceSystem: SRC, records },
      { mode: 'validate_only' },
    )
    expect(dry.state).toBe('completed')
    const real = await runImportBatch(
      P,
      { recordDomain: 'documents', sourceSystem: SRC, records },
      { mode: 'real' },
    )
    expect(real.state).toBe('completed')
    const dryD = dry.outcomes.map((o) => o.disposition)
    const realD = real.outcomes.map((o) => o.disposition)
    if (JSON.stringify(dryD) !== JSON.stringify(realD)) {
      // eslint-disable-next-line no-console
      console.log('DRY OUTCOMES:', JSON.stringify(dry.outcomes, null, 1))
      // eslint-disable-next-line no-console
      console.log('REAL OUTCOMES:', JSON.stringify(real.outcomes, null, 1))
    }
    expect(realD).toEqual(dryD)
    expect(real.counts.accepted).toBe(5)

    // the folder tree is real, nested, and once each
    const folders = await admin.query(
      `select name, parent from deedbox.document_folder where matter = $1 order by id`,
      [closedMatterId],
    )
    expect(folders.rows.map((r) => r.name)).toEqual([
      'Correspondence',
      'Inbound',
      'Court documents',
    ])
    expect(folders.rows[1].parent).not.toBeNull()

    // the version chain: dense, current is v2, dates are the source's own
    const doc = await admin.query(
      `select d.id, d.current_version, d.created_at, f.filename, f.uploaded_at, f.source
         from deedbox.document d join deedbox.document_file f on f.id = d.current_file
        where d.matter = $1 and d.title = 'Letter from the other side'`,
      [closedMatterId],
    )
    expect(doc.rowCount).toBe(1)
    expect(doc.rows[0].current_version).toBe(2)
    expect(doc.rows[0].filename).toBe('letter-v2.pdf')
    expect(doc.rows[0].source).toBe('import')
    expect(String(doc.rows[0].created_at)).toContain('2026')
    const versions = await admin.query(
      `select version_no from deedbox.document_version where document = $1 order by version_no`,
      [doc.rows[0].id],
    )
    expect(versions.rows.map((r) => r.version_no)).toEqual([1, 2])

    // the CURRENT version's text feeds search
    const text = await admin.query(
      `select t.content from deedbox.document_version_text t
         join deedbox.document_version v on v.id = t.version
        where v.document = $1 and v.version_no = 2`,
      [doc.rows[0].id],
    )
    expect(text.rowCount).toBe(1)
    expect(text.rows[0].content).toContain('idnsearchtoken')
  })

  it('documents: a re-run duplicates nothing', async () => {
    const records = [
      {
        source_ref: 'idn-d-2',
        data: {
          record_kind: 'document',
          matter: closedMatterId,
          title: 'Unfiled memo',
          versions: [
            { filename: 'memo.docx', size_bytes: 333, storage_ref: 'idn/memo.docx' },
          ],
        } as never,
      },
    ]
    const again = await runImportBatch(
      P,
      { recordDomain: 'documents', sourceSystem: SRC, records },
      { mode: 'real' },
    )
    expect(again.counts.accepted_with_warning).toBe(1)
    const docs = await admin.query(
      `select count(*)::int as n from deedbox.document where matter = $1 and title = 'Unfiled memo'`,
      [closedMatterId],
    )
    expect(docs.rows[0].n).toBe(1)
  })

  it('notes: land with their historical author and time; unknown author stays honestly null', async () => {
    const records = [
      {
        source_ref: 'idn-n-1',
        data: {
          matter: closedMatterId,
          body: 'Called the client about the hearing. idnnotetoken',
          noted_at: '2026-01-05T02:00:00Z',
          author_login: staffLogin,
        },
      },
      {
        source_ref: 'idn-n-2',
        data: {
          matter: closedMatterId,
          body: 'System-generated note with no recorded author.',
          noted_at: '2026-01-06T02:00:00Z',
        },
      },
    ]
    const dry = await runImportBatch(
      P,
      { recordDomain: 'notes', sourceSystem: SRC, records },
      { mode: 'validate_only' },
    )
    expect(dry.state).toBe('completed')
    const real = await runImportBatch(
      P,
      { recordDomain: 'notes', sourceSystem: SRC, records },
      { mode: 'real' },
    )
    expect(real.counts.accepted).toBe(2)
    expect(real.outcomes.map((o) => o.disposition)).toEqual(
      dry.outcomes.map((o) => o.disposition),
    )
    const notes = await admin.query(
      `select body, author, noted_at from deedbox.note
        where owner_type = 'matter' and owner = $1 order by noted_at`,
      [closedMatterId],
    )
    expect(notes.rowCount).toBe(2)
    expect(notes.rows[0].author).toBe(fx.staff)
    expect(String(notes.rows[0].noted_at)).toContain('2026')
    expect(notes.rows[1].author).toBeNull()
  })

  it('notes: a named-but-unknown author refuses typed', async () => {
    const r = await runImportBatch(
      P,
      {
        recordDomain: 'notes',
        sourceSystem: SRC,
        records: [
          {
            source_ref: 'idn-n-bad',
            data: { matter: closedMatterId, body: 'orphan author', author_login: 'nobody.idn' },
          },
        ],
      },
      { mode: 'real' },
    )
    expect(r.counts.refused).toBe(1)
    expect(r.outcomes[0].message).toContain('no staff member with login nobody.idn')
  })

  it('reversal: notes delete, documents soft-delete, folders honestly stand', async () => {
    // a fresh, self-contained batch on the OPEN fixture matter
    const records = [
      {
        source_ref: 'idn-rev-f',
        data: { record_kind: 'folder', matter: fx.matter, path: 'Reversal test' } as never,
      },
      {
        source_ref: 'idn-rev-d',
        data: {
          record_kind: 'document',
          matter: fx.matter,
          folder_path: 'Reversal test',
          title: 'Reversible document',
          versions: [
            { filename: 'rev.pdf', size_bytes: 10, storage_ref: 'idn/rev.pdf' },
          ],
        } as never,
      },
    ]
    const docs = await runImportBatch(
      P,
      { recordDomain: 'documents', sourceSystem: SRC, records },
      { mode: 'real' },
    )
    expect(docs.state).toBe('completed')
    const noteBatch = await runImportBatch(
      P,
      {
        recordDomain: 'notes',
        sourceSystem: SRC,
        records: [
          { source_ref: 'idn-rev-n', data: { matter: fx.matter, body: 'reversible note' } },
        ],
      },
      { mode: 'real' },
    )
    expect(noteBatch.state).toBe('completed')

    const revDocs = await reverseImportBatch(P, {
      batch: docs.batch,
      reason: 'rehearsal reversal test',
    })
    expect(revDocs.state).toBe('reversed')
    const revNotes = await reverseImportBatch(P, {
      batch: noteBatch.batch,
      reason: 'rehearsal reversal test',
    })
    expect(revNotes.state).toBe('reversed')

    const d = await admin.query(
      `select soft_deleted_at from deedbox.document where matter = $1 and title = 'Reversible document'`,
      [fx.matter],
    )
    expect(d.rows[0].soft_deleted_at).not.toBeNull()
    const n = await admin.query(
      `select deleted_at from deedbox.note where owner_type = 'matter' and owner = $1 and body = 'reversible note'`,
      [fx.matter],
    )
    expect(n.rows[0].deleted_at).not.toBeNull()
    const f = await admin.query(
      `select count(*)::int as n from deedbox.document_folder where matter = $1 and name = 'Reversal test'`,
      [fx.matter],
    )
    expect(f.rows[0].n).toBe(1)
  })
})
