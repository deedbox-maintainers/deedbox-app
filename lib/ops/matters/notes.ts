// Notes. The corpus row is trigger-synced; no reason
// is demanded on soft-delete or restore.

import type { Principal } from '@/lib/db'
import { withPrincipal, emitRegister, OperationRefused } from '@/lib/db'
import { requireStaff } from '@/lib/ops/shared'

export type NoteOwner = 'matter' | 'intake_record' | 'party'

export async function createNote(
  p: Principal,
  input: { ownerType: NoteOwner; owner: number; body: string; notedAt?: string },
): Promise<{ id: number }> {
  requireStaff(p)
  if (!input.body.trim()) throw new OperationRefused('body_required', 'a note needs text')
  return withPrincipal(p, async (tx) => {
    const r = await tx.query(
      `insert into deedbox.note (owner_type, owner, body, noted_at, author)
       values ($1, $2, $3, coalesce($4::timestamptz, now()), $5) returning id`,
      [input.ownerType, input.owner, input.body, input.notedAt ?? null, p.id],
    )
    const id = r.rows[0].id as number
    await emitRegister(tx, p, {
      kind: 'record.created',
      subjectType: 'note',
      subject: id,
      matter: input.ownerType === 'matter' ? input.owner : undefined,
    })
    return { id }
  })
}

export async function editNote(
  p: Principal,
  input: { note: number; body: string },
): Promise<void> {
  requireStaff(p)
  if (!input.body.trim()) throw new OperationRefused('body_required', 'a note needs text')
  await withPrincipal(p, async (tx) => {
    const cur = await tx.query(
      `select owner_type, owner, body from deedbox.note
        where id = $1 and deleted_at is null for update`,
      [input.note],
    )
    if (cur.rowCount === 0) throw new OperationRefused('not_found', 'note not found')
    await tx.query(`update deedbox.note set body = $2 where id = $1`, [input.note, input.body])
    await emitRegister(tx, p, {
      kind: 'record.changed',
      subjectType: 'note',
      subject: input.note,
      matter: cur.rows[0].owner_type === 'matter' ? (cur.rows[0].owner as number) : undefined,
      detail: { before: { body: cur.rows[0].body }, after: { body: input.body } },
    })
  })
}

export async function softDeleteNote(p: Principal, input: { note: number }): Promise<void> {
  requireStaff(p)
  await withPrincipal(p, async (tx) => {
    const r = await tx.query(
      `update deedbox.note set deleted_at = now(), deleted_by = $2
        where id = $1 and deleted_at is null
        returning owner_type, owner`,
      [input.note, p.id],
    )
    if (r.rowCount === 0) throw new OperationRefused('not_found', 'note not found')
    await emitRegister(tx, p, {
      kind: 'record.soft_deleted',
      subjectType: 'note',
      subject: input.note,
      matter: r.rows[0].owner_type === 'matter' ? (r.rows[0].owner as number) : undefined,
    })
  })
}

export async function restoreNote(p: Principal, input: { note: number }): Promise<void> {
  requireStaff(p)
  await withPrincipal(p, async (tx) => {
    const r = await tx.query(
      `update deedbox.note set deleted_at = null, deleted_by = null
        where id = $1 and deleted_at is not null
        returning owner_type, owner`,
      [input.note],
    )
    if (r.rowCount === 0) throw new OperationRefused('not_found', 'no deleted note to restore')
    await emitRegister(tx, p, {
      kind: 'record.restored',
      subjectType: 'note',
      subject: input.note,
      matter: r.rows[0].owner_type === 'matter' ? (r.rows[0].owner as number) : undefined,
    })
  })
}
