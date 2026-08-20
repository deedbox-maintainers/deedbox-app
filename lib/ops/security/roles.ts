// Role and capability administration. The schema's safe-bounds triggers
// (0003) stand behind every write: external roles can never hold internal
// capabilities, the administrator floor is absolute, the last active holder
// of security.administer can never lose it, shipped roles never deactivate,
// and money-authorisation capabilities move only under the explicit-grant
// ceremony flag — which this module requests only when the caller has taken
// the distinct confirmation step the grant screen presents. Every change
// registers with the role's FULL capability set before and after, not just
// the delta.

import type { Principal, Tx } from '@/lib/db'
import { withPrincipal, emitRegister, OperationRefused } from '@/lib/db'
import type { CeremonyFlag } from '@/lib/db'
import { requireStaff, requireCapability } from '@/lib/ops/shared'

async function capabilitySet(tx: Tx, role: number): Promise<Record<string, string>> {
  const r = await tx.query(
    `select capability, scope from deedbox.role_capability where role = $1 order by capability`,
    [role],
  )
  const out: Record<string, string> = {}
  for (const row of r.rows) out[row.capability as string] = row.scope as string
  return out
}

function mapGuardRefusal(err: unknown): never {
  const msg = err instanceof Error ? err.message : String(err)
  for (const bound of [
    'external roles can never receive',
    'money-authorisation capabilities are granted only',
    'may never lose',
    'last active holder of security.administer',
    'last active role holding security.administer',
    'roles are deactivated',
    'shipped roles cannot be deactivated',
    'role with active staff cannot be deactivated',
    'system_key is immutable',
  ]) {
    if (msg.includes(bound)) throw new OperationRefused('safe_bounds', msg)
  }
  throw err as Error
}

export async function createRole(
  p: Principal,
  input: { name: string; external?: boolean },
): Promise<{ role: number }> {
  requireStaff(p)
  return withPrincipal(p, async (tx) => {
    await requireCapability(tx, p, 'roles.manage')
    const dup = await tx.query(`select 1 from deedbox.role where name = $1 and active`, [input.name])
    if ((dup.rowCount ?? 0) > 0) throw new OperationRefused('duplicate_name', 'an active role already uses that name')
    const ins = await tx.query(
      `insert into deedbox.role (name, external) values ($1, coalesce($2, false)) returning id`,
      [input.name, input.external ?? null],
    )
    await emitRegister(tx, p, {
      kind: 'role.changed',
      subjectType: 'role',
      subject: ins.rows[0].id,
      detail: { before: null, after: { name: input.name, external: input.external ?? false, active: true } },
    })
    return { role: ins.rows[0].id as number }
  })
}

export async function renameRole(p: Principal, input: { role: number; name: string }): Promise<void> {
  requireStaff(p)
  await withPrincipal(p, async (tx) => {
    await requireCapability(tx, p, 'roles.manage')
    const before = await tx.query(`select name from deedbox.role where id = $1`, [input.role])
    if (before.rowCount === 0) throw new OperationRefused('not_found', 'no such role')
    try {
      await tx.query(`update deedbox.role set name = $2 where id = $1`, [input.role, input.name])
    } catch (err) {
      mapGuardRefusal(err)
    }
    await emitRegister(tx, p, {
      kind: 'role.changed',
      subjectType: 'role',
      subject: input.role,
      detail: { before: { name: before.rows[0].name }, after: { name: input.name } },
    })
  })
}

export async function setRoleActive(
  p: Principal,
  input: { role: number; active: boolean },
): Promise<void> {
  requireStaff(p)
  await withPrincipal(p, async (tx) => {
    await requireCapability(tx, p, 'roles.manage')
    const before = await tx.query(`select name, active from deedbox.role where id = $1`, [input.role])
    if (before.rowCount === 0) throw new OperationRefused('not_found', 'no such role')
    if (before.rows[0].active === input.active) return // idempotent
    try {
      await tx.query(`update deedbox.role set active = $2 where id = $1`, [input.role, input.active])
    } catch (err) {
      mapGuardRefusal(err)
    }
    await emitRegister(tx, p, {
      kind: 'role.changed',
      subjectType: 'role',
      subject: input.role,
      detail: { before: { active: before.rows[0].active }, after: { active: input.active } },
    })
  })
}

export interface SetRoleCapabilityInput {
  role: number
  capability: string
  /** 'none' removes the grant row. */
  scope: 'firm_wide' | 'own_figures_only' | 'none'
  /**
   * The grant screen's distinct confirmation step for money-authorisation
   * capabilities. Granting one without it refuses before anything is
   * attempted; the register entry records that the step was taken.
   */
  confirmMoneyAuthorisation?: boolean
}

export async function setRoleCapability(p: Principal, input: SetRoleCapabilityInput): Promise<void> {
  requireStaff(p)
  const cap = await withPrincipal(
    p,
    async (tx) => {
      const c = await tx.query(
        `select key, money_authorisation, grantable_to_firm_roles from deedbox.capability where key = $1`,
        [input.capability],
      )
      if (c.rowCount === 0) throw new OperationRefused('unknown_capability', `no capability named ${input.capability}`)
      return c.rows[0]
    },
    { readOnly: true },
  )
  const granting = input.scope !== 'none'
  const needsCeremony = cap.money_authorisation === true && granting
  if (needsCeremony && input.confirmMoneyAuthorisation !== true) {
    throw new OperationRefused(
      'confirmation_required',
      `${input.capability} authorises client money — the grant needs its distinct confirmation step`,
    )
  }
  const ceremonies: CeremonyFlag[] = needsCeremony ? ['explicit_money_grant'] : []
  await withPrincipal(
    p,
    async (tx) => {
      await requireCapability(tx, p, 'roles.manage')
      const role = await tx.query(`select id, name from deedbox.role where id = $1`, [input.role])
      if (role.rowCount === 0) throw new OperationRefused('not_found', 'no such role')
      const before = await capabilitySet(tx, input.role)
      try {
        if (input.scope === 'none') {
          await tx.query(`delete from deedbox.role_capability where role = $1 and capability = $2`, [
            input.role,
            input.capability,
          ])
        } else {
          await tx.query(
            `insert into deedbox.role_capability (role, capability, scope) values ($1, $2, $3)
             on conflict (role, capability) do update set scope = excluded.scope`,
            [input.role, input.capability, input.scope],
          )
        }
      } catch (err) {
        mapGuardRefusal(err)
      }
      const after = await capabilitySet(tx, input.role)
      await emitRegister(tx, p, {
        kind: 'permission.changed',
        subjectType: 'role',
        subject: input.role,
        detail: {
          role_name: role.rows[0].name,
          changed_capability: input.capability,
          scope: input.scope,
          money_authorisation_confirmed: needsCeremony ? true : undefined,
          before: { capabilities: before },
          after: { capabilities: after },
        },
      })
    },
    { ceremonies },
  )
}
