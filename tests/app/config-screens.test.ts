// Screens foundation: the configuration domain's operations as built this
// slice, the security additions (role administration, the auth-policy
// save, generic restore, anomaly acknowledge), the auth plumbing (signed
// cookie + seam), and the predicate-governed reads behind the
// configuration and security screens.
//
// Cross-suite contracts (this file sorts after b*, before i*):
//   * Settings it changes (softdelete.retention_days,
//     conflict.restricted_match_contact, money.default_client_account) are
//     restored to their neutral defaults before the file ends.
//   * The shipped top_up_request number format is replaced and then
//     replaced BACK to its shipped shape, with series continuity proven in
//     both directions — later suites see the shipped pattern.
//   * Adds ONE firm time category (additive; later suites enumerate none).
//   * Roles, templates, fields and lists it creates are tag-named (xcfg).
//   * auth_policy rows are per-firm and this file's firm is its own.

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import type { Pool } from 'pg'
import { closePool, withPrincipal } from '@/lib/db'
import type { Principal } from '@/lib/db'
import {
  changeSetting,
  revertSetting,
  cancelScheduledSetting,
  activatePackVersion,
  replaceNumberFormat,
  createChoiceList,
  addChoiceItem,
  relabelChoiceItem,
  setChoiceItemChargeability,
  reorderChoiceItems,
  deactivateChoiceItem,
  deleteUnusedChoiceItem,
  defineCustomField,
  editCustomField,
  setCustomFieldActive,
  writeCustomFieldValueInTx,
  createMessageTemplate,
  editMessageTemplate,
  deactivateMessageTemplate,
} from '@/lib/ops/config'
import {
  createRole,
  setRoleCapability,
  saveAuthPolicy,
  acknowledgeAnomaly,
  restoreSoftDeleted,
  establishStaffSession,
  createStaffMember,
} from '@/lib/ops/security'
import { createNote, softDeleteNote, changeRestriction } from '@/lib/ops/matters'
import { sealSession, openSession } from '@/lib/auth/cookie'
import { signInService, setSignInService } from '@/lib/auth/seam'
import {
  settingsScreen,
  numberingConsole,
  listManager,
  fieldManager,
  templateManager,
  packConsole,
} from '@/lib/reads/config'
import {
  registerStream,
  signInHistory,
  rolesMatrix,
  staffList,
  staffDetail,
  deletedRecords,
  exportHistory,
  securityPolicy,
} from '@/lib/reads/security'
import { makeAdminPool, buildFixture, type Fixture } from './helpers'

let admin: Pool
let fx: Fixture
let P: Principal // the fixture administrator
let accountsStaff: number
let PA: Principal // an accounts-role staff member (register.read, no security.administer)

beforeAll(async () => {
  admin = makeAdminPool()
  fx = await buildFixture(admin, 'xcfg')
  P = { kind: 'staff', id: fx.staff, firm: fx.firm }
  const accountsRole = await admin.query(`select id from deedbox.role where system_key = 'accounts'`)
  const created = await createStaffMember(P, {
    personName: { given: 'Ann', family: 'Counts' },
    login: 'ann.xcfg',
    role: accountsRole.rows[0].id,
    office: fx.office,
    email: 'ann.xcfg@example.test',
  })
  accountsStaff = created.id
  PA = { kind: 'staff', id: accountsStaff, firm: fx.firm }
})

afterAll(async () => {
  await closePool()
  await admin.end()
})

