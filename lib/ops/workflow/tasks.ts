// Tasks and key dates. The closed-matter rule admits no carve-outs: every
// task or key-date write on a closed or archived matter — completion
// included — requires the matter.edit_closed capability AND the
// per-transaction ceremony, and is registered either way. Key-date sync
// writes are idempotent on the external reference; a sync against a
// locally soft-deleted row refuses back to the integration with a
// documented code.

import type { CeremonyFlag, Principal, Tx } from '@/lib/db'
import { withPrincipal, emitRegister, OperationRefused } from '@/lib/db'
import { requireStaff, requireCapability, hasCapability, shippedChoiceItem } from '@/lib/ops/shared'

async function closedGuardInTx(
  tx: Tx,
  p: Principal,
  matterId: number | null,
  editClosed: boolean,
): Promise<void> {
  if (matterId === null) return
  const m = await tx.query(`select status from deedbox.matter where id = $1`, [matterId])
  if (m.rowCount === 0) throw new OperationRefused('not_found', 'matter not found')
  if (m.rows[0].status === 'closed' || m.rows[0].status === 'archived') {
    if (!editClosed) {
      throw new OperationRefused(
        'matter_closed',
        'this matter is closed — every task write needs the edit-closed ceremony',
      )
    }
    if (!(await hasCapability(tx, p.id, 'matter.edit_closed'))) {
      throw new OperationRefused('capability_missing', 'the ceremony requires matter.edit_closed')
    }
  }
}

function taskCeremony(editClosed: boolean | undefined) {
  return { ceremonies: editClosed ? (['edit_closed'] as CeremonyFlag[]) : [] }
}

/** Create a task (matter-linked or personal). */
export async function createTask(
  p: Principal,
  input: {
    title: string
    matter?: number
    stage?: number
    owner?: number
    dueDate?: string
    detail?: string
    editClosed?: boolean
  },
): Promise<{ id: number }> {
  requireStaff(p)
  if (!input.title.trim()) throw new OperationRefused('title_required', 'a task carries a title')
  return withPrincipal(
    p,
    async (tx) => {
      await closedGuardInTx(tx, p, input.matter ?? null, input.editClosed ?? false)
      if (input.stage !== undefined) {
        const s = await tx.query(
          `select 1 from deedbox.matter_stage where id = $1 and matter = $2`,
          [input.stage, input.matter ?? -1],
        )
        if (s.rowCount === 0) {
          throw new OperationRefused('wrong_stage', 'the stage must belong to the task’s matter')
        }
      }
      const r = await tx.query(
        `insert into deedbox.task (matter, stage, title, owner, due_date, origin)
         values ($1, $2, $3, $4, $5::date, 'manual') returning id`,
        [
          input.matter ?? null,
          input.stage ?? null,
          input.title,
          input.owner ?? p.id,
          input.dueDate ?? null,
        ],
      )
      await emitRegister(tx, p, {
        kind: 'record.created',
        subjectType: 'task',
        subject: r.rows[0].id as number,
        matter: input.matter,
      })
      return { id: r.rows[0].id as number }
    },
    taskCeremony(input.editClosed),
  )
}

/** Complete / reopen a task. */
export async function setTaskDone(
  p: Principal,
  input: { task: number; done: boolean; editClosed?: boolean },
): Promise<void> {
  requireStaff(p)
  await withPrincipal(
    p,
    async (tx) => {
      const t = await tx.query(
        `select id, matter, done from deedbox.task where id = $1 and deleted_at is null for update`,
        [input.task],
      )
      if (t.rowCount === 0) throw new OperationRefused('not_found', 'task not found')
      await closedGuardInTx(tx, p, t.rows[0].matter as number | null, input.editClosed ?? false)
      if (t.rows[0].done === input.done) {
        throw new OperationRefused('no_change', 'the task is already in that state')
      }
      await tx.query(
        `update deedbox.task set done = $2, done_by = case when $2 then $3::bigint end where id = $1`,
        [input.task, input.done, p.id],
      )
      await emitRegister(tx, p, {
        kind: 'record.changed',
        subjectType: 'task',
        subject: input.task,
        matter: (t.rows[0].matter as number | null) ?? undefined,
        detail: { before: { done: !input.done }, after: { done: input.done } },
      })
    },
    taskCeremony(input.editClosed),
  )
}

