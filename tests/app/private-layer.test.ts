// The private layer (over schema 0029): the namespace lifecycle with its
// REAL database principal, configuration-slot validation per the shipped
// shapes, mount triage against the extension-point catalogue, and the
// violation → anomaly → auto-suspension arm.
//
// Cross-suite contract: runs after plumbing, before reports. Flips no firm
// settings. Mutates two CATALOGUE extension points (party.side_panel →
// deprecated, dashboard.slot → retired) — catalogue state is deployment
// data no other suite asserts on; the mounts triage here is the only
// consumer. Roles created by provisioning are cluster-global and pl_-tagged
// per fixture, so they collide with nothing.

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import type { Pool } from 'pg'
import { closePool } from '@/lib/db'
import type { Principal } from '@/lib/db'
import {
  registerNamespace,
  rotatePrincipalSecret,
  suspendNamespace,
  reinstateNamespace,
  retireNamespace,
  setConfigSlot,
  mountCheck,
  reportPrivateLayerViolation,
} from '@/lib/ops/config'
import { makeAdminPool, buildFixture, type Fixture } from './helpers'

let admin: Pool
let fx: Fixture
let P: Principal
let lawyer: number
let L: Principal

beforeAll(async () => {
  admin = makeAdminPool()
  fx = await buildFixture(admin, 'plr')
  P = { kind: 'staff', id: fx.staff, firm: fx.firm }
  const role = await admin.query(`select id from deedbox.role where system_key = 'lawyer'`)
  const s = await admin.query(
    `insert into deedbox.staff_member (person_name, login, role, office, email)
     values ('{"given":"Law","family":"Only"}', 'law.plr', $1, $2, 'law.plr@example.test')
     returning id`,
    [role.rows[0].id, fx.office],
  )
  lawyer = s.rows[0].id as number
  L = { kind: 'staff', id: lawyer, firm: fx.firm }
})

afterAll(async () => {
  await closePool()
  await admin.end()
})

describe('namespace registration and the database principal', () => {
  it('registers, provisions a login role holding exactly the issued views, and registers it privileged', async () => {
    const r = await registerNamespace(P, {
      namespace: 'pl_plr_pkg',
      description: 'private-layer suite package',
      declaredMounts: [{ point: 'matter.side_panel', title: 'PLR panel' }],
    })
    expect(r.secret.length).toBeGreaterThanOrEqual(24)

    const row = await admin.query(
      `select state, db_principal from deedbox.private_namespace where namespace = 'pl_plr_pkg'`,
    )
    expect(row.rows[0]).toEqual({ state: 'registered', db_principal: 'pl_plr_pkg' })

    const role = await admin.query(
      `select rolcanlogin from pg_catalog.pg_roles where rolname = 'pl_plr_pkg'`,
    )
    expect(role.rowCount).toBe(1)
    expect(role.rows[0].rolcanlogin).toBe(true)
    const granted = await admin.query(
      `select has_table_privilege('pl_plr_pkg', 'pl_views.visible_matters', 'select') as v,
              has_table_privilege('pl_plr_pkg', 'deedbox.matter', 'select') as base,
              has_schema_privilege('pl_plr_pkg', 'deedbox', 'usage') as core`,
    )
    expect(granted.rows[0]).toEqual({ v: true, base: false, core: false })
    const ownSchema = await admin.query(
      `select schema_owner from information_schema.schemata where schema_name = 'pl_plr_pkg'`,
    )
    expect(ownSchema.rows[0]?.schema_owner).toBe('pl_plr_pkg')

    const reg = await admin.query(
      `select privileged, detail from deedbox.register_entry
        where event_kind = 'namespace.changed' and subject = $1
        order by id limit 1`,
      [r.id],
    )
    expect(reg.rows[0].privileged).toBe(true)
    expect(reg.rows[0].detail.before).toBeNull()
    expect(reg.rows[0].detail.after.state).toBe('registered')
  })

  it('refuses a duplicate, a bad prefix, a bare description and a non-holder', async () => {
    await expect(
      registerNamespace(P, { namespace: 'pl_plr_pkg', description: 'again' }),
    ).rejects.toMatchObject({ code: 'namespace_exists' })
    await expect(
      registerNamespace(P, { namespace: 'firm_oldstyle', description: 'x' }),
    ).rejects.toMatchObject({ code: 'namespace_shape' })
    await expect(
      registerNamespace(P, { namespace: 'pl_UPPER', description: 'x' }),
    ).rejects.toMatchObject({ code: 'namespace_shape' })
    await expect(
      registerNamespace(P, { namespace: 'pl_ok_name', description: '  ' }),
    ).rejects.toMatchObject({ code: 'description_required' })
    await expect(
      registerNamespace(L, { namespace: 'pl_lawyer_try', description: 'not allowed' }),
    ).rejects.toMatchObject({ code: 'capability_missing' })
  })

  it('rotates the secret (shown once, registered)', async () => {
    const r = await rotatePrincipalSecret(P, { namespace: 'pl_plr_pkg' })
    expect(r.secret.length).toBeGreaterThanOrEqual(24)
    const reg = await admin.query(
      `select count(*)::int as n from deedbox.register_entry
        where event_kind = 'namespace.changed'
          and detail->'after'->>'secret' = 'rotated'`,
    )
    expect(reg.rows[0].n).toBeGreaterThanOrEqual(1)
  })
})

