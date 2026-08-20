// Firm setting changes over the insert-only, effective-dated history (0001).
// The catalogue is closed (35 shipped keys); values validate against the
// definition's type and allowed values before anything is written; every
// change registers setting.changed, which the catalogue marks privileged, so
// the entry always carries the full before and after values (0003's trigger
// refuses it bare).
//
// Implementation notes:
//   * conflict.restricted_match_contact stores the plain choice value the
//     runtime reads; under named_staff the accompanying login is validated
//     against active staff and recorded in the change entry's detail (the
//     catalogue types the key as choice, so the value itself stays clean).
//   * money.default_client_account stores the account id; validation
//     resolves it to an active pooled client account at change time.
//   * Cancelling a scheduled value appends a superseding row restoring the
//     value in force before it, stamped one second after the scheduled
//     moment (the history is unique per effective instant, so the exact
//     instant cannot be occupied twice — the restore governs from the next
//     second, and the register records the cancellation honestly).

import type { Principal, Tx } from '@/lib/db'
import { withPrincipal, emitRegister, OperationRefused } from '@/lib/db'
import { requireStaff, requireCapability } from '@/lib/ops/shared'

interface Definition {
  id: number
  key: string
  value_type: string
  neutral_default: unknown
  allowed_values: unknown[] | null
}

async function loadDefinition(tx: Tx, key: string): Promise<Definition> {
  const r = await tx.query(
    `select id, key, value_type, neutral_default, allowed_values
       from deedbox.setting_definition where key = $1`,
    [key],
  )
  if (r.rowCount === 0) {
    throw new OperationRefused('unknown_setting', `no setting named ${key} exists — the catalogue is closed`)
  }
  return r.rows[0] as unknown as Definition
}

async function currentValue(tx: Tx, key: string): Promise<unknown> {
  const r = await tx.query(`select deedbox.current_setting_value($1) as v`, [key])
  return r.rows[0].v
}

/** Validate a candidate value against the definition; returns the jsonb-ready value. */
async function validateValue(tx: Tx, d: Definition, value: unknown): Promise<unknown> {
  const refuse = (why: string): never => {
    throw new OperationRefused('invalid_value', `${d.key}: ${why}`)
  }
  switch (d.value_type) {
    case 'boolean':
      if (typeof value !== 'boolean') refuse('expects true or false')
      break
    case 'integer':
    case 'duration_days':
      if (typeof value !== 'number' || !Number.isInteger(value)) refuse('expects a whole number')
      if (d.value_type === 'duration_days' && (value as number) < 0) refuse('cannot be negative')
      if (d.key === 'time.unit_minutes' && ![1, 2, 3, 5, 6, 10, 12, 15, 20, 30, 60].includes(value as number)) {
        refuse('must divide an hour evenly (1, 2, 3, 5, 6, 10, 12, 15, 20, 30 or 60 minutes)')
      }
      break
    case 'money':
      if (value !== null && (typeof value !== 'number' || !(value >= 0))) {
        refuse('expects an amount, or nothing to clear the threshold')
      }
      break
    case 'percentage':
      if (typeof value !== 'number' || value < 0 || value > 100) refuse('expects 0–100')
      break
    case 'decimal':
      if (typeof value !== 'number' || !Number.isFinite(value)) refuse('expects a number')
      break
    case 'text':
      if (typeof value !== 'string') refuse('expects text')
      break
    case 'doc':
      if (value === null || value === undefined) refuse('expects a structured value')
      if (
        (d.key === 'budget.default_thresholds' || d.key === 'estimate.default_thresholds') &&
        (!Array.isArray(value) ||
          value.length === 0 ||
          value.length > 10 ||
          value.some((v) => typeof v !== 'number' || v <= 0 || v > 100))
      ) {
        refuse('expects up to ten percentages between 1 and 100')
      }
      break
    case 'choice': {
      if (d.key === 'money.default_client_account') {
        if (value === null) break // absent means the form asks
        const acc = await tx.query(
          `select 1 from deedbox.client_account where id = $1 and active and account_kind = 'pooled'`,
          [value],
        )
        if (acc.rowCount === 0) refuse('must name an active pooled client account')
        break
      }
      if (
        !Array.isArray(d.allowed_values) ||
        !d.allowed_values.includes(value as never)
      ) {
        refuse(`must be one of ${JSON.stringify(d.allowed_values)}`)
      }
      break
    }
    default:
      refuse(`unknown value type ${d.value_type}`)
  }
  return value
}