/** Edit title/due date, reassign the owner. */
export async function editTask(
  p: Principal,
  input: {
    task: number
    title?: string
    dueDate?: string | null
    owner?: number
    editClosed?: boolean
  },
): Promise<void> {
  requireStaff(p)
  if (input.title === undefined && input.dueDate === undefined && input.owner === undefined) {
    throw new OperationRefused('nothing_to_change', 'name a field to change')
  }
  await withPrincipal(
    p,
    async (tx) => {
      const t = await tx.query(
        `select id, matter, title, due_date::text as due, owner from deedbox.task
          where id = $1 and deleted_at is null for update`,
        [input.task],
      )
      if (t.rowCount === 0) throw new OperationRefused('not_found', 'task not found')
      await closedGuardInTx(tx, p, t.rows[0].matter as number | null, input.editClosed ?? false)
      await tx.query(
        `update deedbox.task
            set title = coalesce($2, title),
                due_date = case when $3 then $4::date else due_date end,
                owner = coalesce($5, owner)
          where id = $1`,
        [
          input.task,
          input.title ?? null,
          input.dueDate !== undefined,
          input.dueDate ?? null,
          input.owner ?? null,
        ],
      )
      await emitRegister(tx, p, {
        kind: 'record.changed',
        subjectType: 'task',
        subject: input.task,
        matter: (t.rows[0].matter as number | null) ?? undefined,
        detail: {
          before: { title: t.rows[0].title, due_date: t.rows[0].due, owner: t.rows[0].owner },
          after: {
            title: input.title ?? t.rows[0].title,
            due_date: input.dueDate !== undefined ? input.dueDate : t.rows[0].due,
            owner: input.owner ?? t.rows[0].owner,
          },
        },
      })
    },
    taskCeremony(input.editClosed),
  )
}

/** Soft-delete / restore a task. */
export async function softDeleteTask(
  p: Principal,
  input: { task: number; editClosed?: boolean },
): Promise<void> {
  requireStaff(p)
  await withPrincipal(
    p,
    async (tx) => {
      const t = await tx.query(
        `select matter from deedbox.task where id = $1 and deleted_at is null for update`,
        [input.task],
      )
      if (t.rowCount === 0) throw new OperationRefused('not_found', 'task not found')
      await closedGuardInTx(tx, p, t.rows[0].matter as number | null, input.editClosed ?? false)
      await tx.query(
        `update deedbox.task set deleted_at = now(), deleted_by = $2 where id = $1`,
        [input.task, p.id],
      )
      await emitRegister(tx, p, {
        kind: 'record.soft_deleted',
        subjectType: 'task',
        subject: input.task,
        matter: (t.rows[0].matter as number | null) ?? undefined,
      })
    },
    taskCeremony(input.editClosed),
  )
}

export async function restoreTask(p: Principal, input: { task: number }): Promise<void> {
  await withPrincipal(p, async (tx) => {
    await requireCapability(tx, p, 'deleted.restore')
    const t = await tx.query(
      `update deedbox.task set deleted_at = null, deleted_by = null
        where id = $1 and deleted_at is not null returning matter`,
      [input.task],
    )
    if (t.rowCount === 0) throw new OperationRefused('not_deleted', 'no deleted task by that id')
    await emitRegister(tx, p, {
      kind: 'record.restored',
      subjectType: 'task',
      subject: input.task,
      matter: (t.rows[0].matter as number | null) ?? undefined,
    })
  })
}

