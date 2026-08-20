// Predicate-governed reads for the configuration screens. Read-only
// transactions through the same wrapper as everything else; the
// capability gates for VIEWING are checked here — the operations re-check
// their own for acting.

import type { Principal, Tx } from '@/lib/db'
import { withPrincipal, OperationRefused } from '@/lib/db'
import { requireStaff, hasCapability } from '@/lib/ops/shared'

async function requireAny(tx: Tx, p: Principal, keys: string[], what: string): Promise<void> {
  for (const k of keys) if (await hasCapability(tx, p.id, k)) return
  throw new OperationRefused('not_permitted', `${what} needs ${keys.join(' or ')}`)
}

export interface SettingRow {
  key: string
  description: string
  valueType: string
  neutralDefault: unknown
  allowedValues: unknown[] | null
  currentValue: unknown
  scheduled: { row: number; value: unknown; effectiveFrom: string }[]
  category: string
}

/** Firm settings screen: every key with its effective value and any scheduled values. */
export async function settingsScreen(p: Principal): Promise<SettingRow[]> {
  requireStaff(p)
  return withPrincipal(
    p,
    async (tx) => {
      await requireAny(tx, p, ['settings.manage', 'security.administer'], 'the settings screen')
      const r = await tx.query(
        `select sd.key, sd.description, sd.value_type, sd.neutral_default, sd.allowed_values,
                deedbox.current_setting_value(sd.key) as current_value,
                coalesce(
                  (select jsonb_agg(jsonb_build_object(
                            'row', fs.id, 'value', fs.value, 'effectiveFrom', fs.effective_from)
                          order by fs.effective_from)
                     from deedbox.firm_setting fs
                    where fs.definition = sd.id and fs.effective_from > now()),
                  '[]'::jsonb) as scheduled
           from deedbox.setting_definition sd
          order by sd.key`,
      )
      return r.rows.map((row) => ({
        key: row.key as string,
        description: row.description as string,
        valueType: row.value_type as string,
        neutralDefault: row.neutral_default,
        allowedValues: (row.allowed_values as unknown[] | null) ?? null,
        currentValue: row.current_value,
        scheduled: row.scheduled as SettingRow['scheduled'],
        category: (row.key as string).split('.')[0],
      }))
    },
    { readOnly: true },
  )
}

/** The register projection behind a setting's history drawer. */
export async function settingHistory(p: Principal, key: string) {
  requireStaff(p)
  return withPrincipal(
    p,
    async (tx) => {
      await requireAny(tx, p, ['settings.manage', 'security.administer'], 'setting history')
      const r = await tx.query(
        `select re.id, re.occurred_at, re.actor_kind, re.actor, re.detail,
                s.person_name as actor_name
           from deedbox.register_entry re
           left join deedbox.staff_member s on s.id = re.actor and re.actor_kind = 'staff'
          where re.event_kind = 'setting.changed' and re.detail->>'key' = $1
          order by re.occurred_at desc limit 100`,
        [key],
      )
      return r.rows
    },
    { readOnly: true },
  )
}

/** Pack console: the firm's pack, its versions, and each version's declarations. */
export async function packConsole(p: Principal) {
  requireStaff(p)
  return withPrincipal(
    p,
    async (tx) => {
      await requireAny(tx, p, ['pack.activate', 'security.administer'], 'the pack console')
      const pack = await tx.query(
        `select cp.id, cp.code, cp.name, cp.active_version
           from deedbox.country_pack cp join deedbox.firm f on f.country_pack = cp.id
          where f.id = $1`,
        [p.firm],
      )
      if (pack.rowCount === 0) return null
      const versions = await tx.query(
        `select id, version, released_at from deedbox.pack_version
          where pack = $1 order by released_at desc`,
        [pack.rows[0].id],
      )
      const declarations = await tx.query(
        `select pd.pack_version, pd.rule_point, pd.kind, pd.body
           from deedbox.pack_declaration pd
           join deedbox.pack_version pv on pv.id = pd.pack_version
          where pv.pack = $1 order by pd.rule_point`,
        [pack.rows[0].id],
      )
      const points = await tx.query(
        `select key, description, permitted_kinds from deedbox.rule_point order by key`,
      )
      const activations = await tx.query(
        `select re.occurred_at, re.actor_kind, re.actor, re.detail
           from deedbox.register_entry re
          where re.event_kind = 'pack.activated' and re.subject = $1
          order by re.occurred_at desc limit 20`,
        [pack.rows[0].id],
      )
      return {
        pack: pack.rows[0],
        versions: versions.rows,
        declarations: declarations.rows,
        rulePoints: points.rows,
        activations: activations.rows,
      }
    },
    { readOnly: true },
  )
}

/** Numbering console: one card per purpose/scope with next-number previews. */
export async function numberingConsole(p: Principal) {
  requireStaff(p)
  return withPrincipal(
    p,
    async (tx) => {
      await requireAny(tx, p, ['numbering.manage', 'security.administer'], 'the numbering console')
      const formats = await tx.query(
        `select f.id, f.purpose, f.scope, f.pattern, f.allocation_mode, f.reset,
                f.active, f.created_at,
                coalesce((select jsonb_agg(jsonb_build_object(
                            'partition', sc.partition, 'next', sc.next_value)
                          order by sc.partition)
                    from deedbox.sequence_counter sc where sc.format = f.id),
                  '[]'::jsonb) as partitions
           from deedbox.number_format f
          order by f.purpose, coalesce(f.scope,''), f.created_at`,
      )
      return formats.rows
    },
    { readOnly: true },
  )
}