describe('the lifecycle', () => {
  it('suspension revokes the view grants immediately; reinstatement restores them', async () => {
    await suspendNamespace(P, { namespace: 'pl_plr_pkg', reason: 'suite: manual suspension' })
    let g = await admin.query(
      `select has_table_privilege('pl_plr_pkg', 'pl_views.visible_matters', 'select') as v`,
    )
    expect(g.rows[0].v).toBe(false)
    const st = await admin.query(
      `select state from deedbox.private_namespace where namespace = 'pl_plr_pkg'`,
    )
    expect(st.rows[0].state).toBe('suspended')

    await expect(
      suspendNamespace(P, { namespace: 'pl_plr_pkg', reason: 'twice' }),
    ).rejects.toMatchObject({ code: 'not_registered' })

    await reinstateNamespace(P, { namespace: 'pl_plr_pkg' })
    g = await admin.query(
      `select has_table_privilege('pl_plr_pkg', 'pl_views.visible_matters', 'select') as v`,
    )
    expect(g.rows[0].v).toBe(true)
  })

  it('a suspension without a reason refuses', async () => {
    await expect(
      suspendNamespace(P, { namespace: 'pl_plr_pkg', reason: '  ' }),
    ).rejects.toMatchObject({ code: 'reason_required' })
  })

  it('retirement demands a full export within 7 days, then freezes everything, terminally', async () => {
    await expect(retireNamespace(P, { namespace: 'pl_plr_pkg' })).rejects.toMatchObject({
      code: 'export_required',
    })

    // evidence: a full export (scope: everything) — the shape the data-out
    // surface will write; inserted directly as deployment-role scaffolding
    await admin.query(
      `insert into deedbox.register_entry
         (firm, actor_kind, actor, event_kind, subject_type, subject, privileged, detail)
       values ($1, 'system_job', 0, 'export.performed', 'export', 0, true,
               '{"before": null, "after": {"scope": "everything", "rows": 1}}'::jsonb)`,
      [fx.firm],
    )

    await retireNamespace(P, { namespace: 'pl_plr_pkg' })
    const row = await admin.query(
      `select state from deedbox.private_namespace where namespace = 'pl_plr_pkg'`,
    )
    expect(row.rows[0].state).toBe('retired')
    const role = await admin.query(
      `select rolcanlogin from pg_catalog.pg_roles where rolname = 'pl_plr_pkg'`,
    )
    expect(role.rows[0].rolcanlogin).toBe(false)
    const g = await admin.query(
      `select has_table_privilege('pl_plr_pkg', 'pl_views.visible_matters', 'select') as v`,
    )
    expect(g.rows[0].v).toBe(false)

    await expect(reinstateNamespace(P, { namespace: 'pl_plr_pkg' })).rejects.toMatchObject({
      code: 'not_suspended',
    })
    await expect(rotatePrincipalSecret(P, { namespace: 'pl_plr_pkg' })).rejects.toMatchObject({
      code: 'namespace_retired',
    })
  })
})

