// Predicate-governed reads for the documents module. Every query
// joins deedbox.matter, so the viewer's predicate governs what is served;
// soft-deleted documents are excluded everywhere except the detail's own
// restore banner.

import type { Principal } from '@/lib/db'
import { withPrincipal } from '@/lib/db'
import { listDocumentShares } from '@/lib/ops/documents/sharing'

export interface FolderRow {
  id: number
  parent: number | null
  name: string
}

export interface DocumentRow {
  id: number
  folder: number | null
  title: string
  currentVersion: number
  filename: string
  contentType: string
  sizeBytes: number
  documentDate: string | null
  confidential: boolean
  checkedOutBy: number | null
  checkedOutName: string | null
  locked: boolean
  legalHold: boolean
  createdAt: string
}

export interface ArrivalRow {
  id: number
  filename: string
  sizeBytes: number
  source: string
  uploadedAt: string
}

export async function matterDocumentsTab(
  p: Principal,
  matterId: number,
): Promise<{
  matter: { id: number; matterNumber: string; title: string; status: string }
  folders: FolderRow[]
  documents: DocumentRow[]
  arrivals: ArrivalRow[]
}> {
  return withPrincipal(
    p,
    async (tx) => {
      const m = await tx.query(
        `select id, matter_number, title, status from deedbox.matter where id = $1`,
        [matterId],
      )
      if (m.rowCount === 0) throw new Error('not_found')
      const folders = await tx.query(
        `select f.id, f.parent, f.name
           from deedbox.document_folder f
           join deedbox.matter m on m.id = f.matter
          where f.matter = $1
          order by f.name`,
        [matterId],
      )
      const documents = await tx.query(
        `select d.id, d.folder, d.title, d.current_version, d.document_date, d.confidential,
                d.checked_out_by, d.locked, d.legal_hold, d.created_at,
                df.filename, df.content_type, df.size_bytes,
                (s.person_name->>'given') || ' ' || (s.person_name->>'family') as checked_out_name
           from deedbox.document d
           join deedbox.matter m on m.id = d.matter
           join deedbox.document_file df on df.id = d.current_file
           left join deedbox.staff_member s on s.id = d.checked_out_by
          where d.matter = $1 and d.soft_deleted_at is null
          order by d.created_at desc`,
        [matterId],
      )
      const arrivals = await tx.query(
        `select df.id, df.filename, df.size_bytes, df.source, df.uploaded_at
           from deedbox.document_file df
           join deedbox.matter m on m.id = df.matter
          where df.matter = $1
            and not exists (select 1 from deedbox.document_version v where v.file = df.id)
            and not exists (select 1 from deedbox.document d where d.current_file = df.id)
          order by df.uploaded_at desc`,
        [matterId],
      )
      return {
        matter: {
          id: m.rows[0].id as number,
          matterNumber: m.rows[0].matter_number as string,
          title: m.rows[0].title as string,
          status: m.rows[0].status as string,
        },
        folders: folders.rows.map((f) => ({
          id: f.id as number,
          parent: f.parent as number | null,
          name: f.name as string,
        })),
        documents: documents.rows.map((d) => ({
          id: d.id as number,
          folder: d.folder as number | null,
          title: d.title as string,
          currentVersion: d.current_version as number,
          filename: d.filename as string,
          contentType: d.content_type as string,
          sizeBytes: Number(d.size_bytes),
          documentDate: d.document_date as string | null,
          confidential: d.confidential as boolean,
          checkedOutBy: d.checked_out_by as number | null,
          checkedOutName: d.checked_out_name as string | null,
          locked: d.locked as boolean,
          legalHold: d.legal_hold as boolean,
          createdAt: String(d.created_at),
        })),
        arrivals: arrivals.rows.map((a) => ({
          id: a.id as number,
          filename: a.filename as string,
          sizeBytes: Number(a.size_bytes),
          source: a.source as string,
          uploadedAt: String(a.uploaded_at),
        })),
      }
    },
    { readOnly: true },
  )
}

