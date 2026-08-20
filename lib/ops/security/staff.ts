// Staff administration and MFA credentials. The schema's staff guard
// already holds the last-active-administrator person guard and ends the
// person's sessions inside the deactivating transaction (0003); the
// restriction last-guardian constraint triggers (0004) stand behind role
// changes and deactivations. This layer adds the role-change
// last-administrator check the guard does not cover, the privileged
// register entries, and the MFA enrolment discipline whose mirror the
// schema maintains.

import type { Principal } from '@/lib/db'
import { withPrincipal, emitRegister, OperationRefused } from '@/lib/db'
import { requireStaff, requireCapability, hasCapability } from '@/lib/ops/shared'

export interface CreateStaffInput {
  personName: { given?: string; family?: string; display?: string }
  login: string
  role: number
  office: number
  email: string
  identityProviderSubject?: string
}

/** Create staff. */
export async function createStaffMember(
  p: Principal,
  input: CreateStaffInput,
): Promise<{ id: number }> {
  if (!input.login.trim()) throw new OperationRefused('login_required', 'a staff member needs a login')
  return withPrincipal(p, async (tx) => {
    await requireCapability(tx, p, 'roles.manage')
    const role = await tx.query(`select active from deedbox.role where id = $1`, [input.role])
    if (role.rowCount === 0 || !role.rows[0].active) {
      throw new OperationRefused('role_inactive', 'staff are created onto an active role')
    }
    const dup = await tx.query(
      `select 1 from deedbox.staff_member where lower(login) = lower($1)`,
      [input.login],
    )
    if (dup.rowCount! > 0) throw new OperationRefused('login_taken', 'that login is already in use')
    const r = await tx.query(
      `insert into deedbox.staff_member (person_name, login, role, office, email, identity_provider_subject)
       values ($1, $2, $3, $4, $5, $6) returning id`,
      [
        JSON.stringify(input.personName),
        input.login.trim(),
        input.role,
        input.office,
        input.email,
        input.identityProviderSubject ?? null,
      ],
    )
    await emitRegister(tx, p, {
      kind: 'record.created',
      subjectType: 'staff_member',
      subject: r.rows[0].id as number,
      detail: { login: input.login.trim(), role: input.role, office: input.office },
    })
    return { id: r.rows[0].id as number }
  })
}

/**
 * Change role. The restriction last-guardian constraint triggers
 * (0004) refuse a change that would strand a restricted matter; this
 * operation adds the last-administrator check for role changes (the
 * schema's person guard covers deactivation only) and registers
 * permission.changed with before/after.
 */
export async function changeStaffRole(
  p: Principal,
  input: { staff: number; role: number },
): Promise<void> {
  await withPrincipal(p, async (tx) => {
    await requireCapability(tx, p, 'roles.manage')
    const cur = await tx.query(
      `select s.id, s.role, s.active from deedbox.staff_member s where s.id = $1 for update`,
      [input.staff],
    )
    if (cur.rowCount === 0) throw new OperationRefused('not_found', 'staff member not found')
    if (cur.rows[0].role === input.role) return
    const target = await tx.query(`select active from deedbox.role where id = $1`, [input.role])
    if (target.rowCount === 0 || !target.rows[0].active) {
      throw new OperationRefused('role_inactive', 'the target role must be active')
    }
    // last-administrator check for the ROLE-CHANGE path
    const losingAdmin = await tx.query(
      `select
         exists (select 1 from deedbox.role_capability rc
                  where rc.role = $1 and rc.capability = 'security.administer' and rc.scope <> 'none') as had,
         exists (select 1 from deedbox.role_capability rc
                  where rc.role = $2 and rc.capability = 'security.administer' and rc.scope <> 'none') as keeps`,
      [cur.rows[0].role, input.role],
    )
    if (losingAdmin.rows[0].had && !losingAdmin.rows[0].keeps) {
      const others = await tx.query(
        `select 1 from deedbox.staff_member s
           join deedbox.role_capability rc on rc.role = s.role
          where rc.capability = 'security.administer' and rc.scope <> 'none'
            and s.active and s.id <> $1 limit 1`,
        [input.staff],
      )
      if (others.rowCount === 0) {
        throw new OperationRefused(
          'last_administrator',
          'this change would leave the firm without an active administrator',
        )
      }
    }
    await tx.query(`update deedbox.staff_member set role = $2 where id = $1`, [
      input.staff,
      input.role,
    ])
    await emitRegister(tx, p, {
      kind: 'permission.changed',
      subjectType: 'staff_member',
      subject: input.staff,
      privileged: true,
      detail: { before: { role: cur.rows[0].role }, after: { role: input.role } },
    })
  })
}