/** List manager: every list, items with badges, per-item usage counts. */
export async function listManager(p: Principal) {
  requireStaff(p)
  return withPrincipal(
    p,
    async (tx) => {
      await requireAny(tx, p, ['lists.manage', 'security.administer'], 'the list manager')
      const lists = await tx.query(
        `select id, purpose_key, name from deedbox.choice_list order by purpose_key`,
      )
      const items = await tx.query(
        `select id, list, label, position, active, shipped_key, counts_as_chargeable
           from deedbox.choice_item order by list, position`,
      )
      // usage discovered from the FK catalogue, one count query per referencing column
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
      const usage = new Map<number, number>()
      for (const fk of fks.rows) {
        const c = await tx.query(
          `select ${fk.column_name} as item, count(*)::int as n
             from deedbox.${fk.table_name}
            where ${fk.column_name} is not null group by 1`,
        )
        for (const row of c.rows) {
          usage.set(row.item as number, (usage.get(row.item as number) ?? 0) + (row.n as number))
        }
      }
      return {
        lists: lists.rows,
        items: items.rows.map((i) => ({ ...i, usage: usage.get(i.id as number) ?? 0 })),
      }
    },
    { readOnly: true },
  )
}

/** Field manager: definitions by scope, sets, per-field value counts. */
export async function fieldManager(p: Principal) {
  requireStaff(p)
  return withPrincipal(
    p,
    async (tx) => {
      await requireAny(tx, p, ['fields.manage', 'security.administer'], 'the field manager')
      const defs = await tx.query(
        `select d.id, d.scope, d.owner_pack_version, d.key, d.label, d.data_type,
                d.choice_list, d.required, d.validation, d.field_set, d.position,
                d.searchable, d.active,
                (select count(*)::int from deedbox.custom_field_value v where v.definition = d.id) as value_count,
                pv.version as pack_version_label
           from deedbox.custom_field_definition d
           left join deedbox.pack_version pv on pv.id = d.owner_pack_version
          order by d.scope, d.position, d.key`,
      )
      const sets = await tx.query(
        `select id, name, scope from deedbox.custom_field_set order by name`,
      )
      return { definitions: defs.rows, sets: sets.rows }
    },
    { readOnly: true },
  )
}

/** Template manager: firm rows editable, pack rows read-only, dangling steps flagged. */
export async function templateManager(p: Principal) {
  requireStaff(p)
  return withPrincipal(
    p,
    async (tx) => {
      await requireAny(tx, p, ['templates.manage', 'security.administer'], 'the template manager')
      const templates = await tx.query(
        `select t.id, t.name, t.channel, t.purpose, t.subject, t.body, t.tokens_used,
                t.pack_version, t.active, pv.version as pack_version_label,
                (pv.id is not null and pv.id is distinct from cp.active_version) as superseded_pack,
                (select count(*)::int from deedbox.reminder_step rs where rs.template = t.id) as reminder_steps
           from deedbox.message_template t
           left join deedbox.pack_version pv on pv.id = t.pack_version
           left join deedbox.country_pack cp on cp.id = pv.pack
          order by t.purpose, t.name`,
      )
      return templates.rows
    },
    { readOnly: true },
  )
}

/** Private-layer console: namespace state, slots, extension points. */
export async function privateLayerConsole(p: Principal) {
  requireStaff(p)
  return withPrincipal(
    p,
    async (tx) => {
      await requireAny(
        tx,
        p,
        ['private_layer.manage', 'security.administer'],
        'the private-layer console',
      )
      const ns = await tx.query(
        `select id, namespace, description, state, db_principal, declared_jobs, declared_mounts
           from deedbox.private_namespace order by id`,
      )
      const slots = await tx.query(`select id, slot, entry_key, value from deedbox.config_slot order by slot, entry_key`)
      const points = await tx.query(
        `select point_key, location, contract_version, deprecation_state
           from deedbox.ui_extension_point order by point_key`,
      )
      const violations = await tx.query(
        `select a.id, a.summary, a.raised_at, a.acknowledged_at
           from deedbox.anomaly_alert a
           join deedbox.anomaly_rule r on r.id = a.rule
          where r.key = 'private_layer_violation'
          order by a.raised_at desc limit 20`,
      )
      return {
        namespaces: ns.rows,
        namespace: ns.rows[0] ?? null,
        slots: slots.rows,
        extensionPoints: points.rows,
        violations: violations.rows,
      }
    },
    { readOnly: true },
  )
}

/** Exceptions routing view: the active exception-workflow declaration, read-only. */
export async function exceptionsRouting(p: Principal) {
  requireStaff(p)
  return withPrincipal(
    p,
    async (tx) => {
      const r = await tx.query(
        `select pd.body
           from deedbox.pack_declaration pd
           join deedbox.country_pack cp on cp.active_version = pd.pack_version
           join deedbox.firm f on f.country_pack = cp.id
          where f.id = $1 and pd.rule_point = 'money.exception_workflow'`,
        [p.firm],
      )
      return r.rows[0]?.body ?? null
    },
    { readOnly: true },
  )
}