describe('settings', () => {
  it('validation refusals write nothing', async () => {
    const count = async () =>
      (await admin.query(`select count(*)::int as n from deedbox.firm_setting`)).rows[0].n as number
    const before = await count()
    await expect(changeSetting(P, { key: 'no.such_key', value: 1 })).rejects.toMatchObject({
      code: 'unknown_setting',
    })
    await expect(changeSetting(P, { key: 'time.unit_minutes', value: 7 })).rejects.toMatchObject({
      code: 'invalid_value',
    })
    await expect(
      changeSetting(P, { key: 'estimate.default_thresholds', value: [10, 20, 30, 40, 50, 60, 70, 80, 90, 95, 99] }),
    ).rejects.toMatchObject({ code: 'invalid_value' })
    await expect(
      changeSetting(P, { key: 'visibility.staff_scope', value: 'everyone' }),
    ).rejects.toMatchObject({ code: 'invalid_value' })
    await expect(
      changeSetting(P, {
        key: 'softdelete.retention_days',
        value: 30,
        effectiveFrom: new Date(Date.now() - 86400_000).toISOString(),
      }),
    ).rejects.toMatchObject({ code: 'past_dated' })
    await expect(
      changeSetting(P, { key: 'money.default_client_account', value: 99999999 }),
    ).rejects.toMatchObject({ code: 'invalid_value' })
    expect(await count()).toBe(before)
  })

  it('a change takes effect, registers privileged with before/after, and reverting restores the default', async () => {
    await changeSetting(P, { key: 'softdelete.retention_days', value: 45 })
    const v = await admin.query(
      `select deedbox.current_setting_value('softdelete.retention_days') #>> '{}' as v`,
    )
    expect(v.rows[0].v).toBe('45')
    const entry = await admin.query(
      `select privileged, detail from deedbox.register_entry
        where event_kind = 'setting.changed' and detail->>'key' = 'softdelete.retention_days'
        order by id desc limit 1`,
    )
    expect(entry.rows[0].privileged).toBe(true)
    expect(entry.rows[0].detail.before.value).toBe(90)
    expect(entry.rows[0].detail.after.value).toBe(45)

    await revertSetting(P, { key: 'softdelete.retention_days' })
    const v2 = await admin.query(
      `select deedbox.current_setting_value('softdelete.retention_days') #>> '{}' as v`,
    )
    expect(v2.rows[0].v).toBe('90')
  })

  it('a scheduled value does not govern yet, shows on the screen, and cancels cleanly', async () => {
    const future = new Date(Date.now() + 3600_000).toISOString()
    const r = await changeSetting(P, { key: 'undo.bulk_window_days', value: 14, effectiveFrom: future })
    const now = await admin.query(
      `select deedbox.current_setting_value('undo.bulk_window_days') #>> '{}' as v`,
    )
    expect(now.rows[0].v).toBe('7')
    const screen = await settingsScreen(P)
    const row = screen.find((s) => s.key === 'undo.bulk_window_days')!
    expect(row.scheduled.length).toBe(1)
    expect(row.scheduled[0].row).toBe(r.setting)
    await cancelScheduledSetting(P, { key: 'undo.bulk_window_days', settingRow: r.setting })
    // the restoring row sits one second after the scheduled instant and
    // carries the prior (neutral) value, so nothing ever governs at 14
    const rows = await admin.query(
      `select value from deedbox.firm_setting fs join deedbox.setting_definition sd on sd.id = fs.definition
        where sd.key = 'undo.bulk_window_days' order by fs.effective_from desc limit 1`,
    )
    expect(rows.rows[0].value).toBe(7)
  })

  it('named_staff contact demands a real active login and records it', async () => {
    await expect(
      changeSetting(P, { key: 'conflict.restricted_match_contact', value: 'named_staff' }),
    ).rejects.toMatchObject({ code: 'invalid_value' })
    await expect(
      changeSetting(P, {
        key: 'conflict.restricted_match_contact',
        value: 'named_staff',
        staffLogin: 'nobody.here',
      }),
    ).rejects.toMatchObject({ code: 'invalid_value' })
    await changeSetting(P, {
      key: 'conflict.restricted_match_contact',
      value: 'named_staff',
      staffLogin: 'ann.xcfg',
    })
    const entry = await admin.query(
      `select detail from deedbox.register_entry
        where event_kind = 'setting.changed' and detail->>'key' = 'conflict.restricted_match_contact'
        order by id desc limit 1`,
    )
    expect(entry.rows[0].detail.named_login).toBe('ann.xcfg')
    await revertSetting(P, { key: 'conflict.restricted_match_contact' })
  })

  it('the default client account setting accepts the active pooled account', async () => {
    await changeSetting(P, { key: 'money.default_client_account', value: fx.account })
    await revertSetting(P, { key: 'money.default_client_account' })
  })
})

