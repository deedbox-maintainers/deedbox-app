// The private-layer operations, over the 0029 shape: registration
// provisions a REAL database principal holding SELECT on the issued views
// and nothing else; the lifecycle revokes, regrants and freezes those
// grants; configuration slots validate per their shipped shapes;
// mount_check triages declared extension mounts against the
// ui_extension_point catalogue; and repeated view-contract violations raise
// the shipped anomaly and auto-suspend the namespace.
//
// Implementation notes:
// - The principal's role name IS the namespace (pl_…): one name, one role,
//   one identity — and the op demands at least one character after the
//   prefix even though the column's literal 3-30 check would allow bare
//   'pl_'.
// - retire demands evidence of a FULL export (an export.performed register
//   entry within 7 days whose detail names scope 'everything'). No full
//   export operation exists yet, so retirement refuses 'export_required'
//   honestly until the data-out surface lands.
// - Auto-suspension threshold: the shipped private_layer_violation rule is
//   {"any": true} (every report raises an alert); the namespace suspends on
//   the THIRD alert inside 60 minutes — the count lives here, the evidence
//   on the register.
// - Slot validation mirrors the billing payment-details discipline for
//   bank_details: pack-declared identifier keys when declared, else the
//   neutral default's own words — account label and account number, both
//   required. bank_details changes are money-significant (privileged).

import { randomBytes } from 'node:crypto'
import type { Principal, Tx } from '@/lib/db'
import { withPrincipal, emitRegister, OperationRefused } from '@/lib/db'
import { requireCapability, hasCapability } from '@/lib/ops/shared'
import { raiseAnomalyInTx } from '@/lib/ops/security/anomalyJobs'

const NAMESPACE_SHAPE = /^pl_[a-z_]{1,27}$/

interface NamespaceRow {
  id: number
  namespace: string
  description: string
  state: 'registered' | 'suspended' | 'retired'
  db_principal: string
  declared_jobs: unknown
  declared_mounts: { point: string; contract?: string; title?: string }[] | null
}

async function loadNamespace(tx: Tx, namespace: string): Promise<NamespaceRow> {
  const r = await tx.query(
    `select id, namespace, description, state, db_principal, declared_jobs, declared_mounts
       from deedbox.private_namespace where namespace = $1`,
    [namespace],
  )
  if (r.rowCount === 0) throw new OperationRefused('not_found', 'no namespace by that name')
  return r.rows[0] as unknown as NamespaceRow
}

function newSecret(): string {
  return randomBytes(24).toString('base64url')
}

/** register_namespace — row, principal role, view grants, privileged register. */
export async function registerNamespace(
  p: Principal,
  input: {
    namespace: string
    description: string
    declaredJobs?: unknown
    declaredMounts?: { point: string; contract?: string; title?: string }[]
  },
): Promise<{ id: number; secret: string }> {
  const namespace = input.namespace.trim()
  if (!NAMESPACE_SHAPE.test(namespace)) {
    throw new OperationRefused(
      'namespace_shape',
      'a namespace lives under the reserved pl_ prefix: lowercase letters and underscores, at most 30 characters',
    )
  }
  if (!input.description.trim()) {
    throw new OperationRefused('description_required', 'say what the namespace is for')
  }
  const secret = newSecret()
  return withPrincipal(p, async (tx) => {
    await requireCapability(tx, p, 'private_layer.manage')
    const dup = await tx.query(`select 1 from deedbox.private_namespace where namespace = $1`, [
      namespace,
    ])
    if (dup.rowCount! > 0) {
      throw new OperationRefused('namespace_exists', 'that namespace is already registered')
    }
    const row = await tx.query(
      `insert into deedbox.private_namespace
         (namespace, description, db_principal, declared_jobs, declared_mounts)
       values ($1, $2, $1, $3, $4) returning id`,
      [
        namespace,
        input.description.trim(),
        input.declaredJobs === undefined ? null : JSON.stringify(input.declaredJobs),
        input.declaredMounts === undefined ? null : JSON.stringify(input.declaredMounts),
      ],
    )
    await tx.query(`select deedbox.private_layer_provision($1, $2)`, [namespace, secret])
    await emitRegister(tx, p, {
      kind: 'namespace.changed',
      subjectType: 'private_namespace',
      subject: row.rows[0].id as number,
      privileged: true,
      detail: {
        before: null,
        after: {
          namespace,
          state: 'registered',
          db_principal: namespace,
          grants: 'select on the issued views (pl_views)',
        },
      },
    })
    return { id: row.rows[0].id as number, secret }
  })
}