describe('configuration slots (shapes)', () => {
  it('branding and timezone_display accept their shipped fields only', async () => {
    await setConfigSlot(P, {
      slot: 'branding',
      entryKey: 'default',
      value: { display_name: 'PLR & Co', colour_primary: '#112233' },
    })
    await setConfigSlot(P, {
      slot: 'timezone_display',
      entryKey: 'default',
      value: { date_format: 'DD Mon YYYY' },
    })
    await expect(
      setConfigSlot(P, { slot: 'branding', entryKey: 'default', value: { tagline: 'x' } }),
    ).rejects.toMatchObject({ code: 'unknown_field' })

    // the update carries before/after on the register
    await setConfigSlot(P, {
      slot: 'branding',
      entryKey: 'default',
      value: { display_name: 'PLR & Co (renamed)' },
    })
    const reg = await admin.query(
      `select detail from deedbox.register_entry
        where event_kind = 'setting.changed' and subject_type = 'config_slot'
          and detail->'after'->'value'->>'display_name' = 'PLR & Co (renamed)'
        order by id desc limit 1`,
    )
    expect(reg.rows[0].detail.before.value.display_name).toBe('PLR & Co')
  })

  it('bank_details follows the pack schema (neutral default here) and registers privileged', async () => {
    await expect(
      setConfigSlot(P, {
        slot: 'bank_details',
        entryKey: 'office',
        value: { account_label: 'Office account' },
      }),
    ).rejects.toMatchObject({ code: 'incomplete' })
    await expect(
      setConfigSlot(P, {
        slot: 'bank_details',
        entryKey: 'office',
        value: { account_label: 'Office account', account_number: '123456', extra_code: 'x' },
      }),
    ).rejects.toMatchObject({ code: 'unknown_field' })
    await setConfigSlot(P, {
      slot: 'bank_details',
      entryKey: 'office',
      value: { account_label: 'Office account', account_number: '123456' },
    })
    const reg = await admin.query(
      `select privileged from deedbox.register_entry
        where event_kind = 'setting.changed' and subject_type = 'config_slot'
          and detail->'after'->>'entry_key' = 'office'
        order by id desc limit 1`,
    )
    expect(reg.rows[0].privileged).toBe(true)
  })

  it('custom entries belong to a live registered namespace', async () => {
    const ns = await registerNamespace(P, {
      namespace: 'pl_plr_live',
      description: 'slot owner',
    })
    expect(ns.id).toBeGreaterThan(0)
    await setConfigSlot(P, {
      slot: 'custom_entry',
      entryKey: 'pl_plr_live.greeting',
      value: { text: 'hello' },
    })
    await expect(
      setConfigSlot(P, { slot: 'custom_entry', entryKey: 'unnamespaced', value: { a: 1 } }),
    ).rejects.toMatchObject({ code: 'entry_key_shape' })
    await expect(
      setConfigSlot(P, {
        slot: 'custom_entry',
        entryKey: 'pl_never_registered.k',
        value: { a: 1 },
      }),
    ).rejects.toMatchObject({ code: 'namespace_unknown' })
    // a retired namespace no longer owns new entries
    await expect(
      setConfigSlot(P, { slot: 'custom_entry', entryKey: 'pl_plr_pkg.k', value: { a: 1 } }),
    ).rejects.toMatchObject({ code: 'namespace_unknown' })
  })

  it('a non-holder is refused', async () => {
    await expect(
      setConfigSlot(L, { slot: 'branding', entryKey: 'default', value: { display_name: 'x' } }),
    ).rejects.toMatchObject({ code: 'capability_missing' })
  })
})

