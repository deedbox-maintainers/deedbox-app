// Choice-list administration over the one engine behind every firm list
// (0002). The schema's guard trigger stands behind everything here: shipped
// items are never deleted, the shipped two time categories can never
// deactivate, and their chargeability flags are immutable. Every write
// registers list.changed in its own transaction.
//
// Implementation notes:
//   * Reorder takes the whole list's new order in one registered operation
//     (the screen presents the before/after diff before submitting). Reorder
//     could ride the generic bulk machinery, but the bulk kinds catalogue is
//     closed to the matter multi-select set, and a list reorder is one small
//     atomic act, so it lands as a direct operation instead.
//   * delete_unused_item discovers blockers generically from the catalogue
//     of foreign keys referencing choice_item plus custom-field usage, so a
//     new referencing table can never silently break the guard.

import type { Principal, Tx } from '@/lib/db'
import { withPrincipal, emitRegister, OperationRefused } from '@/lib/db'
import { requireStaff, requireCapability } from '@/lib/ops/shared'

async function loadItem(tx: Tx, id: number) {
  const r = await tx.query(
    `select ci.id, ci.list, ci.label, ci.position, ci.active, ci.shipped_key,
            ci.counts_as_chargeable, cl.purpose_key, cl.name as list_name
       from deedbox.choice_item ci join deedbox.choice_list cl on cl.id = ci.list
      where ci.id = $1`,
    [id],
  )
  if (r.rowCount === 0) throw new OperationRefused('not_found', 'no such list item')
  return r.rows[0]
}

export async function createChoiceList(
  p: Principal,
  input: { purposeKey: string; name: string },
): Promise<{ list: number }> {
  requireStaff(p)
  return withPrincipal(p, async (tx) => {
    await requireCapability(tx, p, 'lists.manage')
    if (!/^custom\./.test(input.purposeKey)) {
      throw new OperationRefused(
        'invalid_key',
        'firm lists live under the custom. prefix — shipped purposes already exist',
      )
    }
    const ins = await tx.query(
      `insert into deedbox.choice_list (purpose_key, name) values ($1, $2) returning id`,
      [input.purposeKey, input.name],
    )
    await emitRegister(tx, p, {
      kind: 'list.changed',
      subjectType: 'choice_list',
      subject: ins.rows[0].id,
      detail: { created: { purpose_key: input.purposeKey, name: input.name } },
    })
    return { list: ins.rows[0].id as number }
  })
}

export async function addChoiceItem(
  p: Principal,
  input: { list: number; label: string; countsAsChargeable?: boolean },
): Promise<{ item: number }> {
  requireStaff(p)
  return withPrincipal(p, async (tx) => {
    await requireCapability(tx, p, 'lists.manage')
    const list = await tx.query(`select id, purpose_key from deedbox.choice_list where id = $1`, [
      input.list,
    ])
    if (list.rowCount === 0) throw new OperationRefused('not_found', 'no such list')
    if (list.rows[0].purpose_key === 'time_categories' && input.countsAsChargeable === undefined) {
      throw new OperationRefused(
        'chargeability_required',
        'a time category must state whether it counts as chargeable when it is created',
      )
    }
    const ins = await tx.query(
      `insert into deedbox.choice_item (list, label, position, counts_as_chargeable)
       values ($1, $2,
               coalesce((select max(position) + 1 from deedbox.choice_item where list = $1), 1),
               coalesce($3, false))
       returning id, position`,
      [input.list, input.label, input.countsAsChargeable ?? null],
    )
    await emitRegister(tx, p, {
      kind: 'list.changed',
      subjectType: 'choice_item',
      subject: ins.rows[0].id,
      detail: {
        list: input.list,
        added: {
          label: input.label,
          position: ins.rows[0].position,
          counts_as_chargeable: input.countsAsChargeable ?? false,
        },
      },
    })
    return { item: ins.rows[0].id as number }
  })
}

export async function relabelChoiceItem(
  p: Principal,
  input: { item: number; label: string },
): Promise<void> {
  requireStaff(p)
  await withPrincipal(p, async (tx) => {
    await requireCapability(tx, p, 'lists.manage')
    const item = await loadItem(tx, input.item)
    await tx.query(`update deedbox.choice_item set label = $2 where id = $1`, [
      input.item,
      input.label,
    ])
    await emitRegister(tx, p, {
      kind: 'list.changed',
      subjectType: 'choice_item',
      subject: input.item,
      detail: { before: { label: item.label }, after: { label: input.label } },
    })
  })
}

/** Firm-added time categories only; the shipped two are schema-immutable. */
export async function setChoiceItemChargeability(
  p: Principal,
  input: { item: number; countsAsChargeable: boolean },
): Promise<void> {
  requireStaff(p)
  await withPrincipal(p, async (tx) => {
    await requireCapability(tx, p, 'lists.manage')
    const item = await loadItem(tx, input.item)
    if (item.purpose_key !== 'time_categories') {
      throw new OperationRefused('not_applicable', 'chargeability belongs to time categories only')
    }
    if (item.shipped_key !== null) {
      throw new OperationRefused(
        'shipped_immutable',
        'the shipped time-category chargeability flags are immutable',
      )
    }
    await tx.query(`update deedbox.choice_item set counts_as_chargeable = $2 where id = $1`, [
      input.item,
      input.countsAsChargeable,
    ])
    await emitRegister(tx, p, {
      kind: 'list.changed',
      subjectType: 'choice_item',
      subject: input.item,
      detail: {
        before: { counts_as_chargeable: item.counts_as_chargeable },
        after: { counts_as_chargeable: input.countsAsChargeable },
      },
    })
  })
}

