// The auth_policy table behind the security policy screen — the one
// per-firm authentication policy row. Absent, the shipped defaults govern
// (mfa off, step-up on unrecognised sources ON, email fallback ON); saving
// materialises the row. auth_policy.changed is privileged, so the entry
// always carries the full policy before and after.

import type { Principal } from '@/lib/db'
import { withPrincipal, emitRegister, OperationRefused } from '@/lib/db'
import { requireStaff, requireCapability } from '@/lib/ops/shared'

export interface AuthPolicyInput {
  mfaScope: 'off' | 'named_roles' | 'all_users'
  mfaRoles?: number[]
  stepUpOnUnrecognised: boolean
  stepUpEmailFallback: boolean
}

const SHIPPED_DEFAULTS = {
  mfa_scope: 'off',
  mfa_roles: null as number[] | null,
  step_up_on_unrecognised: true,
  step_up_email_fallback: true,
}

export async function saveAuthPolicy(p: Principal, input: AuthPolicyInput): Promise<void> {
  requireStaff(p)
  await withPrincipal(p, async (tx) => {
    await requireCapability(tx, p, 'security.administer')
    if (input.mfaScope === 'named_roles') {
      if (!input.mfaRoles || input.mfaRoles.length === 0) {
        throw new OperationRefused('invalid_policy', 'named_roles needs at least one role named')
      }
      const found = await tx.query(`select count(*)::int as n from deedbox.role where id = any($1) and active`, [
        input.mfaRoles,
      ])
      if (found.rows[0].n !== input.mfaRoles.length) {
        throw new OperationRefused('invalid_policy', 'every named role must be an active role')
      }
    }
    const existing = await tx.query(
      `select mfa_scope, mfa_roles, step_up_on_unrecognised, step_up_email_fallback
         from deedbox.auth_policy where firm = $1`,
      [p.firm],
    )
    const before =
      existing.rowCount === 0
        ? SHIPPED_DEFAULTS
        : {
            mfa_scope: existing.rows[0].mfa_scope,
            mfa_roles: existing.rows[0].mfa_roles,
            step_up_on_unrecognised: existing.rows[0].step_up_on_unrecognised,
            step_up_email_fallback: existing.rows[0].step_up_email_fallback,
          }
    const after = {
      mfa_scope: input.mfaScope,
      mfa_roles: input.mfaScope === 'named_roles' ? input.mfaRoles! : null,
      step_up_on_unrecognised: input.stepUpOnUnrecognised,
      step_up_email_fallback: input.stepUpEmailFallback,
    }
    const rolesJson = after.mfa_roles === null ? null : JSON.stringify(after.mfa_roles)
    if (existing.rowCount === 0) {
      await tx.query(
        `insert into deedbox.auth_policy
           (firm, mfa_scope, mfa_roles, step_up_on_unrecognised, step_up_email_fallback)
         values ($1,$2,$3::jsonb,$4,$5)`,
        [p.firm, after.mfa_scope, rolesJson, after.step_up_on_unrecognised, after.step_up_email_fallback],
      )
    } else {
      await tx.query(
        `update deedbox.auth_policy
            set mfa_scope = $2, mfa_roles = $3::jsonb,
                step_up_on_unrecognised = $4, step_up_email_fallback = $5
          where firm = $1`,
        [p.firm, after.mfa_scope, rolesJson, after.step_up_on_unrecognised, after.step_up_email_fallback],
      )
    }
    await emitRegister(tx, p, {
      kind: 'auth_policy.changed',
      subjectType: 'auth_policy',
      subject: p.firm,
      detail: { before, after },
    })
  })
}