describe('numbering (via 0024)', () => {
  it('replacement changes the pattern without restarting or gapping the series, both directions', async () => {
    const allocate = async () =>
      (await admin.query(`select deedbox.allocate_number('top_up_request') as n`)).rows[0].n as string
    const n1 = await allocate()
    await replaceNumberFormat(P, {
      purpose: 'top_up_request',
      pattern: 'TUX-{SEQ:6}',
      allocationMode: 'gapless',
      reset: 'never',
    })
    const n2 = await allocate()
    expect(n2.startsWith('TUX-')).toBe(true)
    expect(Number(n2.replace(/\D/g, ''))).toBe(Number(n1.replace(/\D/g, '')) + 1)
    // restore the shipped shape; continuity again
    await replaceNumberFormat(P, {
      purpose: 'top_up_request',
      pattern: 'TU-{SEQ:6}',
      allocationMode: 'sequence',
      reset: 'never',
    })
    const n3 = await allocate()
    expect(n3.startsWith('TU-')).toBe(true)
    expect(Number(n3.replace(/\D/g, ''))).toBe(Number(n2.replace(/\D/g, '')) + 1)
    const entries = await admin.query(
      `select count(*)::int as n from deedbox.register_entry
        where event_kind = 'numbering.format_changed' and detail->>'purpose' = 'top_up_request'`,
    )
    expect(entries.rows[0].n).toBeGreaterThanOrEqual(2)
  })

  it('grammar refusals are typed and the console read shows the cards', async () => {
    await expect(
      replaceNumberFormat(P, {
        purpose: 'top_up_request',
        pattern: 'NO-TOKEN',
        allocationMode: 'gapless',
        reset: 'never',
      }),
    ).rejects.toMatchObject({ code: 'invalid_format' })
    await expect(
      replaceNumberFormat(P, {
        purpose: 'not_a_purpose',
        pattern: 'X-{SEQ:4}',
        allocationMode: 'gapless',
        reset: 'never',
      }),
    ).rejects.toMatchObject({ code: 'invalid_format' })
    const cards = await numberingConsole(P)
    const active = cards.filter((c) => c.active)
    expect(active.length).toBeGreaterThanOrEqual(9)
    const bill = active.find((c) => c.purpose === 'bill')!
    expect(bill.pattern).toContain('{SEQ:')
  })
})