/** Create a key date or appointment. */
export async function createKeyDate(
  p: Principal,
  input: {
    matter: number
    kind: 'key_date' | 'appointment'
    typeKey: string
    title: string
    startsAt: string
    endsAt?: string
    critical?: boolean
    externalSyncRef?: string
    editClosed?: boolean
  },
): Promise<{ id: number; replayed: boolean }> {
  if (!input.title.trim()) throw new OperationRefused('title_required', 'a key date carries a title')
  return withPrincipal(
    p,
    async (tx) => {
      await closedGuardInTx(tx, p, input.matter, input.editClosed ?? false)
      if (input.externalSyncRef) {
        const existing = await tx.query(
          `select id, deleted_at from deedbox.key_date
            where matter = $1 and external_sync_ref = $2`,
          [input.matter, input.externalSyncRef],
        )
        if (existing.rowCount! > 0) {
          if (existing.rows[0].deleted_at !== null) {
            throw new OperationRefused(
              'sync_conflict_deleted',
              'the synced record was deleted here — the integration must not recreate it',
            )
          }
          // idempotent sync update: times and title may move, registered
          await tx.query(
            `update deedbox.key_date set title = $2, starts_at = $3, ends_at = $4
              where id = $1`,
            [existing.rows[0].id, input.title, input.startsAt, input.endsAt ?? null],
          )
          await emitRegister(tx, p, {
            kind: 'record.changed',
            subjectType: 'key_date',
            subject: existing.rows[0].id as number,
            matter: input.matter,
            detail: { sync_update: true, external_sync_ref: input.externalSyncRef },
          })
          return { id: existing.rows[0].id as number, replayed: true }
        }
      }
      const type = await shippedChoiceItem(tx, 'key_date_types', input.typeKey)
      const r = await tx.query(
        `insert into deedbox.key_date
           (matter, kind, type, title, starts_at, ends_at, critical, external_sync_ref)
         values ($1, $2, $3, $4, $5, $6, $7, $8) returning id`,
        [
          input.matter,
          input.kind,
          type,
          input.title,
          input.startsAt,
          input.endsAt ?? null,
          input.critical ?? false,
          input.externalSyncRef ?? null,
        ],
      )
      await emitRegister(tx, p, {
        kind: 'record.created',
        subjectType: 'key_date',
        subject: r.rows[0].id as number,
        matter: input.matter,
        detail: { critical: input.critical ?? false },
      })
      return { id: r.rows[0].id as number, replayed: false }
    },
    taskCeremony(input.editClosed),
  )
}

/** Key date: done, critical toggle. */
export async function setKeyDateDone(
  p: Principal,
  input: { keyDate: number; done: boolean; editClosed?: boolean },
): Promise<void> {
  requireStaff(p)
  await withPrincipal(
    p,
    async (tx) => {
      const k = await tx.query(
        `select matter, done from deedbox.key_date where id = $1 and deleted_at is null for update`,
        [input.keyDate],
      )
      if (k.rowCount === 0) throw new OperationRefused('not_found', 'key date not found')
      await closedGuardInTx(tx, p, k.rows[0].matter as number, input.editClosed ?? false)
      await tx.query(`update deedbox.key_date set done = $2 where id = $1`, [
        input.keyDate,
        input.done,
      ])
      await emitRegister(tx, p, {
        kind: 'record.changed',
        subjectType: 'key_date',
        subject: input.keyDate,
        matter: k.rows[0].matter as number,
        detail: { before: { done: k.rows[0].done }, after: { done: input.done } },
      })
    },
    taskCeremony(input.editClosed),
  )
}

export async function setKeyDateCritical(
  p: Principal,
  input: { keyDate: number; critical: boolean; editClosed?: boolean },
): Promise<void> {
  requireStaff(p)
  await withPrincipal(
    p,
    async (tx) => {
      const k = await tx.query(
        `select matter, critical from deedbox.key_date where id = $1 and deleted_at is null for update`,
        [input.keyDate],
      )
      if (k.rowCount === 0) throw new OperationRefused('not_found', 'key date not found')
      await closedGuardInTx(tx, p, k.rows[0].matter as number, input.editClosed ?? false)
      await tx.query(`update deedbox.key_date set critical = $2 where id = $1`, [
        input.keyDate,
        input.critical,
      ])
      await emitRegister(tx, p, {
        kind: 'record.changed',
        subjectType: 'key_date',
        subject: input.keyDate,
        matter: k.rows[0].matter as number,
        detail: { before: { critical: k.rows[0].critical }, after: { critical: input.critical } },
      })
    },
    taskCeremony(input.editClosed),
  )
}
