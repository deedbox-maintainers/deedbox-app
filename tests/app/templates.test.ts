// Document templates + generation (schema change 0031): the template
// lifecycle under templates.manage, the byte-fetch seam, and the
// generation flow — a real Word file rendered with the preferred merge
// vocabulary (Matter.Summary, Matter.ResponsibleLawyer.*) AND the
// deprecated aliases (Matter.CustomField.CostAgreementScopeOfWorks,
// Matter.ResponsibleAttorney.*, Address.ZipCode), landing on the matter as
// an ordinary document with source template_generation.
//
// Cross-suite contract: binds its OWN fake byte store + fetch (a shared
// in-memory map) and unbinds both in afterAll. Flips no settings. Fixture
// tag 'tpl' (first-three unique).

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import type { Pool } from 'pg'
import PizZip from 'pizzip'
import { closePool } from '@/lib/db'
import type { Principal } from '@/lib/db'
import {
  setDocumentByteStore,
  setDocumentByteFetch,
  uploadDocumentTemplate,
  editDocumentTemplate,
  softDeleteDocumentTemplate,
  generateFromTemplate,
} from '@/lib/ops/documents'
import { documentTemplatesList, activeDocumentTemplates, documentDetail } from '@/lib/reads/documents'
import { makeAdminPool, buildFixture, type Fixture } from './helpers'

let admin: Pool
let fx: Fixture
let P: Principal
const stored = new Map<string, Buffer>()
let putCount = 0

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

function extractText(docx: Buffer): string {
  const zip = new PizZip(docx)
  const xml = zip.file('word/document.xml')?.asText() ?? ''
  return xml
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

beforeAll(async () => {
  admin = makeAdminPool()
  fx = await buildFixture(admin, 'tpl')
  P = { kind: 'staff', id: fx.staff, firm: fx.firm }
  setDocumentByteStore(async ({ matter, filename, bytes }) => {
    const storageRef = `${matter ?? 'templates'}/tpl-${++putCount}-${filename}`
    stored.set(storageRef, bytes)
    return { storageRef, contentType: 'application/octet-stream' }
  })
  setDocumentByteFetch(async (storageRef) => {
    const bytes = stored.get(storageRef)
    if (!bytes) throw new Error(`no stored object at ${storageRef}`)
    return { bytes, contentType: 'application/octet-stream' }
  })
  // the client's contact details and address feed the merge fields
  await admin.query(
    `insert into deedbox.contact_point (party, kind, value, is_primary)
     values ($1, 'email', 'tpl.client@example.test', true)`,
    [fx.clientParty],
  )
  await admin.query(
    `insert into deedbox.postal_address (party, kind, lines, locality, region, postcode)
     values ($1, 'postal', '1 Test Street', 'Testville', 'NSW', '2000')`,
    [fx.clientParty],
  )
  await admin.query(`update deedbox.matter set summary = 'Advice on the tpl dispute' where id = $1`, [
    fx.matter,
  ])
})

afterAll(async () => {
  setDocumentByteStore(null)
  setDocumentByteFetch(null)
  await closePool()
  await admin.end()
})

describe('document templates and generation', () => {
  let template = 0

  it('upload, list, activate — writes gated on templates.manage', async () => {
    const body =
      'Matter << Matter.Number >> for << Matter.Client.Name >>. ' +
      'Summary: << Matter.Summary >>. Lawyer: << Matter.ResponsibleLawyer.Name >>. ' +
      'Old tags: << Matter.CustomField.CostAgreementScopeOfWorks >> / ' +
      '<< Matter.ResponsibleAttorney.Name >> / << Matter.Client.Address.ZipCode >>. ' +
      'Postcode: << Matter.Client.Address.Postcode >>. Date: << Date.Verbose >>. ' +
      'Missing: << Matter.Client.Address.Country >>.'
    const r = await uploadDocumentTemplate(P, {
      name: 'Engagement letter',
      filename: 'engagement.docx',
      bytes: makeDocx(body),
      category: 'Letters',
      jurisdiction: 'NSW',
    })
    template = r.template
    const list = await documentTemplatesList(P)
    const row = list.find((t) => t.id === template)
    expect(row?.active).toBe(false)
    // inactive templates never generate
    await expect(
      generateFromTemplate(P, { template, matter: fx.matter }),
    ).rejects.toMatchObject({ code: 'template_inactive' })
    await editDocumentTemplate(P, { template, active: true })
    const active = await activeDocumentTemplates(P)
    expect(active.some((t) => t.id === template)).toBe(true)
  })

  it('generation renders the preferred tags AND the deprecated aliases, landing as a document', async () => {
    const r = await generateFromTemplate(P, { template, matter: fx.matter })
    const detail = await documentDetail(P, r.document)
    expect(detail.document.title).toContain('Engagement letter')
    expect(detail.versions.length).toBe(1)

    const file = await admin.query(
      `select df.storage_ref, df.source, df.content_type
         from deedbox.document d join deedbox.document_file df on df.id = d.current_file
        where d.id = $1`,
      [r.document],
    )
    expect(file.rows[0].source).toBe('template_generation')
    const rendered = stored.get(file.rows[0].storage_ref as string)
    expect(rendered).toBeDefined()
    const text = extractText(rendered as Buffer)

    const matterNumber = (
      await admin.query(`select matter_number from deedbox.matter where id = $1`, [fx.matter])
    ).rows[0].matter_number as string
    expect(text).toContain(matterNumber)
    // preferred tags
    expect(text).toContain('Summary: Advice on the tpl dispute')
    // deprecated aliases render the SAME values
    expect(text).toContain('Old tags: Advice on the tpl dispute')
    expect(text).toContain('/ 2000.')
    expect(text).toContain('Postcode: 2000')
    // the responsible lawyer renders under both spellings
    const lawyer = (
      await admin.query(
        `select (person_name->>'given') || ' ' || (person_name->>'family') as n
           from deedbox.staff_member where id = $1`,
        [fx.staff],
      )
    ).rows[0].n as string
    expect(text).toContain(`Lawyer: ${lawyer}`)
    expect(text).toContain(`/ ${lawyer} /`)
    // a date rendered; a genuinely-missing field rendered blank, not "undefined"
    expect(text).toMatch(/Date: \d{1,2} [A-Z][a-z]+ \d{4}/)
    expect(text).toContain('Missing: .')
    expect(text).not.toContain('undefined')
  })

  it('a deleted template refuses generation and leaves the picker', async () => {
    await softDeleteDocumentTemplate(P, { template })
    await expect(
      generateFromTemplate(P, { template, matter: fx.matter }),
    ).rejects.toMatchObject({ code: 'not_found' })
    const active = await activeDocumentTemplates(P)
    expect(active.some((t) => t.id === template)).toBe(false)
    const list = await documentTemplatesList(P)
    expect(list.some((t) => t.id === template)).toBe(false)
  })

  it('a malformed template refuses typed, not with a crash', async () => {
    const bad = await uploadDocumentTemplate(P, {
      name: 'Broken',
      filename: 'broken.docx',
      bytes: Buffer.from('this is not a zip'),
    })
    await editDocumentTemplate(P, { template: bad.template, active: true })
    await expect(
      generateFromTemplate(P, { template: bad.template, matter: fx.matter }),
    ).rejects.toMatchObject({ code: 'template_render_failed' })
  })
})