describe('lists', () => {
  let list: number
  let item: number

  it('a firm list and items; a time category cannot arrive unclassified', async () => {
    list = (await createChoiceList(P, { purposeKey: 'custom.xcfg_kinds', name: 'XCFG kinds' })).list
    item = (await addChoiceItem(P, { list, label: 'First kind' })).item
    const tc = await admin.query(
      `select id from deedbox.choice_list where purpose_key = 'time_categories'`,
    )
    await expect(addChoiceItem(P, { list: tc.rows[0].id, label: 'XCFG travel' })).rejects.toMatchObject(
      { code: 'chargeability_required' },
    )
    const added = await addChoiceItem(P, {
      list: tc.rows[0].id,
      label: 'XCFG travel',
      countsAsChargeable: true,
    })
    await setChoiceItemChargeability(P, { item: added.item, countsAsChargeable: false })
    const flag = await admin.query(`select counts_as_chargeable from deedbox.choice_item where id = $1`, [
      added.item,
    ])
    expect(flag.rows[0].counts_as_chargeable).toBe(false)
    // the shipped two are immutable — refused before the schema is even asked
    const shipped = await admin.query(
      `select id from deedbox.choice_item where shipped_key = 'chargeable'`,
    )
    await expect(
      setChoiceItemChargeability(P, { item: shipped.rows[0].id, countsAsChargeable: false }),
    ).rejects.toMatchObject({ code: 'shipped_immutable' })
    await expect(deactivateChoiceItem(P, { item: shipped.rows[0].id })).rejects.toMatchObject({
      code: 'shipped_immutable',
    })
  })

  it('relabel and reorder register before/after; reorder demands the whole list', async () => {
    const second = (await addChoiceItem(P, { list, label: 'Second kind' })).item
    await relabelChoiceItem(P, { item, label: 'First kind (renamed)' })
    await expect(reorderChoiceItems(P, { list, orderedItems: [item] })).rejects.toMatchObject({
      code: 'order_incomplete',
    })
    await reorderChoiceItems(P, { list, orderedItems: [second, item] })
    const order = await admin.query(
      `select id from deedbox.choice_item where list = $1 order by position`,
      [list],
    )
    expect(order.rows.map((r) => r.id)).toEqual([second, item])
    const entry = await admin.query(
      `select detail from deedbox.register_entry
        where event_kind = 'list.changed' and subject_type = 'choice_list' and subject = $1
        order by id desc limit 1`,
      [list],
    )
    expect(entry.rows[0].detail.before.order).toEqual([item, second])
    expect(entry.rows[0].detail.after.order).toEqual([second, item])
  })

  it('delete guards: in-use items refuse naming the blocker; unused delete removes the row', async () => {
    const def = await defineCustomField(P, {
      scope: 'matter',
      key: 'xcfg_kind',
      label: 'XCFG kind',
      dataType: 'choice',
      choiceList: list,
    })
    await withPrincipal(P, (tx) =>
      writeCustomFieldValueInTx(tx, {
        definition: def.definition,
        ownerType: 'matter',
        owner: fx.matter,
        value: item,
      }),
    )
    await expect(deleteUnusedChoiceItem(P, { item })).rejects.toMatchObject({ code: 'in_use' })
    const disposable = (await addChoiceItem(P, { list, label: 'Disposable' })).item
    await deleteUnusedChoiceItem(P, { item: disposable })
    const gone = await admin.query(`select 1 from deedbox.choice_item where id = $1`, [disposable])
    expect(gone.rowCount).toBe(0)
    const screen = await listManager(P)
    const mine = screen.items.find((i) => i.id === item)!
    expect(mine.usage).toBe(1)
  })
})

describe('custom fields', () => {
  it('a choice field without a list creates its own; keys are unique among active', async () => {
    const auto = await defineCustomField(P, {
      scope: 'party',
      key: 'xcfg_flavour',
      label: 'XCFG flavour',
      dataType: 'choice',
    })
    const def = await admin.query(
      `select choice_list from deedbox.custom_field_definition where id = $1`,
      [auto.definition],
    )
    expect(def.rows[0].choice_list).not.toBeNull()
    await expect(
      defineCustomField(P, { scope: 'party', key: 'xcfg_flavour', label: 'Again', dataType: 'text' }),
    ).rejects.toMatchObject({ code: 'duplicate_key' })

    await editCustomField(P, { definition: auto.definition, label: 'XCFG flavour (renamed)' })
    await setCustomFieldActive(P, { definition: auto.definition, active: false })
    // deactivation keeps values and frees the key
    const again = await defineCustomField(P, {
      scope: 'party',
      key: 'xcfg_flavour',
      label: 'Replacement',
      dataType: 'text',
    })
    await expect(
      setCustomFieldActive(P, { definition: auto.definition, active: true }),
    ).rejects.toMatchObject({ code: 'duplicate_key' })
    await setCustomFieldActive(P, { definition: again.definition, active: false })
    const screen = await fieldManager(P)
    expect(screen.definitions.some((d) => d.key === 'xcfg_flavour')).toBe(true)
  })
})