export interface VersionRow {
  versionNo: number
  filename: string
  contentType: string
  sizeBytes: number
  comment: string | null
  createdAt: string
  createdByName: string
  textMethod: string | null
  textChars: number | null
}

export interface AccessRow {
  actorKind: string
  actor: number
  action: string
  occurredAt: string
}

export async function documentDetail(
  p: Principal,
  documentId: number,
): Promise<{
  document: {
    id: number
    matter: number
    matterNumber: string
    matterTitle: string
    folder: number | null
    title: string
    description: string | null
    documentDate: string | null
    confidential: boolean
    currentVersion: number
    checkedOutBy: number | null
    checkedOutName: string | null
    checkoutPurpose: string | null
    locked: boolean
    legalHold: boolean
    softDeletedAt: string | null
    createdAt: string
  }
  versions: VersionRow[]
  access: AccessRow[]
  shares: {
    id: number
    recipient: string | null
    expiresAt: string
    viewCount: number
    maxViews: number | null
    revoked: boolean
  }[]
  signingRequests: {
    id: number
    signer: string
    status: string
    expiresAt: string
    signedAt: string | null
    signedDocument: number | null
  }[]
}> {
  return withPrincipal(
    p,
    async (tx) => {
      const d = await tx.query(
        `select d.id, d.matter, m.matter_number, m.title as matter_title, d.folder, d.title,
                d.description, d.document_date, d.confidential, d.current_version,
                d.checked_out_by, d.checkout_purpose, d.locked, d.legal_hold,
                d.soft_deleted_at, d.created_at,
                (s.person_name->>'given') || ' ' || (s.person_name->>'family') as checked_out_name
           from deedbox.document d
           join deedbox.matter m on m.id = d.matter
           left join deedbox.staff_member s on s.id = d.checked_out_by
          where d.id = $1`,
        [documentId],
      )
      if (d.rowCount === 0) throw new Error('not_found')
      const versions = await tx.query(
        `select v.version_no, v.comment, v.created_at,
                df.filename, df.content_type, df.size_bytes,
                t.method as text_method, t.char_count as text_chars,
                (s.person_name->>'given') || ' ' || (s.person_name->>'family') as created_by_name
           from deedbox.document_version v
           join deedbox.document_file df on df.id = v.file
           join deedbox.staff_member s on s.id = v.created_by
           left join deedbox.document_version_text t on t.version = v.id
          where v.document = $1
          order by v.version_no desc`,
        [documentId],
      )
      const access = await tx.query(
        `select actor_kind, actor, action, occurred_at
           from deedbox.document_access
          where document = $1
          order by occurred_at desc
          limit 50`,
        [documentId],
      )
      const shares = await listDocumentShares(tx, documentId)
      const signing = await tx.query(
        `select id, signer_name, signer_email, status, expires_at, signed_at, signed_document
           from deedbox.document_signing_request
          where document = $1 order by id desc`,
        [documentId],
      )
      const row = d.rows[0]
      return {
        document: {
          id: row.id as number,
          matter: row.matter as number,
          matterNumber: row.matter_number as string,
          matterTitle: row.matter_title as string,
          folder: row.folder as number | null,
          title: row.title as string,
          description: row.description as string | null,
          documentDate: row.document_date as string | null,
          confidential: row.confidential as boolean,
          currentVersion: row.current_version as number,
          checkedOutBy: row.checked_out_by as number | null,
          checkedOutName: row.checked_out_name as string | null,
          checkoutPurpose: row.checkout_purpose as string | null,
          locked: row.locked as boolean,
          legalHold: row.legal_hold as boolean,
          softDeletedAt: row.soft_deleted_at ? String(row.soft_deleted_at) : null,
          createdAt: String(row.created_at),
        },
        versions: versions.rows.map((v) => ({
          versionNo: v.version_no as number,
          filename: v.filename as string,
          contentType: v.content_type as string,
          sizeBytes: Number(v.size_bytes),
          comment: v.comment as string | null,
          createdAt: String(v.created_at),
          createdByName: v.created_by_name as string,
          textMethod: (v.text_method as string | null) ?? null,
          textChars: v.text_chars == null ? null : Number(v.text_chars),
        })),
        access: access.rows.map((a) => ({
          actorKind: a.actor_kind as string,
          actor: a.actor as number,
          action: a.action as string,
          occurredAt: String(a.occurred_at),
        })),
        shares,
        signingRequests: signing.rows.map((s) => ({
          id: s.id as number,
          signer: `${s.signer_name} <${s.signer_email}>`,
          status: s.status as string,
          expiresAt: String(s.expires_at),
          signedAt: s.signed_at ? String(s.signed_at) : null,
          signedDocument: s.signed_document as number | null,
        })),
      }
    },
    { readOnly: true },
  )
}