describe('mount triage (mount_check)', () => {
  it('triages declared mounts against the catalogue; suspended namespaces go dark', async () => {
    await admin.query(
      `update deedbox.ui_extension_point
          set deprecation_state = 'deprecated', deprecated_at = now(),
              earliest_retirement = (now() + interval '12 months')::date
        where point_key = 'party.side_panel'`,
    )
    await admin.query(
      `update deedbox.ui_extension_point set deprecation_state = 'retired'
        where point_key = 'dashboard.slot'`,
    )
    const r = await registerNamespace(P, {
      namespace: 'pl_plr_mounts',
      description: 'mount triage',
      declaredMounts: [
        { point: 'matter.side_panel', title: 'ok' },
        { point: 'party.side_panel', title: 'ageing' },
        { point: 'dashboard.slot', title: 'dead' },
        { point: 'no.such_point', title: 'typo' },
      ],
    })
    expect(r.id).toBeGreaterThan(0)

    const v = await mountCheck(P)
    const mine = (list: { namespace: string; point: string }[]) =>
      list.filter((m) => m.namespace === 'pl_plr_mounts').map((m) => m.point)
    expect(mine(v.current)).toEqual(['matter.side_panel'])
    expect(mine(v.deprecated)).toEqual(['party.side_panel'])
    expect(mine(v.retired)).toEqual(['dashboard.slot'])
    expect(mine(v.unknown)).toEqual(['no.such_point'])

    await suspendNamespace(P, { namespace: 'pl_plr_mounts', reason: 'suite: dark test' })
    const after = await mountCheck(P)
    expect(mine(after.current)).toEqual([])
    expect(mine(after.retired)).toEqual([])
    await reinstateNamespace(P, { namespace: 'pl_plr_mounts' })
  })
})

describe('violations → anomaly → automatic suspension', () => {
  it('each report raises the shipped anomaly; the third inside the hour suspends', async () => {
    const ns = await registerNamespace(P, {
      namespace: 'pl_plr_naughty',
      description: 'violation source',
    })
    expect(ns.id).toBeGreaterThan(0)

    const one = await reportPrivateLayerViolation(P, {
      namespace: 'pl_plr_naughty',
      summary: 'read refused on deedbox.matter',
    })
    expect(one.suspended).toBe(false)
    const two = await reportPrivateLayerViolation(P, {
      namespace: 'pl_plr_naughty',
      summary: 'read refused on deedbox.ledger_line',
    })
    expect(two.suspended).toBe(false)
    const three = await reportPrivateLayerViolation(P, {
      namespace: 'pl_plr_naughty',
      summary: 'read refused on deedbox.bill',
    })
    expect(three.suspended).toBe(true)

    const st = await admin.query(
      `select state from deedbox.private_namespace where namespace = 'pl_plr_naughty'`,
    )
    expect(st.rows[0].state).toBe('suspended')
    const g = await admin.query(
      `select has_table_privilege('pl_plr_naughty', 'pl_views.visible_matters', 'select') as v`,
    )
    expect(g.rows[0].v).toBe(false)

    const alerts = await admin.query(
      `select count(*)::int as n from deedbox.anomaly_alert a
         join deedbox.anomaly_rule r on r.id = a.rule
        where r.key = 'private_layer_violation' and a.summary like '[pl_plr_naughty]%'`,
    )
    expect(alerts.rows[0].n).toBe(3)

    // the suspension is registered with its automatic reason
    const reg = await admin.query(
      `select reason from deedbox.register_entry
        where event_kind = 'namespace.changed'
          and detail->'after'->>'state' = 'suspended'
        order by id desc limit 1`,
    )
    expect(reg.rows[0].reason).toContain('automatic')
  })
})