describe('templates', () => {
  it('token validation is closed per purpose; email needs a subject; edits register before/after', async () => {
    await expect(
      createMessageTemplate(P, {
        name: 'XCFG bad',
        channel: 'email',
        purpose: 'reminder',
        subject: 'S',
        body: 'Dear {{no_such_token}}',
      }),
    ).rejects.toMatchObject({ code: 'unknown_token' })
    await expect(
      createMessageTemplate(P, {
        name: 'XCFG no subject',
        channel: 'email',
        purpose: 'reminder',
        body: 'Hello {{client_name}}',
      }),
    ).rejects.toMatchObject({ code: 'subject_required' })
    const t = await createMessageTemplate(P, {
      name: 'XCFG first reminder',
      channel: 'email',
      purpose: 'reminder',
      subject: 'About bill {{bill_number}}',
      body: 'Dear {{client_name}}, {{amount_outstanding}} remains outstanding.',
    })
    await expect(
      createMessageTemplate(P, {
        name: 'XCFG first reminder',
        channel: 'email',
        purpose: 'reminder',
        subject: 'S',
        body: 'B',
      }),
    ).rejects.toMatchObject({ code: 'duplicate_name' })
    await editMessageTemplate(P, { template: t.template, body: 'Dear {{client_name}}, a friendly nudge.' })
    const entry = await admin.query(
      `select detail from deedbox.register_entry
        where event_kind = 'template.changed' and subject = $1 and detail ? 'before'
        order by id desc limit 1`,
      [t.template],
    )
    expect(entry.rows[0].detail.before.body).toContain('remains outstanding')
    await deactivateMessageTemplate(P, { template: t.template })
    const screen = await templateManager(P)
    expect(screen.some((row) => row.id === t.template && row.active === false)).toBe(true)
  })
})

describe('pack activation', () => {
  it('activates a valid version of the firm pack, refuses a foreign version, and registers privileged', async () => {
    const pack = await admin.query(`select country_pack as id from deedbox.firm where id = $1`, [fx.firm])
    const v1 = await admin.query(
      `insert into deedbox.pack_version (pack, version) values ($1, 'xcfg-1.0') returning id`,
      [pack.rows[0].id],
    )
    await admin.query(
      `insert into deedbox.pack_declaration (pack_version, rule_point, kind, body)
       values ($1, 'money.dormancy', 'value', '{"period_months": 24}')`,
      [v1.rows[0].id],
    )
    await activatePackVersion(P, { version: v1.rows[0].id })
    const active = await admin.query(`select active_version from deedbox.country_pack where id = $1`, [
      pack.rows[0].id,
    ])
    expect(active.rows[0].active_version).toBe(v1.rows[0].id)
    const entry = await admin.query(
      `select privileged, detail from deedbox.register_entry
        where event_kind = 'pack.activated' and subject = $1 order by id desc limit 1`,
      [pack.rows[0].id],
    )
    expect(entry.rows[0].privileged).toBe(true)
    expect(entry.rows[0].detail.after.active_version).toBe(v1.rows[0].id)

    // a version of someone else's pack refuses
    const foreignPack = await admin.query(
      `insert into deedbox.country_pack (code, name) values ('XFO','Foreign') returning id`,
    )
    const foreignVersion = await admin.query(
      `insert into deedbox.pack_version (pack, version) values ($1, 'f-1') returning id`,
      [foreignPack.rows[0].id],
    )
    await expect(activatePackVersion(P, { version: foreignVersion.rows[0].id })).rejects.toMatchObject({
      code: 'wrong_pack',
    })
    const console_ = await packConsole(P)
    expect(console_!.versions.some((v) => v.version === 'xcfg-1.0')).toBe(true)
    expect(console_!.declarations.some((d) => d.rule_point === 'money.dormancy')).toBe(true)
  })
})

