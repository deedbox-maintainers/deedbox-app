// Custom-field administration over the one engine (0002): definitions (firm
// scopes party/matter/intake; pack_object rows are pack-owned and read-only
// here), sets, and the shared value-write interface the owning domains call
// inside their own save transactions. The schema's guards stand behind:
// data_type and key immutable, definitions never deleted, choice fields
// auto-create their custom list, one value row per (definition, owner) with
// exactly one populated column.
//
// Implementation note: a per-practice-area set binding has no schema home
// (custom_field_set carries scope only; 0002 shipped no binding table), so
// sets group and order fields within their scope and every active in-scope
// definition renders on its scope's records. A binding table would be a
// numbered change when a firm needs per-area field sets.

import type { Principal, Tx } from '@/lib/db'
import { withPrincipal, emitRegister, OperationRefused } from '@/lib/db'
import { requireStaff, requireCapability } from '@/lib/ops/shared'

export interface DefineFieldInput {
  scope: 'party' | 'matter' | 'intake'
  key: string
  label: string
  dataType: 'text' | 'number' | 'date' | 'choice' | 'party_link'
  choiceList?: number
  required?: boolean
  validation?: unknown
  fieldSet?: number
  position?: number
  searchable?: boolean
}

export async function defineCustomField(
  p: Principal,
  input: DefineFieldInput,
): Promise<{ definition: number }> {
  requireStaff(p)
  return withPrincipal(p, async (tx) => {
    await requireCapability(tx, p, 'fields.manage')
    if (!/^[a-z][a-z0-9_]*$/.test(input.key)) {
      throw new OperationRefused(
        'invalid_key',
        'field keys are lower-case letters, digits and underscores, starting with a letter',
      )
    }
    const dup = await tx.query(
      `select 1 from deedbox.custom_field_definition
        where scope = $1 and owner_pack_version is null and key = $2 and active`,
      [input.scope, input.key],
    )
    if ((dup.rowCount ?? 0) > 0) {
      throw new OperationRefused('duplicate_key', `an active ${input.scope} field already uses ${input.key}`)
    }
    const ins = await tx.query(
      `insert into deedbox.custom_field_definition
         (scope, key, label, data_type, choice_list, required, validation,
          field_set, position, searchable)
       values ($1,$2,$3,$4,$5,coalesce($6,false),$7,$8,coalesce($9,0),coalesce($10,true))
       returning id, choice_list`,
      [
        input.scope,
        input.key,
        input.label,
        input.dataType,
        input.choiceList ?? null,
        input.required ?? null,
        input.validation === undefined ? null : JSON.stringify(input.validation),
        input.fieldSet ?? null,
        input.position ?? null,
        input.searchable ?? null,
      ],
    )
    await emitRegister(tx, p, {
      kind: 'field.changed',
      subjectType: 'custom_field_definition',
      subject: ins.rows[0].id,
      detail: {
        created: {
          scope: input.scope,
          key: input.key,
          label: input.label,
          data_type: input.dataType,
          choice_list: ins.rows[0].choice_list,
        },
      },
    })
    return { definition: ins.rows[0].id as number }
  })
}

async function loadFirmField(tx: Tx, id: number) {
  const r = await tx.query(
    `select id, scope, owner_pack_version, key, label, data_type, required,
            validation, field_set, position, searchable, active
       from deedbox.custom_field_definition where id = $1`,
    [id],
  )
  if (r.rowCount === 0) throw new OperationRefused('not_found', 'no such field definition')
  if (r.rows[0].owner_pack_version !== null) {
    throw new OperationRefused('pack_owned', 'pack fields are read-only to the firm — a pack version owns them')
  }
  return r.rows[0]
}

export interface EditFieldInput {
  definition: number
  label?: string
  position?: number
  validation?: unknown
  required?: boolean
  searchable?: boolean
  fieldSet?: number | null
}

/** Label, position, validation, required, searchable — type and key immutable by schema. */
export async function editCustomField(p: Principal, input: EditFieldInput): Promise<void> {
  requireStaff(p)
  await withPrincipal(p, async (tx) => {
    await requireCapability(tx, p, 'fields.manage')
    const before = await loadFirmField(tx, input.definition)
    await tx.query(
      `update deedbox.custom_field_definition
          set label = coalesce($2, label),
              position = coalesce($3, position),
              validation = coalesce($4::jsonb, validation),
              required = coalesce($5, required),
              searchable = coalesce($6, searchable),
              field_set = case when $7 then $8 else field_set end
        where id = $1`,
      [
        input.definition,
        input.label ?? null,
        input.position ?? null,
        input.validation === undefined ? null : JSON.stringify(input.validation),
        input.required ?? null,
        input.searchable ?? null,
        input.fieldSet !== undefined,
        input.fieldSet ?? null,
      ],
    )
    const after = await tx.query(
      `select label, position, validation, required, searchable, field_set
         from deedbox.custom_field_definition where id = $1`,
      [input.definition],
    )
    await emitRegister(tx, p, {
      kind: 'field.changed',
      subjectType: 'custom_field_definition',
      subject: input.definition,
      detail: {
        before: {
          label: before.label,
          position: before.position,
          validation: before.validation,
          required: before.required,
          searchable: before.searchable,
          field_set: before.field_set,
        },
        after: after.rows[0],
      },
    })
  })
}