/** rotate_principal_secret — privileged, registered; the new secret shows once. */
export async function rotatePrincipalSecret(
  p: Principal,
  input: { namespace: string },
): Promise<{ secret: string }> {
  const secret = newSecret()
  return withPrincipal(p, async (tx) => {
    await requireCapability(tx, p, 'private_layer.manage')
    const ns = await loadNamespace(tx, input.namespace)
    if (ns.state === 'retired') {
      throw new OperationRefused('namespace_retired', 'a retired namespace is terminal')
    }
    await tx.query(`select deedbox.private_layer_rotate($1, $2)`, [ns.db_principal, secret])
    await emitRegister(tx, p, {
      kind: 'namespace.changed',
      subjectType: 'private_namespace',
      subject: ns.id,
      privileged: true,
      detail: {
        before: { namespace: ns.namespace, secret: 'previous' },
        after: { namespace: ns.namespace, secret: 'rotated' },
      },
    })
    return { secret }
  })
}

/** registered → suspended: view grants revoked immediately, mounts go dark. */
export async function suspendNamespace(
  p: Principal,
  input: { namespace: string; reason: string },
): Promise<void> {
  if (!input.reason.trim()) {
    throw new OperationRefused('reason_required', 'a suspension carries its reason')
  }
  await withPrincipal(p, async (tx) => {
    await requireCapability(tx, p, 'private_layer.manage')
    const ns = await loadNamespace(tx, input.namespace)
    if (ns.state !== 'registered') {
      throw new OperationRefused('not_registered', `the namespace is ${ns.state}`)
    }
    await suspendInTx(tx, p, ns, input.reason.trim())
  })
}

/** The shared suspension body — the manual path and the violation path use one. */
async function suspendInTx(tx: Tx, p: Principal, ns: NamespaceRow, reason: string): Promise<void> {
  await tx.query(`update deedbox.private_namespace set state = 'suspended' where id = $1`, [ns.id])
  await tx.query(`select deedbox.private_layer_revoke($1, false)`, [ns.db_principal])
  await emitRegister(tx, p, {
    kind: 'namespace.changed',
    subjectType: 'private_namespace',
    subject: ns.id,
    privileged: true,
    reason,
    detail: {
      before: { state: 'registered', grants: 'select on the issued views (pl_views)' },
      after: { state: 'suspended', grants: 'none — revoked' },
    },
  })
}

/** suspended → registered: grants restored. */
export async function reinstateNamespace(p: Principal, input: { namespace: string }): Promise<void> {
  await withPrincipal(p, async (tx) => {
    await requireCapability(tx, p, 'private_layer.manage')
    const ns = await loadNamespace(tx, input.namespace)
    if (ns.state !== 'suspended') {
      throw new OperationRefused('not_suspended', `the namespace is ${ns.state}`)
    }
    await tx.query(`update deedbox.private_namespace set state = 'registered' where id = $1`, [
      ns.id,
    ])
    await tx.query(`select deedbox.private_layer_regrant($1)`, [ns.db_principal])
    await emitRegister(tx, p, {
      kind: 'namespace.changed',
      subjectType: 'private_namespace',
      subject: ns.id,
      privileged: true,
      detail: {
        before: { state: 'suspended', grants: 'none — revoked' },
        after: { state: 'registered', grants: 'select on the issued views (pl_views)' },
      },
    })
  })
}

/**
 * Retirement (terminal). Guard: a FULL export (scope 'everything')
 * within the last 7 days, so retirement never destroys the only copy. No
 * full-export operation exists yet, so this refuses honestly until the
 * data-out surface lands.
 */
export async function retireNamespace(p: Principal, input: { namespace: string }): Promise<void> {
  await withPrincipal(p, async (tx) => {
    await requireCapability(tx, p, 'private_layer.manage')
    const ns = await loadNamespace(tx, input.namespace)
    if (ns.state === 'retired') {
      throw new OperationRefused('namespace_retired', 'the namespace is already retired')
    }
    const evidence = await tx.query(
      `select 1 from deedbox.register_entry
        where firm = $1
          and event_kind = 'export.performed'
          and occurred_at > now() - interval '7 days'
          and detail->'after'->>'scope' = 'everything'
        limit 1`,
      [p.firm],
    )
    if (evidence.rowCount === 0) {
      throw new OperationRefused(
        'export_required',
        'retirement needs a full export (scope: everything) taken within the last 7 days — none exists',
      )
    }
    await tx.query(`update deedbox.private_namespace set state = 'retired' where id = $1`, [ns.id])
    await tx.query(`select deedbox.private_layer_revoke($1, true)`, [ns.db_principal])
    await emitRegister(tx, p, {
      kind: 'namespace.changed',
      subjectType: 'private_namespace',
      subject: ns.id,
      privileged: true,
      detail: {
        before: { state: ns.state, grants: ns.state === 'registered' ? 'select on the issued views (pl_views)' : 'none — revoked' },
        after: { state: 'retired', grants: 'none — revoked, login frozen' },
      },
    })
  })
}

