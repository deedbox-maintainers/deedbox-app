// Documents module — folders. Matter-scoped organisation: create, rename,
// move, and delete-when-empty (documents.manage). The schema guards the
// tree (same matter, no cycles, unique names, occupied folders refuse
// deletion); these operations sequence, check visibility through the
// matter predicate, and register every act.

import type { Principal, Tx } from '@/lib/db'
import { withPrincipal, emitRegister, OperationRefused } from '@/lib/db'
import { requireStaff, requireCapability } from '@/lib/ops/shared'

async function loadFolder(tx: Tx, id: number) {
  const r = await tx.query(
    `select f.id, f.matter, f.parent, f.name
       from deedbox.document_folder f
       join deedbox.matter m on m.id = f.matter
      where f.id = $1`,
    [id],
  )
  if (r.rowCount === 0) throw new OperationRefused('not_found', 'no folder by that id')
  return r.rows[0] as { id: number; matter: number; parent: number | null; name: string }
}

export async function createFolder(
  p: Principal,
  input: { matter: number; parent?: number | null; name: string },
): Promise<{ folder: number }> {
  requireStaff(p)
  return withPrincipal(p, async (tx) => {
    const m = await tx.query(`select id from deedbox.matter where id = $1`, [input.matter])
    if (m.rowCount === 0) throw new OperationRefused('not_found', 'no matter by that id')
    const row = await tx.query(
      `insert into deedbox.document_folder (matter, parent, name, created_by)
       values ($1, $2, $3, $4) returning id`,
      [input.matter, input.parent ?? null, input.name.trim(), p.id],
    )
    const folder = row.rows[0].id as number
    await emitRegister(tx, p, {
      kind: 'record.created',
      subjectType: 'document_folder',
      subject: folder,
      detail: { matter: input.matter, parent: input.parent ?? null, name: input.name.trim() },
    })
    return { folder }
  })
}

export async function renameFolder(
  p: Principal,
  input: { folder: number; name: string },
): Promise<void> {
  requireStaff(p)
  await withPrincipal(p, async (tx) => {
    const f = await loadFolder(tx, input.folder)
    await tx.query(`update deedbox.document_folder set name = $2 where id = $1`, [
      input.folder,
      input.name.trim(),
    ])
    await emitRegister(tx, p, {
      kind: 'record.changed',
      subjectType: 'document_folder',
      subject: input.folder,
      detail: { before: { name: f.name }, after: { name: input.name.trim() } },
    })
  })
}

export async function moveFolder(
  p: Principal,
  input: { folder: number; parent: number | null },
): Promise<void> {
  requireStaff(p)
  await withPrincipal(p, async (tx) => {
    const f = await loadFolder(tx, input.folder)
    await tx.query(`update deedbox.document_folder set parent = $2 where id = $1`, [
      input.folder,
      input.parent,
    ])
    await emitRegister(tx, p, {
      kind: 'record.changed',
      subjectType: 'document_folder',
      subject: input.folder,
      detail: { before: { parent: f.parent }, after: { parent: input.parent } },
    })
  })
}

/** Hard delete, allowed by policy ONLY for empty folders (schema-guarded). */
export async function deleteEmptyFolder(p: Principal, input: { folder: number }): Promise<void> {
  requireStaff(p)
  await withPrincipal(p, async (tx) => {
    await requireCapability(tx, p, 'documents.manage')
    const f = await loadFolder(tx, input.folder)
    try {
      await tx.query(`delete from deedbox.document_folder where id = $1`, [input.folder])
    } catch (e) {
      if (e instanceof Error && /contains/.test(e.message)) {
        throw new OperationRefused('folder_not_empty', 'the folder still has contents')
      }
      throw e
    }
    await emitRegister(tx, p, {
      kind: 'record.changed',
      subjectType: 'document_folder',
      subject: input.folder,
      detail: { before: { name: f.name, matter: f.matter }, after: { deleted: true } },
    })
  })
}