describe('role administration', () => {
  it('grants register the full before/after capability sets; money grants demand the confirmation step', async () => {
    const role = await createRole(P, { name: 'XCFG paralegal' })
    await setRoleCapability(P, { role: role.role, capability: 'conflict.run', scope: 'firm_wide' })
    const entry = await admin.query(
      `select privileged, detail from deedbox.register_entry
        where event_kind = 'permission.changed' and subject = $1 order by id desc limit 1`,
      [role.role],
    )
    expect(entry.rows[0].privileged).toBe(true)
    expect(entry.rows[0].detail.before.capabilities).toEqual({})
    expect(entry.rows[0].detail.after.capabilities['conflict.run']).toBe('firm_wide')

    await expect(
      setRoleCapability(P, { role: role.role, capability: 'money.receive', scope: 'firm_wide' }),
    ).rejects.toMatchObject({ code: 'confirmation_required' })
    await setRoleCapability(P, {
      role: role.role,
      capability: 'money.receive',
      scope: 'firm_wide',
      confirmMoneyAuthorisation: true,
    })
    await setRoleCapability(P, { role: role.role, capability: 'money.receive', scope: 'none' })
    const matrix = await rolesMatrix(P)
    expect(matrix.roles.some((r) => r.name === 'XCFG paralegal')).toBe(true)

    const external = await createRole(P, { name: 'XCFG external', external: true })
    await expect(
      setRoleCapability(P, { role: external.role, capability: 'register.read', scope: 'firm_wide' }),
    ).rejects.toMatchObject({ code: 'safe_bounds' })
  })
})

describe('auth policy (policy screen)', () => {
  it('saves with before/after and gates sign-in until enrolment; restored after', async () => {
    await expect(saveAuthPolicy(P, {
      mfaScope: 'named_roles',
      stepUpOnUnrecognised: true,
      stepUpEmailFallback: true,
    })).rejects.toMatchObject({ code: 'invalid_policy' })

    await saveAuthPolicy(P, { mfaScope: 'all_users', stepUpOnUnrecognised: true, stepUpEmailFallback: true })
    const entry = await admin.query(
      `select privileged, detail from deedbox.register_entry
        where event_kind = 'auth_policy.changed' and subject = $1 order by id desc limit 1`,
      [fx.firm],
    )
    expect(entry.rows[0].privileged).toBe(true)
    expect(entry.rows[0].detail.before.mfa_scope).toBe('off')
    expect(entry.rows[0].detail.after.mfa_scope).toBe('all_users')

    await expect(
      establishStaffSession({
        login: 'ann.xcfg',
        firm: fx.firm,
        device: { fingerprint: 'fp-xcfg-ann' },
      }),
    ).rejects.toMatchObject({ code: 'mfa_enrolment_required' })

    await saveAuthPolicy(P, { mfaScope: 'off', stepUpOnUnrecognised: true, stepUpEmailFallback: true })
    const screen = await securityPolicy(P)
    expect(screen.policy!.mfa_scope).toBe('off')
  })
})