// ---------------------------------------------------------------------------
// set_config_slot — validation per the shipped slot shapes.
// ---------------------------------------------------------------------------

const SLOT_KEYS: Record<string, string[]> = {
  branding: ['display_name', 'logo', 'icon', 'colour_primary', 'colour_secondary', 'choice'],
  timezone_display: ['date_format', 'time_format'],
}

async function packIdentifierKeys(tx: Tx, firm: number): Promise<string[] | null> {
  const r = await tx.query(
    `select d.body from deedbox.pack_declaration d
       join deedbox.firm f on f.id = $1
       join deedbox.country_pack cp on cp.id = f.country_pack
       join deedbox.pack_version v on v.id = d.pack_version and v.id = cp.active_version
      where d.rule_point = 'bank.account_identifiers'`,
    [firm],
  )
  for (const row of r.rows) {
    const b = row.body as { fields?: { key: string }[] }
    if (b.fields && b.fields.length > 0) return b.fields.map((f) => f.key)
  }
  return null
}

export async function setConfigSlot(
  p: Principal,
  input: { slot: 'branding' | 'bank_details' | 'timezone_display' | 'custom_entry'; entryKey: string; value: Record<string, unknown> },
): Promise<void> {
  const entryKey = input.entryKey.trim()
  if (!entryKey) throw new OperationRefused('entry_key_required', 'a slot entry needs its key')
  if (typeof input.value !== 'object' || input.value === null || Array.isArray(input.value)) {
    throw new OperationRefused('value_shape', 'a slot value is a document of named fields')
  }
  await withPrincipal(p, async (tx) => {
    // branding, bank_details and timezone_display are also open to
    // security.administer; custom_entry is the layer's own
    const allowedToAdmin = input.slot !== 'custom_entry'
    if (!(await hasCapability(tx, p.id, 'private_layer.manage'))) {
      if (!allowedToAdmin || !(await hasCapability(tx, p.id, 'security.administer'))) {
        throw new OperationRefused('capability_missing', 'this needs private_layer.manage')
      }
    }

    if (input.slot === 'branding' || input.slot === 'timezone_display') {
      for (const k of Object.keys(input.value)) {
        if (!SLOT_KEYS[input.slot].includes(k)) {
          throw new OperationRefused('unknown_field', `the ${input.slot} slot has no ${k} field`)
        }
        if (typeof input.value[k] !== 'string') {
          throw new OperationRefused('value_shape', `${k} must be text`)
        }
      }
    } else if (input.slot === 'bank_details') {
      const v = input.value as Record<string, unknown>
      if (typeof v.account_label !== 'string' || !v.account_label.trim()) {
        throw new OperationRefused('incomplete', 'bank details need their account label')
      }
      const keys = await packIdentifierKeys(tx, p.firm)
      const required = keys ?? ['account_number']
      for (const k of required) {
        if (typeof v[k] !== 'string' || !(v[k] as string).trim()) {
          throw new OperationRefused('incomplete', `the pack requires the ${k} identifier`)
        }
      }
      for (const given of Object.keys(v)) {
        if (given === 'account_label') continue
        if (!required.includes(given)) {
          throw new OperationRefused('unknown_field', `the pack declares no ${given} identifier`)
        }
      }
    } else {
      // custom_entry: keys belong to a registered namespace
      const m = entryKey.match(/^(pl_[a-z_]+)\..+$/)
      if (!m) {
        throw new OperationRefused(
          'entry_key_shape',
          'custom entries are namespaced: pl_<namespace>.<key>',
        )
      }
      const owner = await tx.query(
        `select state from deedbox.private_namespace where namespace = $1`,
        [m[1]],
      )
      if (owner.rowCount === 0 || owner.rows[0].state === 'retired') {
        throw new OperationRefused('namespace_unknown', `no live namespace ${m[1]} is registered`)
      }
    }

    const before = await tx.query(
      `select id, value from deedbox.config_slot where slot = $1 and entry_key = $2`,
      [input.slot, entryKey],
    )
    let slotId: number
    if (before.rowCount === 0) {
      const ins = await tx.query(
        `insert into deedbox.config_slot (slot, entry_key, value) values ($1, $2, $3) returning id`,
        [input.slot, entryKey, JSON.stringify(input.value)],
      )
      slotId = ins.rows[0].id as number
    } else {
      slotId = before.rows[0].id as number
      await tx.query(`update deedbox.config_slot set value = $2 where id = $1`, [
        slotId,
        JSON.stringify(input.value),
      ])
    }
    await emitRegister(tx, p, {
      kind: 'setting.changed',
      subjectType: 'config_slot',
      subject: slotId,
      privileged: input.slot === 'bank_details', // money-significant
      detail: {
        before: { slot: input.slot, entry_key: entryKey, value: before.rows[0]?.value ?? null },
        after: { slot: input.slot, entry_key: entryKey, value: input.value },
      },
    })
  })
}