export async function setCustomFieldActive(
  p: Principal,
  input: { definition: number; active: boolean },
): Promise<void> {
  requireStaff(p)
  await withPrincipal(p, async (tx) => {
    await requireCapability(tx, p, 'fields.manage')
    const before = await loadFirmField(tx, input.definition)
    if (before.active === input.active) return // idempotent
    if (input.active) {
      const dup = await tx.query(
        `select 1 from deedbox.custom_field_definition
          where scope = $1 and owner_pack_version is null and key = $2 and active and id <> $3`,
        [before.scope, before.key, input.definition],
      )
      if ((dup.rowCount ?? 0) > 0) {
        throw new OperationRefused(
          'duplicate_key',
          `another active ${before.scope} field now uses ${before.key} — reactivation would collide`,
        )
      }
    }
    await tx.query(`update deedbox.custom_field_definition set active = $2 where id = $1`, [
      input.definition,
      input.active,
    ])
    await emitRegister(tx, p, {
      kind: 'field.changed',
      subjectType: 'custom_field_definition',
      subject: input.definition,
      detail: { before: { active: before.active }, after: { active: input.active } },
    })
  })
}

export async function defineFieldSet(
  p: Principal,
  input: { name: string; scope: 'matter' | 'intake' },
): Promise<{ fieldSet: number }> {
  requireStaff(p)
  return withPrincipal(p, async (tx) => {
    await requireCapability(tx, p, 'fields.manage')
    const ins = await tx.query(
      `insert into deedbox.custom_field_set (name, scope) values ($1, $2) returning id`,
      [input.name, input.scope],
    )
    await emitRegister(tx, p, {
      kind: 'field.changed',
      subjectType: 'custom_field_set',
      subject: ins.rows[0].id,
      detail: { created: { name: input.name, scope: input.scope } },
    })
    return { fieldSet: ins.rows[0].id as number }
  })
}

/**
 * write_value — the shared interface the owning domains call inside
 * their own save transactions; also the standalone act behind the field
 * panels on party/matter/intake records (the caller's screen registers the
 * owning record's change; the standalone form registers record.changed).
 */
export async function writeCustomFieldValueInTx(
  tx: Tx,
  input: { definition: number; ownerType: string; owner: number; value: unknown },
): Promise<void> {
  const d = await tx.query(
    `select id, scope, data_type, choice_list, active, label, validation
       from deedbox.custom_field_definition where id = $1`,
    [input.definition],
  )
  if (d.rowCount === 0) throw new OperationRefused('not_found', 'no such field definition')
  const def = d.rows[0]
  if (!def.active) throw new OperationRefused('inactive_field', `${def.label} is deactivated`)
  if (def.scope !== input.ownerType && def.scope !== 'pack_object') {
    throw new OperationRefused('wrong_scope', `${def.label} is a ${def.scope} field`)
  }
  if (input.value === null || input.value === undefined || input.value === '') {
    await tx.query(
      `delete from deedbox.custom_field_value
        where definition = $1 and owner_type = $2 and owner = $3`,
      [input.definition, input.ownerType, input.owner],
    )
    return
  }
  const cols: Record<string, string> = {
    text: 'text_value',
    number: 'number_value',
    date: 'date_value',
    choice: 'choice_value',
    party_link: 'party_value',
  }
  const col = cols[def.data_type as string]
  if (!col) throw new OperationRefused('invalid_value', `unknown field type ${def.data_type}`)
  if (def.data_type === 'choice') {
    const ok = await tx.query(`select 1 from deedbox.choice_item where id = $1 and list = $2 and active`, [
      input.value,
      def.choice_list,
    ])
    if (ok.rowCount === 0) {
      throw new OperationRefused('invalid_value', `${def.label}: not an active item of its list`)
    }
  }
  const otherCols = Object.values(cols).filter((c) => c !== col)
  await tx.query(
    `insert into deedbox.custom_field_value (definition, owner_type, owner, ${col})
     values ($1, $2, $3, $4)
     on conflict (definition, owner_type, owner)
     do update set ${otherCols.map((c) => `${c} = null`).join(', ')}, ${col} = excluded.${col}`,
    [input.definition, input.ownerType, input.owner, input.value],
  )
}