/** Whole-list reorder in one registered act; every item of the list must appear once. */
export async function reorderChoiceItems(
  p: Principal,
  input: { list: number; orderedItems: number[] },
): Promise<void> {
  requireStaff(p)
  await withPrincipal(p, async (tx) => {
    await requireCapability(tx, p, 'lists.manage')
    const rows = await tx.query(
      `select id, label, position from deedbox.choice_item where list = $1 order by position`,
      [input.list],
    )
    if (rows.rowCount === 0) throw new OperationRefused('not_found', 'no such list or it has no items')
    const existing = rows.rows.map((r) => r.id as number)
    const proposed = [...input.orderedItems]
    if (
      existing.length !== proposed.length ||
      [...existing].sort().join(',') !== [...proposed].sort().join(',')
    ) {
      throw new OperationRefused(
        'order_incomplete',
        'the new order must name every item of the list exactly once',
      )
    }
    for (let i = 0; i < proposed.length; i++) {
      await tx.query(`update deedbox.choice_item set position = $2 where id = $1`, [
        proposed[i],
        i + 1,
      ])
    }
    await emitRegister(tx, p, {
      kind: 'list.changed',
      subjectType: 'choice_list',
      subject: input.list,
      detail: { before: { order: existing }, after: { order: proposed } },
    })
  })
}

export async function deactivateChoiceItem(p: Principal, input: { item: number }): Promise<void> {
  requireStaff(p)
  await withPrincipal(p, async (tx) => {
    await requireCapability(tx, p, 'lists.manage')
    const item = await loadItem(tx, input.item)
    if (!item.active) return // idempotent
    try {
      await tx.query(`update deedbox.choice_item set active = false where id = $1`, [input.item])
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      if (msg.includes('cannot be deactivated')) {
        throw new OperationRefused('shipped_immutable', msg)
      }
      throw err
    }
    await emitRegister(tx, p, {
      kind: 'list.changed',
      subjectType: 'choice_item',
      subject: input.item,
      detail: { before: { active: true }, after: { active: false } },
    })
  })
}

export async function reactivateChoiceItem(p: Principal, input: { item: number }): Promise<void> {
  requireStaff(p)
  await withPrincipal(p, async (tx) => {
    await requireCapability(tx, p, 'lists.manage')
    const item = await loadItem(tx, input.item)
    if (item.active) return // idempotent
    await tx.query(`update deedbox.choice_item set active = true where id = $1`, [input.item])
    await emitRegister(tx, p, {
      kind: 'list.changed',
      subjectType: 'choice_item',
      subject: input.item,
      detail: { before: { active: false }, after: { active: true } },
    })
  })
}

/**
 * delete_unused_item — hard delete only where nothing anywhere refers
 * to the item; the refusal lists every blocking usage by table.
 */
export async function deleteUnusedChoiceItem(
  p: Principal,
  input: { item: number },
): Promise<void> {
  requireStaff(p)
  await withPrincipal(p, async (tx) => {
    await requireCapability(tx, p, 'lists.manage')
    const item = await loadItem(tx, input.item)
    if (item.shipped_key !== null) {
      throw new OperationRefused('shipped_immutable', 'shipped items are never deleted')
    }
    // every foreign key referencing choice_item, discovered from the catalogue
    const fks = await tx.query(
      `select rel.relname as table_name, att.attname as column_name
         from pg_constraint con
         join pg_class rel on rel.oid = con.conrelid
         join pg_namespace ns on ns.oid = rel.relnamespace
         join pg_attribute att on att.attrelid = con.conrelid and att.attnum = con.conkey[1]
        where con.contype = 'f' and ns.nspname = 'deedbox'
          and con.confrelid = 'deedbox.choice_item'::regclass
          and rel.relname <> 'choice_item'`,
    )
    const blockers: string[] = []
    for (const fk of fks.rows) {
      const c = await tx.query(
        `select count(*)::int as n from deedbox.${fk.table_name} where ${fk.column_name} = $1`,
        [input.item],
      )
      if (c.rows[0].n > 0) blockers.push(`${fk.table_name} (${c.rows[0].n})`)
    }
    if (blockers.length > 0) {
      throw new OperationRefused(
        'in_use',
        `this item is referred to by ${blockers.join(', ')} — deactivate it instead`,
      )
    }
    await tx.query(`delete from deedbox.choice_item where id = $1`, [input.item])
    await emitRegister(tx, p, {
      kind: 'list.changed',
      subjectType: 'choice_item',
      subject: input.item,
      detail: { deleted: { list: item.list, label: item.label } },
    })
  })
}