// ---------------------------------------------------------------------------
// mount_check — declared mounts triaged against the ui_extension_point catalogue.
// ---------------------------------------------------------------------------

export interface MountVerdicts {
  current: { namespace: string; point: string; title?: string }[]
  deprecated: { namespace: string; point: string; title?: string }[]
  retired: { namespace: string; point: string; title?: string }[]
  unknown: { namespace: string; point: string; title?: string }[]
}

/** Suspended and retired namespaces mount nothing; retired points refuse loudly. */
export async function mountCheck(p: Principal): Promise<MountVerdicts> {
  return withPrincipal(
    p,
    async (tx) => {
      const namespaces = await tx.query(
        `select namespace, declared_mounts from deedbox.private_namespace
          where state = 'registered' and declared_mounts is not null`,
      )
      const points = await tx.query(
        `select point_key, deprecation_state from deedbox.ui_extension_point`,
      )
      const stateOf = new Map(points.rows.map((r) => [r.point_key as string, r.deprecation_state as string]))
      const verdicts: MountVerdicts = { current: [], deprecated: [], retired: [], unknown: [] }
      for (const ns of namespaces.rows) {
        const mounts = (ns.declared_mounts ?? []) as { point: string; title?: string }[]
        for (const m of mounts) {
          const entry = { namespace: ns.namespace as string, point: m.point, title: m.title }
          const state = stateOf.get(m.point)
          if (state === undefined) verdicts.unknown.push(entry)
          else if (state === 'current') verdicts.current.push(entry)
          else if (state === 'deprecated') verdicts.deprecated.push(entry)
          else verdicts.retired.push(entry)
        }
      }
      return verdicts
    },
    { readOnly: true },
  )
}

// ---------------------------------------------------------------------------
// The lifecycle's automatic arm — view-contract violations.
// ---------------------------------------------------------------------------

/**
 * Record one observed view-contract violation: raises the shipped
 * private_layer_violation anomaly (alert + anomaly.raised + admin email),
 * and on the THIRD alert inside 60 minutes suspends the namespace in the
 * same transaction. Detection is the deployment's job (the platform
 * observes the principal's refused reads); this operation is the record.
 */
export async function reportPrivateLayerViolation(
  p: Principal,
  input: { namespace: string; summary: string },
): Promise<{ suspended: boolean }> {
  if (!input.summary.trim()) {
    throw new OperationRefused('summary_required', 'say what the violation was')
  }
  return withPrincipal(p, async (tx) => {
    const ns = await loadNamespace(tx, input.namespace)
    await raiseAnomalyInTx(tx, p, {
      ruleKey: 'private_layer_violation',
      entries: [],
      summary: `[${ns.namespace}] ${input.summary.trim()}`,
    })
    if (ns.state !== 'registered') return { suspended: false }
    const recent = await tx.query(
      `select count(*)::int as n
         from deedbox.anomaly_alert a
         join deedbox.anomaly_rule r on r.id = a.rule
        where r.key = 'private_layer_violation'
          and a.raised_at > now() - interval '60 minutes'
          and a.summary like '[' || $1 || ']%'`,
      [ns.namespace],
    )
    if ((recent.rows[0].n as number) >= 3) {
      await suspendInTx(tx, p, ns, 'automatic: repeated view-contract violations')
      return { suspended: true }
    }
    return { suspended: false }
  })
}