export interface TemplateListRow {
  id: number
  name: string
  category: string
  description: string | null
  practiceAreaName: string | null
  jurisdiction: string | null
  filename: string
  sizeBytes: number
  active: boolean
  createdAt: string
}

/** The settings screen's list — every template not soft-deleted. */
export async function documentTemplatesList(p: Principal): Promise<TemplateListRow[]> {
  return withPrincipal(
    p,
    async (tx) => {
      const r = await tx.query(
        `select t.id, t.name, t.category, t.description, t.jurisdiction, t.filename,
                t.size_bytes, t.active, t.created_at, pa.name as practice_area_name
           from deedbox.document_template t
           left join deedbox.practice_area pa on pa.id = t.practice_area
          where t.soft_deleted_at is null
          order by t.category, t.name`,
      )
      return r.rows.map((t) => ({
        id: t.id as number,
        name: t.name as string,
        category: t.category as string,
        description: t.description as string | null,
        practiceAreaName: t.practice_area_name as string | null,
        jurisdiction: t.jurisdiction as string | null,
        filename: t.filename as string,
        sizeBytes: Number(t.size_bytes),
        active: t.active as boolean,
        createdAt: String(t.created_at),
      }))
    },
    { readOnly: true },
  )
}

/** The matter tab's generate picker — active templates only. */
export async function activeDocumentTemplates(
  p: Principal,
): Promise<{ id: number; name: string; category: string }[]> {
  return withPrincipal(
    p,
    async (tx) => {
      const r = await tx.query(
        `select id, name, category from deedbox.document_template
          where active and soft_deleted_at is null
          order by category, name`,
      )
      return r.rows.map((t) => ({
        id: t.id as number,
        name: t.name as string,
        category: t.category as string,
      }))
    },
    { readOnly: true },
  )
}

/** The compare screen's two texts. */
export async function compareVersions(
  p: Principal,
  documentId: number,
  a: number,
  b: number,
): Promise<{
  document: { id: number; title: string; matter: number }
  a: { versionNo: number; text: string; method: string } | null
  b: { versionNo: number; text: string; method: string } | null
}> {
  return withPrincipal(
    p,
    async (tx) => {
      const d = await tx.query(
        `select d.id, d.title, d.matter
           from deedbox.document d join deedbox.matter m on m.id = d.matter
          where d.id = $1`,
        [documentId],
      )
      if (d.rowCount === 0) throw new Error('not_found')
      const texts = await tx.query(
        `select v.version_no, t.content, t.method
           from deedbox.document_version v
           left join deedbox.document_version_text t on t.version = v.id
          where v.document = $1 and v.version_no = any($2::int[])`,
        [documentId, [a, b]],
      )
      const pick = (no: number) => {
        const r = texts.rows.find((x) => x.version_no === no)
        return r
          ? { versionNo: no, text: (r.content as string | null) ?? '', method: (r.method as string | null) ?? 'pending' }
          : null
      }
      return {
        document: {
          id: d.rows[0].id as number,
          title: d.rows[0].title as string,
          matter: d.rows[0].matter as number,
        },
        a: pick(a),
        b: pick(b),
      }
    },
    { readOnly: true },
  )
}