describe('generic restore and anomaly acknowledgement', () => {
  it('restores within the window, refuses beyond it, and dispatches typed domains', async () => {
    // a generic type: a soft-deleted contact point
    const cp = await admin.query(
      `insert into deedbox.contact_point (party, kind, value, deleted_at, deleted_by)
       values ($1, 'email', 'old.xcfg@example.test', now() - interval '5 days', $2) returning id`,
      [fx.clientParty, fx.staff],
    )
    await restoreSoftDeleted(P, { entityType: 'contact_point', id: cp.rows[0].id })
    const restored = await admin.query(`select deleted_at from deedbox.contact_point where id = $1`, [
      cp.rows[0].id,
    ])
    expect(restored.rows[0].deleted_at).toBeNull()
    const entry = await admin.query(
      `select 1 from deedbox.register_entry
        where event_kind = 'record.restored' and subject_type = 'contact_point' and subject = $1`,
      [cp.rows[0].id],
    )
    expect(entry.rowCount).toBe(1)

    // out of window: refused with the window stated, row untouched
    const old = await admin.query(
      `insert into deedbox.contact_point (party, kind, value, deleted_at, deleted_by)
       values ($1, 'email', 'ancient.xcfg@example.test', now() - interval '200 days', $2) returning id`,
      [fx.clientParty, fx.staff],
    )
    await expect(
      restoreSoftDeleted(P, { entityType: 'contact_point', id: old.rows[0].id }),
    ).rejects.toMatchObject({ code: 'window_closed' })

    // a dispatched type: notes restore through their own operation (corpus discipline)
    const note = await createNote(P, { ownerType: 'matter', owner: fx.matter, body: 'XCFG restore note' })
    await softDeleteNote(P, { note: note.id })
    const listing = await deletedRecords(P)
    expect(listing.some((r) => r.entityType === 'note' && r.id === note.id)).toBe(true)
    expect(listing.some((r) => r.entityType === 'contact_point' && r.id === old.rows[0].id)).toBe(true)
    await restoreSoftDeleted(P, { entityType: 'note', id: note.id })
    const noteRow = await admin.query(`select deleted_at from deedbox.note where id = $1`, [note.id])
    expect(noteRow.rows[0].deleted_at).toBeNull()

    await expect(restoreSoftDeleted(P, { entityType: 'issued_bill', id: 1 })).rejects.toMatchObject({
      code: 'not_restorable',
    })
  })

  it('acknowledging an alert is registered and idempotent', async () => {
    const rule = await admin.query(`select id from deedbox.anomaly_rule where key = 'large_export'`)
    const alert = await admin.query(
      `insert into deedbox.anomaly_alert (rule, triggering_register_entries, summary)
       values ($1, '[1]', 'XCFG test alert') returning id`,
      [rule.rows[0].id],
    )
    await acknowledgeAnomaly(P, { alert: alert.rows[0].id })
    await acknowledgeAnomaly(P, { alert: alert.rows[0].id }) // idempotent
    const row = await admin.query(
      `select acknowledged_by from deedbox.anomaly_alert where id = $1`,
      [alert.rows[0].id],
    )
    expect(row.rows[0].acknowledged_by).toBe(fx.staff)
    const entries = await admin.query(
      `select count(*)::int as n from deedbox.register_entry
        where event_kind = 'anomaly.acknowledged' and subject = $1`,
      [alert.rows[0].id],
    )
    expect(entries.rows[0].n).toBe(1)
  })
})

describe('auth plumbing: cookie and seam', () => {
  it('the signed cookie round-trips, refuses tampering, and needs its secret', async () => {
    const prev = process.env.DEEDBOX_COOKIE_SECRET
    process.env.DEEDBOX_COOKIE_SECRET = 'test-secret-xcfg'
    try {
      const sealed = sealSession(12345)!
      expect(openSession(sealed)).toBe(12345)
      expect(openSession(sealed.replace(/.$/, (c) => (c === 'a' ? 'b' : 'a')))).toBeNull()
      expect(openSession('12345.deadbeef')).toBeNull()
      expect(openSession('')).toBeNull()
      process.env.DEEDBOX_COOKIE_SECRET = 'a-different-secret'
      expect(openSession(sealed)).toBeNull()
    } finally {
      if (prev === undefined) delete process.env.DEEDBOX_COOKIE_SECRET
      else process.env.DEEDBOX_COOKIE_SECRET = prev
    }
  })

  it('the sign-in seam refuses typed until bound; the dev binding is explicit', async () => {
    const prev = process.env.DEEDBOX_DEV_SIGNIN
    delete process.env.DEEDBOX_DEV_SIGNIN
    try {
      expect(() => signInService()).toThrowError(/no sign-in service is bound/)
      process.env.DEEDBOX_DEV_SIGNIN = 'allow'
      const dev = signInService()
      expect((await dev.authenticate('x', 'y')).authenticated).toBe(true)
      expect((await dev.authenticate('x', '')).authenticated).toBe(false)
      delete process.env.DEEDBOX_DEV_SIGNIN
      const svc = { authenticate: async () => ({ authenticated: true, mfaSatisfied: true }), verifyStepUpChallenge: async () => true }
      setSignInService(svc)
      expect(signInService()).toBe(svc)
    } finally {
      setSignInService(null)
      if (prev === undefined) delete process.env.DEEDBOX_DEV_SIGNIN
      else process.env.DEEDBOX_DEV_SIGNIN = prev
    }
  })
})

