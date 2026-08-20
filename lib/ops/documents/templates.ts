// Document templates (schema change 0031): firm-uploaded Word
// templates with merge fields, administered under templates.manage, and
// the generation operation that renders one onto a matter as an ordinary
// document (source template_generation). Bytes live on the platform store
// under the templates/ prefix; generation fetches them back through the
// byte-fetch seam.

import type { Principal, Tx } from '@/lib/db'
import { withPrincipal, emitRegister, OperationRefused } from '@/lib/db'
import { requireStaff, requireCapability } from '@/lib/ops/shared'
import { requireByteStore, requireByteFetch } from './store'
import { createDocumentWithFileInTx } from './documents'
import { extractText } from './extract'
import { buildMergeData, renderTemplate } from './merge'

interface TemplateRow {
  id: number
  name: string
  category: string
  description: string | null
  practice_area: number | null
  jurisdiction: string | null
  filename: string
  storage_ref: string
  active: boolean
  soft_deleted_at: string | null
}

async function loadTemplate(tx: Tx, id: number): Promise<TemplateRow> {
  const r = await tx.query(
    `select id, name, category, description, practice_area, jurisdiction,
            filename, storage_ref, active, soft_deleted_at
       from deedbox.document_template where id = $1`,
    [id],
  )
  if (r.rowCount === 0) throw new OperationRefused('not_found', 'no template by that id')
  return r.rows[0] as TemplateRow
}

export async function uploadDocumentTemplate(
  p: Principal,
  input: {
    name: string
    filename: string
    bytes: Buffer
    category?: string
    description?: string
    practiceArea?: number | null
    jurisdiction?: string | null
  },
): Promise<{ template: number }> {
  requireStaff(p)
  const store = requireByteStore()
  return withPrincipal(p, async (tx) => {
    await requireCapability(tx, p, 'templates.manage')
    const stored = await store({ matter: null, filename: input.filename, bytes: input.bytes })
    const row = await tx.query(
      `insert into deedbox.document_template
         (name, category, description, practice_area, jurisdiction, filename, storage_ref, size_bytes, created_by)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9) returning id`,
      [
        input.name.trim(),
        input.category?.trim() || 'General',
        input.description ?? null,
        input.practiceArea ?? null,
        input.jurisdiction ?? null,
        input.filename,
        stored.storageRef,
        input.bytes.length,
        p.id,
      ],
    )
    const id = row.rows[0].id as number
    await emitRegister(tx, p, {
      kind: 'record.created',
      subjectType: 'document_template',
      subject: id,
      detail: { name: input.name.trim(), filename: input.filename },
    })
    return { template: id }
  })
}

export async function editDocumentTemplate(
  p: Principal,
  input: {
    template: number
    name?: string
    category?: string
    description?: string | null
    practiceArea?: number | null
    jurisdiction?: string | null
    active?: boolean
  },
): Promise<void> {
  requireStaff(p)
  await withPrincipal(p, async (tx) => {
    await requireCapability(tx, p, 'templates.manage')
    const t = await loadTemplate(tx, input.template)
    if (t.soft_deleted_at) throw new OperationRefused('not_found', 'no template by that id')
    const next = {
      name: input.name !== undefined ? input.name.trim() : t.name,
      category: input.category !== undefined ? input.category.trim() || 'General' : t.category,
      description: input.description !== undefined ? input.description : t.description,
      practiceArea: input.practiceArea !== undefined ? input.practiceArea : t.practice_area,
      jurisdiction: input.jurisdiction !== undefined ? input.jurisdiction : t.jurisdiction,
      active: input.active !== undefined ? input.active : t.active,
    }
    await tx.query(
      `update deedbox.document_template
          set name = $2, category = $3, description = $4, practice_area = $5,
              jurisdiction = $6, active = $7, updated_by = $8
        where id = $1`,
      [
        input.template,
        next.name,
        next.category,
        next.description,
        next.practiceArea,
        next.jurisdiction,
        next.active,
        p.id,
      ],
    )
    await emitRegister(tx, p, {
      kind: 'record.changed',
      subjectType: 'document_template',
      subject: input.template,
      detail: {
        before: { name: t.name, active: t.active },
        after: { name: next.name, active: next.active },
      },
    })
  })
}

export async function softDeleteDocumentTemplate(
  p: Principal,
  input: { template: number },
): Promise<void> {
  requireStaff(p)
  await withPrincipal(p, async (tx) => {
    await requireCapability(tx, p, 'templates.manage')
    const t = await loadTemplate(tx, input.template)
    if (t.soft_deleted_at) return
    await tx.query(
      `update deedbox.document_template
          set active = false, soft_deleted_at = now(), soft_deleted_by = $2, updated_by = $2
        where id = $1`,
      [input.template, p.id],
    )
    await emitRegister(tx, p, {
      kind: 'record.soft_deleted',
      subjectType: 'document_template',
      subject: input.template,
      detail: { name: t.name },
    })
  })
}

/** Render an ACTIVE template onto a matter as a new document. */
export async function generateFromTemplate(
  p: Principal,
  input: { template: number; matter: number; folder?: number | null },
): Promise<{ document: number }> {
  requireStaff(p)
  const fetcher = requireByteFetch()
  const store = requireByteStore()
  return withPrincipal(p, async (tx) => {
    const t = await loadTemplate(tx, input.template)
    if (t.soft_deleted_at) throw new OperationRefused('not_found', 'no template by that id')
    if (!t.active) {
      throw new OperationRefused('template_inactive', 'only an active template generates')
    }
    const m = await tx.query(
      `select m.matter_number, m.status, f.timezone
         from deedbox.matter m, deedbox.firm f
        where m.id = $1 and f.id = $2`,
      [input.matter, p.firm],
    )
    if (m.rowCount === 0) throw new OperationRefused('not_found', 'no matter by that id')
    if (m.rows[0].status === 'closed' || m.rows[0].status === 'archived') {
      throw new OperationRefused('matter_closed', 'the matter is closed — documents are read-only')
    }
    const matterNumber = m.rows[0].matter_number as string
    const timezone = m.rows[0].timezone as string

    const template = await fetcher(t.storage_ref)
    const data = await buildMergeData(tx, input.matter, timezone)
    const rendered = renderTemplate(template.bytes, data)

    const safeName = t.name.replace(/[^a-zA-Z0-9 _-]/g, '_')
    const safeNumber = matterNumber.replace(/[^a-zA-Z0-9_-]/g, '_')
    const outName = `${safeName} - ${safeNumber}.docx`
    const stored = await store({ matter: input.matter, filename: outName, bytes: rendered })
    const created = await createDocumentWithFileInTx(tx, p, {
      matter: input.matter,
      folder: input.folder ?? null,
      filename: outName,
      contentType:
        'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      sizeBytes: rendered.length,
      storageRef: stored.storageRef,
      source: 'template_generation',
      title: `${t.name} — ${matterNumber}`,
      description: `Generated from template: ${t.name}`,
      extracted: await extractText(rendered, outName, 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'),
    })
    return { document: created.document }
  })
}