export interface ChangeSettingInput {
  key: string
  value: unknown
  /** ISO timestamp; absent = now. Must not sit in the past (60 s clock grace). */
  effectiveFrom?: string
  /** Accompanies conflict.restricted_match_contact = named_staff. */
  staffLogin?: string
}

/** One appended history row + the privileged register entry, one transaction. */
export async function changeSetting(
  p: Principal,
  input: ChangeSettingInput,
): Promise<{ setting: number }> {
  requireStaff(p)
  return withPrincipal(p, async (tx) => {
    await requireCapability(tx, p, 'settings.manage')
    const d = await loadDefinition(tx, input.key)
    const value = await validateValue(tx, d, input.value)

    const effective = input.effectiveFrom ?? null
    if (effective !== null) {
      const chk = await tx.query(
        `select $1::timestamptz >= now() - interval '60 seconds' as ok, $1::timestamptz as at`,
        [effective],
      )
      if (!chk.rows[0].ok) {
        throw new OperationRefused('past_dated', 'a setting cannot be back-dated — it takes effect now or later')
      }
    }

    let namedStaff: number | null = null
    if (d.key === 'conflict.restricted_match_contact' && value === 'named_staff') {
      if (!input.staffLogin) {
        throw new OperationRefused('invalid_value', 'named_staff needs the staff login to name')
      }
      const s = await tx.query(
        `select id from deedbox.staff_member where lower(login) = lower($1) and active`,
        [input.staffLogin],
      )
      if (s.rowCount === 0) {
        throw new OperationRefused('invalid_value', `${input.staffLogin} is not an active staff login`)
      }
      namedStaff = s.rows[0].id as number
    }

    const before = await currentValue(tx, d.key)
    const ins = await tx.query(
      `insert into deedbox.firm_setting (definition, value, effective_from)
       values ($1, $2::jsonb, coalesce($3::timestamptz, now()))
       returning id, effective_from`,
      [d.id, JSON.stringify(value ?? null), effective],
    )
    await emitRegister(tx, p, {
      kind: 'setting.changed',
      subjectType: 'setting_definition',
      subject: d.id,
      privileged: true,
      detail: {
        key: d.key,
        before: { value: before },
        after: { value: value ?? null, effective_from: ins.rows[0].effective_from },
        ...(namedStaff !== null ? { named_staff: namedStaff, named_login: input.staffLogin } : {}),
      },
    })
    return { setting: ins.rows[0].id as number }
  })
}

/** An explicit row restoring the neutral default; never a deletion. */
export async function revertSetting(p: Principal, input: { key: string }): Promise<{ setting: number }> {
  requireStaff(p)
  const neutral = await withPrincipal(
    p,
    async (tx) => (await loadDefinition(tx, input.key)).neutral_default,
    { readOnly: true },
  )
  return changeSetting(p, { key: input.key, value: neutral })
}

/**
 * Cancel a scheduled (future-effective) value: append the value in force
 * immediately before it, one second after the scheduled instant.
 */
export async function cancelScheduledSetting(
  p: Principal,
  input: { key: string; settingRow: number },
): Promise<{ setting: number }> {
  requireStaff(p)
  return withPrincipal(p, async (tx) => {
    await requireCapability(tx, p, 'settings.manage')
    const d = await loadDefinition(tx, input.key)
    const row = await tx.query(
      `select id, value, effective_from from deedbox.firm_setting
        where id = $1 and definition = $2 and effective_from > now()`,
      [input.settingRow, d.id],
    )
    if (row.rowCount === 0) {
      throw new OperationRefused('not_scheduled', 'that value is not scheduled — only future values can be cancelled')
    }
    const prior = await tx.query(
      `select coalesce(
         (select fs.value from deedbox.firm_setting fs
           where fs.definition = $1 and fs.effective_from < $2::timestamptz
           order by fs.effective_from desc limit 1),
         $3::jsonb) as v`,
      [d.id, row.rows[0].effective_from, JSON.stringify(d.neutral_default)],
    )
    const ins = await tx.query(
      `insert into deedbox.firm_setting (definition, value, effective_from)
       values ($1, $2, $3::timestamptz + interval '1 second') returning id`,
      [d.id, prior.rows[0].v, row.rows[0].effective_from],
    )
    await emitRegister(tx, p, {
      kind: 'setting.changed',
      subjectType: 'setting_definition',
      subject: d.id,
      privileged: true,
      detail: {
        key: d.key,
        cancelled_scheduled_row: input.settingRow,
        before: { value: row.rows[0].value },
        after: { value: prior.rows[0].v },
      },
    })
    return { setting: ins.rows[0].id as number }
  })
}