describe('screen reads: predicate and scoping', () => {
  it('the register stream needs register.read and hides a restricted matter from the ungranted', async () => {
    // restrict the fixture matter, admin granting themselves (they see it now)
    await changeRestriction(P, {
      matter: fx.matter,
      change: { action: 'add_grant', granteeKind: 'staff', grantee: fx.staff },
      reason: 'screens-foundation predicate proof',
    })
    const adminView = await registerStream(P, { matter: fx.matter })
    expect(adminView.some((e) => e.event_kind === 'restriction.changed')).toBe(true)

    // the accounts staff holds register.read but no grant: the matter's
    // entries are absent from their stream — not greyed, absent
    const accountsView = await registerStream(PA, { matter: fx.matter })
    expect(accountsView.length).toBe(0)
    const accountsWide = await registerStream(PA, { eventKind: 'restriction.changed' })
    expect(accountsWide.some((e) => e.matter === fx.matter)).toBe(false)

    // privileged-only filter works
    const priv = await registerStream(P, { privilegedOnly: true, matter: fx.matter })
    expect(priv.every((e) => e.privileged)).toBe(true)

    // a lawyer-role staff (no register.read) cannot open the stream at all
    const lawyerRole = await admin.query(`select id from deedbox.role where system_key = 'lawyer'`)
    const lawyer = await createStaffMember(P, {
      personName: { given: 'Lou', family: 'Lawyer' },
      login: 'lou.xcfg',
      role: lawyerRole.rows[0].id,
      office: fx.office,
      email: 'lou.xcfg@example.test',
    })
    await expect(
      registerStream({ kind: 'staff', id: lawyer.id, firm: fx.firm }, {}),
    ).rejects.toMatchObject({ code: 'capability_missing' })
  })

  it('sign-in history scopes to self without security.administer', async () => {
    // ann signs in once (policy is back to off)
    await establishStaffSession({
      login: 'ann.xcfg',
      firm: fx.firm,
      device: { fingerprint: 'fp-xcfg-ann-2' },
    })
    const own = await signInHistory(PA)
    expect(own.length).toBeGreaterThan(0)
    expect(
      own.every(
        (r) =>
          (r.actor_kind === 'staff' && r.actor === accountsStaff) ||
          (r.subject_type === 'staff_member' && r.subject === accountsStaff),
      ),
    ).toBe(true)
    await expect(signInHistory(PA, { allStaff: true })).rejects.toMatchObject({ code: 'not_permitted' })
    const all = await signInHistory(P, { allStaff: true })
    expect(all.length).toBeGreaterThanOrEqual(own.length)
  })

  it('staff, roles and export-history reads honour their gates', async () => {
    const list = await staffList(P, {})
    expect(list.some((s) => s.login === 'ann.xcfg')).toBe(true)
    const detail = await staffDetail(P, accountsStaff)
    expect(detail.staff.role_name).toBe('Accounts')
    await expect(staffDetail(PA, fx.staff)).rejects.toMatchObject({ code: 'capability_missing' })

    // export history: a privileged export entry by the admin is invisible
    // to the accounts staff (not theirs), visible to its actor
    await admin.query(
      `insert into deedbox.register_entry
         (firm, actor_kind, actor, event_kind, subject_type, subject, privileged, detail, artefact)
       values ($1, 'staff', $2, 'export.performed', 'report', 1, true,
               '{"before": null, "after": null, "export": "xcfg-proof", "row_count": 3, "restricted_matter_count": 0}',
               'xcfg-artefact-1')`,
      [fx.firm, fx.staff],
    )
    const adminExports = await exportHistory(P)
    expect(adminExports.some((e) => e.detail?.export === 'xcfg-proof')).toBe(true)
    const accountsExports = await exportHistory(PA)
    expect(accountsExports.some((e) => e.detail?.export === 'xcfg-proof')).toBe(false)
  })
})