/** Deactivate: the schema guard ends sessions and holds the person guards. */
export async function deactivateStaff(
  p: Principal,
  input: { staff: number },
): Promise<void> {
  await withPrincipal(p, async (tx) => {
    requireStaff(p)
    if (
      !(await hasCapability(tx, p.id, 'security.administer')) &&
      !(await hasCapability(tx, p.id, 'roles.manage'))
    ) {
      throw new OperationRefused(
        'capability_missing',
        'deactivation requires security.administer or roles.manage',
      )
    }
    const cur = await tx.query(
      `select active, login from deedbox.staff_member where id = $1 for update`,
      [input.staff],
    )
    if (cur.rowCount === 0) throw new OperationRefused('not_found', 'staff member not found')
    if (!cur.rows[0].active) throw new OperationRefused('already_inactive', 'already deactivated')
    await tx.query(
      `update deedbox.staff_member set active = false, deactivated_by = $2 where id = $1`,
      [input.staff, p.id],
    )
    // the schema's staff guard ended the person's sessions in this very
    // transaction; frozen now() identifies exactly those
    const ended = await tx.query(
      `select count(*)::int as n from deedbox.session
        where principal_kind = 'staff' and principal = $1
          and end_reason = 'deactivation' and ended_at = now()`,
      [input.staff],
    )
    await emitRegister(tx, p, {
      kind: 'staff.deactivated',
      subjectType: 'staff_member',
      subject: input.staff,
      privileged: true,
      detail: {
        before: { active: true },
        after: { active: false, sessions_ended: ended.rows[0].n },
      },
    })
  })
}

/** Reactivate. */
export async function reactivateStaff(
  p: Principal,
  input: { staff: number },
): Promise<void> {
  await withPrincipal(p, async (tx) => {
    await requireCapability(tx, p, 'security.administer')
    const cur = await tx.query(
      `select active from deedbox.staff_member where id = $1 for update`,
      [input.staff],
    )
    if (cur.rowCount === 0) throw new OperationRefused('not_found', 'staff member not found')
    if (cur.rows[0].active) throw new OperationRefused('already_active', 'already active')
    await tx.query(`update deedbox.staff_member set active = true where id = $1`, [input.staff])
    await emitRegister(tx, p, {
      kind: 'staff.reactivated',
      subjectType: 'staff_member',
      subject: input.staff,
      privileged: true,
      detail: { before: { active: false }, after: { active: true } },
    })
  })
}

/** Enrol an MFA credential (the schema mirrors mfa_enrolled). */
export async function enrolMfaCredential(
  p: Principal,
  input: { factorKind: 'totp' | 'security_key' | 'recovery_code_set'; label?: string; secretRef: string },
): Promise<{ id: number }> {
  requireStaff(p)
  return withPrincipal(p, async (tx) => {
    const r = await tx.query(
      `insert into deedbox.mfa_credential (staff, factor_kind, label, secret_ref)
       values ($1, $2, $3, $4) returning id`,
      [p.id, input.factorKind, input.label ?? null, input.secretRef],
    )
    await emitRegister(tx, p, {
      kind: 'mfa.enrolled',
      subjectType: 'mfa_credential',
      subject: r.rows[0].id as number,
      detail: { factor_kind: input.factorKind },
    })
    return { id: r.rows[0].id as number }
  })
}

/**
 * Remove (revoke) a credential: the owner with a fresh step-up, or
 * an administrator. Removing the last credential while policy requires MFA
 * forces enrolment at next sign-in — never a retroactive lockout.
 */
export async function removeMfaCredential(
  p: Principal,
  input: { credential: number; stepUpFresh?: boolean },
): Promise<void> {
  requireStaff(p)
  await withPrincipal(p, async (tx) => {
    const cur = await tx.query(
      `select staff, revoked_at from deedbox.mfa_credential where id = $1 for update`,
      [input.credential],
    )
    if (cur.rowCount === 0) throw new OperationRefused('not_found', 'credential not found')
    if (cur.rows[0].revoked_at !== null) {
      throw new OperationRefused('already_revoked', 'this credential is already revoked')
    }
    const own = cur.rows[0].staff === p.id
    if (own) {
      if (!input.stepUpFresh) {
        throw new OperationRefused('step_up_required', 'removing your own factor requires a fresh step-up')
      }
    } else if (!(await hasCapability(tx, p.id, 'security.administer'))) {
      throw new OperationRefused('capability_missing', "removing another person's factor requires security.administer")
    }
    await tx.query(
      `update deedbox.mfa_credential set revoked_at = now(), revoked_by = $2 where id = $1`,
      [input.credential, p.id],
    )
    await emitRegister(tx, p, {
      kind: 'mfa.removed',
      subjectType: 'mfa_credential',
      subject: input.credential,
      detail: { staff: cur.rows[0].staff },
    })
  })
}
